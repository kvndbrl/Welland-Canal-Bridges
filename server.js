const express = require('express');
const webpush = require('web-push');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// ── Config ────────────────────────────────────────────────────────────
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const UPSTASH_URL   = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const PORT          = process.env.PORT || 10000;

webpush.setVapidDetails('mailto:admin@wellandcanalbridges.app', VAPID_PUBLIC, VAPID_PRIVATE);

// ── Bridges config ────────────────────────────────────────────────────
// BridgeSCT page: 5 bridges in St. Catharines + Allanburg + Welland
// BridgePC page:  3 bridges in Port Colborne (Clarence + 2 Jack-knife)
const BRIDGE_IDS = ['lakeshore','carlton','queenston','glendale','allanburg','mainwelland','mellanby','clarence'];

const BRIDGE_NAMES = {
  lakeshore:  'Lakeshore Rd (Bridge 1)',
  carlton:    'Carlton St. (Bridge 3A)',
  queenston:  'Queenston St. (Bridge 4)',
  glendale:   'Glendale Ave. (Bridge 5)',
  allanburg:  'Route 20 (Bridge 11)',
  mainwelland:'Main St. (Bridge 19)',
  mellanby:   'Mellanby Ave. (Bridge 19A)',
  clarence:   'Clarence St. (Bridge 21)',
};

// Keywords to find each bridge section in the HTML
const BRIDGE_KEYWORDS = {
  lakeshore:  'lakeshore rd',
  carlton:    'carlton st.',
  queenston:  'queenston st.',
  glendale:   'glendale ave.',
  allanburg:  'highway 20',
  mainwelland:'main st.',
  mellanby:   'mellanby ave.',
  clarence:   'clarence st.',
};

// SCT page bridges vs PC page bridges
const SCT_BRIDGES = ['lakeshore','carlton','queenston','glendale','allanburg'];
const PC_BRIDGES  = ['mainwelland','mellanby','clarence'];

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

// ── State ─────────────────────────────────────────────────────────────
let lastStatus  = Object.fromEntries(BRIDGE_IDS.map(id => [id, 'disponible']));
let lastData    = Object.fromEntries(BRIDGE_IDS.map(id => [id, { status:'disponible', next_lifts:'No anticipated bridge lifts' }]));
let liftHistory = Object.fromEntries(BRIDGE_IDS.map(id => [id, []]));
let liftActive  = Object.fromEntries(BRIDGE_IDS.map(id => [id, false]));
let subscriptions = [];
let disponibleSince = Object.fromEntries(BRIDGE_IDS.map(id => [id, null]));
let lastScheduledNotif = Object.fromEntries(BRIDGE_IDS.map(id => [id, 0]));
const DISPONIBLE_MIN_MS = 90 * 1000;
const SCHEDULED_COOLDOWN_MS = 20 * 60 * 1000;

// ── Redis helpers ─────────────────────────────────────────────────────
async function redisCmd(...args) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return null;
  try {
    const res = await fetch(`${UPSTASH_URL}/${args.map(encodeURIComponent).join('/')}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
    });
    const json = await res.json();
    return json.result;
  } catch (e) {
    log('Redis error:', e.message);
    return null;
  }
}

async function loadSubs() {
  const raw = await redisCmd('GET', 'wcb:subscriptions');
  if (raw) {
    try { subscriptions = JSON.parse(raw); log(`Loaded ${subscriptions.length} subscribers`); }
    catch(e) { subscriptions = []; }
  }
}

async function saveSubs() {
  await redisCmd('SET', 'wcb:subscriptions', JSON.stringify(subscriptions));
}

async function loadHistory() {
  for (const id of BRIDGE_IDS) {
    const raw = await redisCmd('GET', `wcb:history:${id}`);
    if (raw) {
      try { liftHistory[id] = JSON.parse(raw); }
      catch(e) {}
    }
  }
}

async function saveHistory(bridge) {
  const trimmed = liftHistory[bridge].slice(-100);
  liftHistory[bridge] = trimmed;
  await redisCmd('SET', `wcb:history:${bridge}`, JSON.stringify(trimmed));
}

// ── Scraper ───────────────────────────────────────────────────────────
async function fetchPage(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  return res.text();
}

function extractSection(html, keyword) {
  const idx = html.toLowerCase().indexOf(keyword.toLowerCase());
  if (idx === -1) return '';
  return html.slice(idx, idx + 3000);
}

function extractStatus(section) {
  const titleRegex = /<h1[^>]*status-title[^>]*>\s*<b>([^<]+)<\/b>/gi;
  const titles = [...section.matchAll(titleRegex)].map(m => m[1].trim().toLowerCase());
  const combined = titles.join(' ');

  if (combined.includes('lowering')) return { status: 'lowering', raisedSince: null };
  if (combined.includes('raising soon')) return { status: 'bientot_leve', raisedSince: null };
  if (combined.includes('raising')) return { status: 'raising', raisedSince: null };
  const raisedMatch = combined.match(/raised since\s+(\d{1,2}:\d{2})/i);
  if (raisedMatch) return { status: 'leve', raisedSince: raisedMatch[1] };
  if (combined.includes('unavailable')) return { status: 'leve', raisedSince: null };
  return { status: null, raisedSince: null };
}

function extractColor(html, keyword) {
  const idx = html.toLowerCase().indexOf(keyword.toLowerCase());
  if (idx === -1) return null;
  const chunk = html.slice(Math.max(0, idx - 500), idx + 500);
  const match = chunk.match(/background-color:\s*(#[A-Fa-f0-9]{6})/i);
  return match ? match[1].toUpperCase() : null;
}

function colorToStatus(color) {
  if (!color) return 'disponible';
  const c = color.toUpperCase();
  if (c === '#E48082') return 'leve';
  if (c === '#FEEAA8') return 'bientot_leve';
  return 'disponible';
}

function extractLifts(section) {
  const matches = [...section.matchAll(/class="item-data[^"]*"[^>]*>([^<]+)/g)];
  const lifts = matches.map(m => m[1].trim()).filter(v => v && v !== 'No anticipated bridge lifts');
  if (lifts.length === 0) return 'No anticipated bridge lifts';
  return lifts.join('\n');
}

function extractClosures(section) {
  const results = [];
  const matches1 = [...section.matchAll(/class="item-data[^"]*"[^>]*style="[^"]*white-space\s*:\s*pre[^"]*"[^>]*>([^<]+)/gi)];
  const matches2 = [...section.matchAll(/style="[^"]*white-space\s*:\s*pre[^"]*"[^>]*class="item-data[^"]*"[^>]*>([^<]+)/gi)];
  for (const m of [...matches1, ...matches2]) {
    const val = m[1].trim();
    if (val && !results.includes(val)) results.push(val);
  }
  return results.length > 0 ? results : null;
}

function isCurrentlyInOutage(closures) {
  if (!closures || !closures.length) return null;
  const now = new Date();
  for (const c of closures) {
    const m = c.match(/(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})\s+until\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})/i);
    if (!m) continue;
    const etOffset = '-04:00';
    const start = new Date(m[1].replace(' ', 'T') + ':00' + etOffset);
    const end   = new Date(m[2].replace(' ', 'T') + ':00' + etOffset);
    if (!isNaN(start) && !isNaN(end) && now >= start && now <= end) return { closure: c, end };
  }
  return null;
}

async function fetchBridgeStatus() {
  const [sctHtml, pcHtml] = await Promise.all([
    fetchPage('https://www.seaway-greatlakes.com/bridgestatus/detailsnai?key=BridgeSCT'),
    fetchPage('https://www.seaway-greatlakes.com/bridgestatus/detailsnai?key=BridgePC'),
  ]);

  // Extract all text nodes from HTML
  function extractTextPairs(html) {
    const texts = [...html.matchAll(/>([^<]{2,})</g)]
      .map(m => m[1].trim())
      .filter(t => t && !t.startsWith('var ') && !t.startsWith('function ') && !t.includes('{'));
    return texts;
  }

  function parseStatusFromText(text) {
    const t = text.toLowerCase();
    if (t.includes('raising soon') || t.includes('levée sous peu')) return { status: 'bientot_leve', raisedSince: null };
    if (t.includes('raising') && !t.includes('raising soon')) return { status: 'raising', raisedSince: null };
    if (t.includes('lowering')) return { status: 'lowering', raisedSince: null };
    const raisedMatch = text.match(/raised since\s+(\d{1,2}:\d{2})/i);
    if (raisedMatch) return { status: 'leve', raisedSince: raisedMatch[1] };
    if (t.includes('unavailable')) return { status: 'leve', raisedSince: null };
    if (t.includes('available')) return { status: 'disponible', raisedSince: null };
    return null;
  }

  function extractLiftsFromHtml(html, bridgeKeyword) {
    const idx = html.toLowerCase().indexOf(bridgeKeyword.toLowerCase());
    if (idx === -1) return 'No anticipated bridge lifts';
    const section = html.slice(idx, idx + 2000);
    const matches = [...section.matchAll(/class="item-data[^"]*"[^>]*>([^<]+)/g)];
    const lifts = matches.map(m => m[1].trim()).filter(v => v && v !== 'No anticipated bridge lifts');
    return lifts.length ? lifts.join('\n') : 'No anticipated bridge lifts';
  }

  // Bridge keyword map for matching text nodes
  const BRIDGE_TEXT_KEYWORDS = {
    lakeshore:  'lakeshore rd',
    carlton:    'carlton st.',
    queenston:  'queenston st.',
    glendale:   'glendale ave.',
    allanburg:  'highway 20',
    mainwelland:'main st.',
    mellanby:   'mellanby ave.',
    clarence:   'clarence st.',
  };

  const pages = {
    ...Object.fromEntries(SCT_BRIDGES.map(id => [id, sctHtml])),
    ...Object.fromEntries(PC_BRIDGES.map(id => [id, pcHtml])),
  };

  const result = {};

  for (const id of BRIDGE_IDS) {
    const html = pages[id];
    const kw = BRIDGE_TEXT_KEYWORDS[id];
    const texts = extractTextPairs(html);

    // Find the bridge name in texts, then look at next text for status
    let status = 'disponible';
    let raisedSince = null;

    for (let i = 0; i < texts.length; i++) {
      if (texts[i].toLowerCase().includes(kw)) {
        // Next non-empty text should be the status
        for (let j = i + 1; j < Math.min(i + 5, texts.length); j++) {
          const parsed = parseStatusFromText(texts[j]);
          if (parsed) {
            status = parsed.status;
            raisedSince = parsed.raisedSince;
            break;
          }
        }
        break;
      }
    }

    result[id] = {
      status,
      raisedSince,
      next_lifts: extractLiftsFromHtml(html, kw),
      closures: null,
      outageEnd: null,
    };
  }

  return result;
}

// ── Notification helpers ──────────────────────────────────────────────
function notifIcon(sub) {
  return sub.icon || '/icon-192.png';
}

function statusBadge(status) {
  return '/badge-' + (status || 'disponible') + '.png';
}

function getMessages(bridge, status, data) {
  const n = BRIDGE_NAMES[bridge] || bridge;
  const raisedAt = data?.raisedSince;
  const liftTime = (() => {
    if (!raisedAt) return '';
    const now = new Date();
    const [h, m] = raisedAt.split(':').map(Number);
    const est = new Date(now);
    est.setHours(h, m + 12, 0, 0);
    if (est < now) est.setDate(est.getDate() + 1);
    return est.toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit', hour12: false });
  })();

  const msgs = {
    bientot_leve: { title: `⚠️ ${n}`, body: `Lift soon · Expect delays` },
    raising:      { title: `🔼 ${n}`, body: `Bridge raising · Reopen ~${liftTime}` },
    leve:         { title: `🚢 ${n}`, body: `Bridge lifted · Expected reopen ~${liftTime}` },
    lowering:     { title: `🔽 ${n}`, body: `Bridge lowering · Opening soon` },
    disponible:   { title: `✅ ${n}`, body: `Traffic normal` },
    outage:       { title: `🚧 ${n}`, body: `Planned closure` },
  };
  return msgs[status] || msgs.disponible;
}

// ── Send notifications ────────────────────────────────────────────────
async function sendNotifications(bridge, status, bridgeData = {}) {
  if (status === 'disponible') {
    if (!disponibleSince[bridge]) {
      disponibleSince[bridge] = Date.now();
      setTimeout(() => {
        if (lastStatus[bridge] === 'disponible') sendNotifications(bridge, 'disponible', bridgeData);
        disponibleSince[bridge] = null;
      }, DISPONIBLE_MIN_MS);
      return;
    }
  } else {
    disponibleSince[bridge] = null;
  }

  const msg = getMessages(bridge, status, bridgeData);
  let sent = 0, failed = 0, skippedBridge = 0;

  for (const sub of [...subscriptions]) {
    const bridges = sub.bridges || BRIDGE_IDS;
    if (!bridges.includes(bridge)) { skippedBridge++; continue; }

    const bridgeKey = `notifTypes_${bridge}`;
    const allowedTypes = sub[bridgeKey] || sub.notifTypes || ['bientot_leve','leve','outage','scheduled'];
    const isClosing = status === 'disponible';
    if (!isClosing && !allowedTypes.includes(status)) continue;

    const payload = JSON.stringify({
      ...msg, bridge, status,
      tag: `wcb-${bridge}`,
      persistent: !isClosing,
      icon: notifIcon(sub),
      badge: statusBadge(status),
    });

    try {
      await webpush.sendNotification(sub, payload);
      sent++;
    } catch (e) {
      if (e.statusCode === 410 || e.statusCode === 404) {
        subscriptions = subscriptions.filter(s => s.endpoint !== sub.endpoint);
        await saveSubs();
      }
      failed++;
    }
  }
  log(`🔔 Notification [${bridge}] ${status} — ✅ ${sent} sent | 🚫 ${skippedBridge} bridge skip | ❌ ${failed} failed`);
}

async function sendScheduledLiftNotification(bridge, liftTime) {
  const now = Date.now();
  if (now - lastScheduledNotif[bridge] < SCHEDULED_COOLDOWN_MS) return;
  lastScheduledNotif[bridge] = now;

  const n = BRIDGE_NAMES[bridge] || bridge;
  const msg = { title: `📅 ${n}`, body: `Scheduled lift · ${liftTime}` };
  let sent = 0;

  for (const sub of [...subscriptions]) {
    const bridges = sub.bridges || BRIDGE_IDS;
    if (!bridges.includes(bridge)) continue;
    const bridgeKey = `notifTypes_${bridge}`;
    const allowedTypes = sub[bridgeKey] || sub.notifTypes || ['bientot_leve','leve','outage','scheduled'];
    if (!allowedTypes.includes('scheduled')) continue;

    const payload = JSON.stringify({
      ...msg, bridge, status: 'scheduled',
      tag: `wcb-${bridge}`,
      persistent: false,
      icon: notifIcon(sub),
      badge: statusBadge('scheduled'),
    });

    try {
      await webpush.sendNotification(sub, payload);
      sent++;
    } catch(e) {
      if (e.statusCode === 410 || e.statusCode === 404) {
        subscriptions = subscriptions.filter(s => s.endpoint !== sub.endpoint);
        await saveSubs();
      }
    }
  }
  log(`🔔 Scheduled notif [${bridge}] — ✅ ${sent} sent`);
}

// ── Monitor ───────────────────────────────────────────────────────────
async function monitor() {
  try {
    const data = await fetchBridgeStatus();
    const statusLine = BRIDGE_IDS.map(id => `${id}: ${data[id].status}`).join(' | ');
    log(`🌉 ${statusLine} | Subs: ${subscriptions.length}`);

    let anyChange = false;
    for (const bridge of BRIDGE_IDS) {
      const prev = lastStatus[bridge];
      const curr = data[bridge].status;
      lastData[bridge] = data[bridge];

      if (prev !== curr) {
        anyChange = true;
        log(`🔄 Change [${bridge}]: ${prev} → ${curr}`);

        // Track lift history
        if (['raising','bientot_leve'].includes(curr) && !liftActive[bridge]) {
          liftActive[bridge] = true;
          liftHistory[bridge].push({ raisedAt: new Date().toISOString(), bridge });
        }
        if (curr === 'disponible' && liftActive[bridge]) {
          liftActive[bridge] = false;
          const last = liftHistory[bridge][liftHistory[bridge].length - 1];
          if (last) {
            last.loweredAt = new Date().toISOString();
            last.durationMin = Math.round((Date.now() - new Date(last.raisedAt)) / 60000);
          }
          await saveHistory(bridge);
        }

        lastStatus[bridge] = curr;
        await sendNotifications(bridge, curr, data[bridge]);
      }

      // Scheduled lift check
      const lifts = data[bridge].next_lifts;
      if (lifts && lifts !== 'No anticipated bridge lifts') {
        const firstLift = lifts.split('\n')[0];
        const timeMatch = firstLift.match(/(\d{1,2}:\d{2})/);
        if (timeMatch) {
          const now = new Date();
          const [h, m] = timeMatch[1].split(':').map(Number);
          const liftDate = new Date(now);
          liftDate.setHours(h, m, 0, 0);
          if (liftDate < now) liftDate.setDate(liftDate.getDate() + 1);
          const minsUntil = (liftDate - now) / 60000;
          if (minsUntil <= 60 && minsUntil > 0 && curr === 'disponible') {
            await sendScheduledLiftNotification(bridge, timeMatch[1]);
          }
        }
      }
    }

    if (!anyChange) log('💤 No changes');
  } catch (e) {
    log('❌ Monitor error:', e.message);
  }
}

// ── Routes ────────────────────────────────────────────────────────────
app.get('/debug', async (req, res) => {
  try {
    const [sctHtml, pcHtml] = await Promise.all([
      fetchPage('https://www.seaway-greatlakes.com/bridgestatus/detailsnai?key=BridgeSCT'),
      fetchPage('https://www.seaway-greatlakes.com/bridgestatus/detailsnai?key=BridgePC'),
    ]);
    function extractTexts(html) {
      return [...html.matchAll(/>([^<]{2,})</g)]
        .map(m => m[1].trim())
        .filter(t => t && !t.startsWith('var ') && !t.startsWith('function ') && !t.includes('{'));
    }
    res.json({ sct: extractTexts(sctHtml).slice(0,30), pc: extractTexts(pcHtml).slice(0,30) });
  } catch(e) {
    res.json({ error: e.message });
  }
});

app.get('/ping', (req, res) => res.json({ ok: true, subs: subscriptions.length }));

app.get('/status', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ bridges: lastData, last_updated: new Date().toISOString() });
});

app.get('/assistant', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const parts = BRIDGE_IDS.map(id => {
    const s = lastStatus[id];
    const n = BRIDGE_NAMES[id];
    const desc = s === 'disponible' ? 'is available'
      : s === 'bientot_leve' ? 'will be lifted soon'
      : s === 'raising' ? 'is raising'
      : s === 'leve' ? 'is lifted'
      : s === 'lowering' ? 'is lowering'
      : 'status unknown';
    return `${n} ${desc}`;
  });
  res.json({ text: parts.join('. '), statuses: lastStatus });
});

app.get('/history', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const result = {};
  for (const id of BRIDGE_IDS) {
    const h = liftHistory[id];
    const durations = h.filter(e => e.durationMin).map(e => e.durationMin);
    result[id] = {
      entries: h.length,
      avgDuration: durations.length ? Math.round(durations.reduce((a,b) => a+b, 0) / durations.length) : 0,
      lastLift: h.length ? h[h.length-1].raisedAt : null,
    };
  }
  res.json(result);
});

app.post('/subscribe', async (req, res) => {
  const sub = req.body;
  if (!sub?.endpoint) return res.status(400).json({ error: 'Invalid subscription' });
  const existing = subscriptions.find(s => s.endpoint === sub.endpoint);
  if (existing) {
    Object.assign(existing, sub);
    log(`Updated subscriber. Bridges: ${sub.bridges}`);
  } else {
    subscriptions.push(sub);
    log(`New subscriber! Bridges: ${sub.bridges}. Total: ${subscriptions.length}`);
  }
  await saveSubs();
  res.json({ ok: true });
});

app.post('/unsubscribe', async (req, res) => {
  const { endpoint } = req.body;
  subscriptions = subscriptions.filter(s => s.endpoint !== endpoint);
  await saveSubs();
  log(`Unsubscribed. Total: ${subscriptions.length}`);
  res.json({ ok: true });
});

app.get('/vapidPublicKey', (req, res) => res.json({ key: VAPID_PUBLIC }));

// ── Boot ──────────────────────────────────────────────────────────────
(async () => {
  await loadSubs();
  await loadHistory();
  app.listen(PORT, () => log(`✅ Server on port ${PORT}`));
  monitor();
  setInterval(monitor, 15000);
})();
            
