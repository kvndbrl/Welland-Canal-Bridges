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
const BRIDGE_IDS = ['lakeshore','carlton','queenston','glendale','allanburg','mainwelland','mellanby','clarence'];
const BRIDGE_NAMES = {
  lakeshore:   'Lakeshore Rd (Bridge 1)',
  carlton:     'Carlton St. (Bridge 3A)',
  queenston:   'Queenston St. (Bridge 4)',
  glendale:    'Glendale Ave. (Bridge 5)',
  allanburg:   'Highway 20 (Bridge 11)',
  mainwelland: 'Main St. (Bridge 19)',
  mellanby:    'Mellanby Ave. (Bridge 19A)',
  clarence:    'Clarence St. (Bridge 21)',
};

const SCT_BRIDGES = ['lakeshore','carlton','queenston','glendale','allanburg'];
const PC_BRIDGES  = ['mainwelland','mellanby','clarence'];

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

// ── State ─────────────────────────────────────────────────────────────
let lastStatus  = Object.fromEntries(BRIDGE_IDS.map(id => [id, 'disponible']));
let lastData    = Object.fromEntries(BRIDGE_IDS.map(id => [id, { status:'disponible', next_lifts:'No anticipated bridge lifts' }]));
let liftHistory = Object.fromEntries(BRIDGE_IDS.map(id => [id, []]));
let liftActive  = Object.fromEntries(BRIDGE_IDS.map(id => [id, false]));
let loweringActive = Object.fromEntries(BRIDGE_IDS.map(id => [id, null]));
let subscriptions = [];
let disponibleSince = Object.fromEntries(BRIDGE_IDS.map(id => [id, null]));
let monitorTimeout = null;

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
    // Restore liftActive if last entry has no loweredAt (lift was in progress)
    const last = liftHistory[id]?.[liftHistory[id].length - 1];
    if (last && last.raisedAt && !last.loweredAt) {
      liftActive[id] = true;
      log(`🔄 Restored liftActive[${id}] from history (raisedAt: ${last.raisedAt})`);
    }
  }
}

async function saveHistory(bridge) {
  const trimmed = liftHistory[bridge].slice(-100);
  liftHistory[bridge] = trimmed;
  await redisCmd('SET', `wcb:history:${bridge}`, JSON.stringify(trimmed));
}

async function loadLastStatus() {
  const raw = await redisCmd('GET', 'wcb:lastStatus');
  if (raw) {
    try {
      const saved = JSON.parse(raw);
      for (const id of BRIDGE_IDS) {
        if (saved[id]) lastStatus[id] = saved[id];
      }
      log(`Restored lastStatus from Redis: ${JSON.stringify(lastStatus)}`);
    } catch(e) {
      log('Could not parse saved lastStatus, using defaults');
    }
  }
}

async function saveLastStatus() {
  await redisCmd('SET', 'wcb:lastStatus', JSON.stringify(lastStatus));
}

// ── Scraper ───────────────────────────────────────────────────────────
async function fetchPage(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  return res.text();
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
  if (idx === -1) return null;
  const section = html.slice(idx, idx + 1500);
  const itemMatches = [...section.matchAll(/class="item-data[^"]*"[^>]*>([^<]+)/g)];
  const itemLifts = itemMatches.map(m => m[1].trim()).filter(v => v && v !== 'No anticipated bridge lifts' && v !== 'Aucune levée de pont prévue' && v !== 'No scheduled lifts');
  if (itemLifts.length) return itemLifts.join('\n');
  const arrivalMatch = section.match(/class="lgtextblack10">Next Arrival:\s*([^<]+)/i);
  if (arrivalMatch) {
    const time = arrivalMatch[1].trim().replace(/\s+/g, ' ');
    if (time && time !== '----' && time !== '-- --' && !/^-+$/.test(time.trim())) {
      return `Next ship: ${time}`;
    }
  }
  return null;
}

function extractClosuresFromHtml(html, bridgeKeyword) {
  const closureRegex = /([^\n<]{3,60})\s+Closure[.\s]*([A-Z]{3}\s+\d{1,2},\s+\d{4}\s+\d{2}:\d{2})\s*[-–]\s*([A-Z]{3}\s+\d{1,2},\s+\d{4}\s+\d{2}:\d{2})[^<]*/gi;
  const allMatches = [...html.matchAll(closureRegex)];
  const keyword = bridgeKeyword.toLowerCase();
  const filtered = allMatches.filter(m => m[1].toLowerCase().includes(keyword));

  return filtered.map(m => ({
    raw: m[0].trim(),
    start: m[2].trim(),
    end: m[3].trim(),
    startDate: new Date(m[2].trim()),
    endDate: new Date(m[3].trim()),
  })).filter(c => !isNaN(c.startDate) && c.endDate > new Date());
}

async function fetchBridgeStatus(requestedBridges = BRIDGE_IDS) {
  const needsSCT = requestedBridges.some(id => SCT_BRIDGES.includes(id));
  const needsPC  = requestedBridges.some(id => PC_BRIDGES.includes(id));

  const [sctHtml, pcHtml] = await Promise.all([
    needsSCT ? fetchPage('https://www.seaway-greatlakes.com/bridgestatus/detailsnai?key=BridgeSCT') : Promise.resolve(''),
    needsPC  ? fetchPage('https://www.seaway-greatlakes.com/bridgestatus/detailsnai?key=BridgePC')  : Promise.resolve(''),
  ]);

  function extractTextPairs(html) {
    return [...html.matchAll(/>([^<]{2,})</g)]
      .map(m => m[1].trim())
      .filter(t => t && !t.startsWith('var ') && !t.startsWith('function ') && !t.includes('{'));
  }

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

    let status = 'disponible';
    let raisedSince = null;

    for (let i = 0; i < texts.length; i++) {
      if (texts[i].toLowerCase().includes(kw)) {
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
      closures: extractClosuresFromHtml(html, kw),
      outageEnd: null,
    };
    if (result[id].closures?.length) {
      log(`🚧 [${id}] Closures: ${result[id].closures.map(c => c.start + ' → ' + c.end).join(', ')}`);
    }
  }

  return result;
}

// ── Notification helpers ──────────────────────────────────────────────
const BASE_URL = 'https://welland-canal-bridges.vercel.app';
const VALID_THEMES = ['cathariner', 'wellander', 'colbornian', 'allanburger'];

function notifIcon(sub) {
  const theme = VALID_THEMES.includes(sub.theme) ? sub.theme : 'colbornian';
  return `${BASE_URL}/notification-icon-${theme}.png`;
}

function statusBadge(status) {
  const map = {
    bientot_leve: '/badge-warning.png',
    raising:      '/badge-raising.png',
    leve:         '/badge-leve.png',
    lowering:     '/badge-lowering.png',
    disponible:   '/badge-disponible.png',
    outage:       '/badge-outage.png',
  };
  return `${BASE_URL}${map[status] || '/badge-disponible.png'}`;
}

const BRIDGE_TYPES = {
  lakeshore:   'bascule',
  carlton:     'bascule',
  queenston:   'bascule',
  glendale:    'vertical',
  allanburg:   'vertical',
  mainwelland: 'bascule',
  mellanby:    'bascule',
  clarence:    'vertical',
};

function getMessages(bridge, status, data) {
  const n = BRIDGE_NAMES[bridge] || bridge;
  const raisedAt = data?.raisedSince;
  const isVertical = BRIDGE_TYPES[bridge] === 'vertical';

  const avgMin = (() => {
    const h = liftHistory[bridge] || [];
    const durations = h.filter(e => e.durationMin).map(e => e.durationMin);
    return durations.length ? Math.round(durations.reduce((a,b) => a+b, 0) / durations.length) : 20;
  })();

  const liftTime = (() => {
    const now = new Date();
    if (raisedAt) {
      const [h, m] = raisedAt.split(':').map(Number);
      const raised = new Date(now);
      raised.setHours(h, m, 0, 0);
      if (raised > now) raised.setDate(raised.getDate() - 1);
      const reopen = new Date(raised.getTime() + avgMin * 60000);
      if (reopen < now) return '';
      return reopen.toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/Toronto' });
    } else {
      const reopen = new Date(now.getTime() + avgMin * 60000);
      return '~' + reopen.toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/Toronto' });
    }
  })();

  const reopenStr = liftTime ? ` · Reopen ${liftTime}` : '';

  const msgs = isVertical ? {
    bientot_leve: { title: `⚠️ ${n}`, body: `Span rising soon · Still open, expect delays` },
    raising:      { title: `🔼 ${n}`, body: `Span rising${reopenStr}` },
    leve:         { title: `🚢 ${n}`, body: `Span raised · Ship passing${reopenStr}` },
    lowering:     { title: `🔽 ${n}`, body: `Span lowering · Opening soon` },
    disponible:   { title: `✅ ${n}`, body: `Normal traffic` },
    outage:       { title: `🚧 ${n}`, body: `Planned closure` },
  } : {
    bientot_leve: { title: `⚠️ ${n}`, body: `Bridge lifting soon · Still open, expect delays` },
    raising:      { title: `🔼 ${n}`, body: `Bridge lifting${reopenStr}` },
    leve:         { title: `🚢 ${n}`, body: `Bridge lifted · Ship passing${reopenStr}` },
    lowering:     { title: `🔽 ${n}`, body: `Bridge lowering · Opening soon` },
    disponible:   { title: `✅ ${n}`, body: `Normal traffic` },
    outage:       { title: `🚧 ${n}`, body: `Planned closure` },
  };
  return msgs[status] || msgs.disponible;
}

// ── Send notifications ────────────────────────────────────────────────
async function sendNotifications(bridge, status, bridgeData = {}) {
  if (status !== 'disponible') {
    disponibleSince[bridge] = null;
  }

  const msg = getMessages(bridge, status, bridgeData);
  let sent = 0, failed = 0, skippedBridge = 0;

  for (const sub of [...subscriptions]) {
    const bridges = sub.bridges || BRIDGE_IDS;
    if (!bridges.includes(bridge)) { skippedBridge++; continue; }

    const bridgeKey = `notifTypes_${bridge}`;
    const perBridgeTypes = sub[bridgeKey];
    const globalTypes = sub.notifTypes;
    // Use per-bridge types if defined (even if empty), then global, then default
    const allowedTypes = Array.isArray(perBridgeTypes) ? perBridgeTypes
      : Array.isArray(globalTypes) ? globalTypes
      : ['bientot_leve','raising','leve','lowering','disponible','outage'];
    const isClosing = status === 'disponible';
    // If no types selected, skip all notifications including disponible
    if (allowedTypes.length === 0) continue;
    if (!isClosing && !allowedTypes.includes(status)) continue;

    const payload = JSON.stringify({
      ...msg, bridge, status,
      tag: `wcb-${bridge}`,
      persistent: !isClosing,
      icon: notifIcon(sub),
      badge: statusBadge(status),
    });

    try {
      await webpush.sendNotification(sub, payload, { urgency: 'high', TTL: 300 });
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
        // Only block truly impossible transitions
        // lowering → raising or leve is physically impossible
        // but lowering → bientot_leve can happen if site skips states
        const invalidTransitions = {
          lowering: ['raising', 'leve'],
        };
        if (invalidTransitions[prev]?.includes(curr)) {
          log(`⚠️ Ignored invalid transition [${bridge}]: ${prev} → ${curr}`);
          continue;
        }

        anyChange = true;
        log(`🔄 Change [${bridge}]: ${prev} → ${curr}`);

        if (['raising','bientot_leve'].includes(curr) && !liftActive[bridge]) {
          liftActive[bridge] = true;
          loweringActive[bridge] = null;
          liftHistory[bridge].push({ raisedAt: new Date().toISOString(), bridge });
          await saveHistory(bridge); // persist raisedAt immediately
        }
        if (curr === 'lowering') {
          loweringActive[bridge] = Date.now();
        }
        if (curr === 'disponible' && liftActive[bridge]) {
          liftActive[bridge] = false;
          const last = liftHistory[bridge][liftHistory[bridge].length - 1];
          if (last) {
            last.loweredAt = new Date().toISOString();
            last.durationMin = Math.round((Date.now() - new Date(last.raisedAt)) / 60000);
            if (loweringActive[bridge]) {
              last.loweringDurationMin = Math.round((Date.now() - loweringActive[bridge]) / 60000);
            }
            if (last.durationMin < 2) {
              liftHistory[bridge].pop();
            }
          }
          loweringActive[bridge] = null;
          await saveHistory(bridge);
        }

        lastStatus[bridge] = curr;
        await saveLastStatus();
        const ld = getLiftData(bridge);
        if (ld.avgLift) log(`⏱️ [${bridge}] avgLift:${ld.avgLift}min avgLowering:${ld.avgLowering}min`);
        await sendNotifications(bridge, curr, data[bridge]);
      }
    }

    if (!anyChange) log('💤 No changes');

    // Check for upcoming closures within 24h
    for (const bridge of BRIDGE_IDS) {
      const closures = data[bridge]?.closures || [];
      for (const closure of closures) {
        const hoursUntil = (closure.startDate - Date.now()) / 3600000;
        if (hoursUntil > 0 && hoursUntil <= 24) {
          const key = `closure:${bridge}:${closure.start}`;
          const alreadyNotified = await redisCmd('GET', key);
          if (!alreadyNotified) {
            await redisCmd('SET', key, '1', 'EX', 86400);
            const n = BRIDGE_NAMES[bridge] || bridge;
            const msg = {
              title: `🚧 ${n}`,
              body: `Planned closure starting ${closure.start}`,
              bridge,
              status: 'outage',
              tag: `closure-${bridge}-${closure.start}`,
            };
            log(`📅 Closure notification [${bridge}]: ${closure.start}`);
            for (const sub of subscriptions) {
              const bridges = sub.bridges || BRIDGE_IDS;
              if (!bridges.includes(bridge)) continue;
              try {
                await webpush.sendNotification(sub, JSON.stringify(msg), { urgency: 'high', TTL: 3600 });
              } catch(e) {
                if (e.statusCode === 410) subscriptions.splice(subscriptions.indexOf(sub), 1);
              }
            }
          }
        }
      }
    }

    // Adaptive polling — 5s if any bridge is active, 15s otherwise
    const anyActive = BRIDGE_IDS.some(id =>
      ['bientot_leve','raising','leve','lowering'].includes(lastStatus[id])
    );
    const nextPoll = anyActive ? 5000 : 15000;
    if (anyActive) log(`⚡ Active bridges detected — polling every 5s`);
    clearTimeout(monitorTimeout);
    monitorTimeout = setTimeout(monitor, nextPoll);

  } catch (e) {
    log('❌ Monitor error:', e.message);
    clearTimeout(monitorTimeout);
    monitorTimeout = setTimeout(monitor, 15000);
  }
}

// ── Routes ────────────────────────────────────────────────────────────
app.get('/ping', (req, res) => res.json({ ok: true, subs: subscriptions.length }));

app.get('/status', async (req, res) => {
  res.set('Cache-Control', 'no-store');

  // If bridges param provided, fetch only needed pages and return fresh data
  const bridgesParam = req.query.bridges;
  if (bridgesParam) {
    const requested = bridgesParam.split(',').filter(id => BRIDGE_IDS.includes(id));
    if (requested.length > 0) {
      try {
        const fresh = await fetchBridgeStatus(requested);
        // Merge fresh data into lastData
        for (const id of requested) {
          lastData[id] = fresh[id];
        }
      } catch(e) {
        log('❌ Status fetch error:', e.message);
      }
    }
  }

  const enriched = {};
  for (const id of BRIDGE_IDS) {
    const liftData = getLiftData(id);
    enriched[id] = { ...lastData[id], ...liftData };
  }
  res.json({ bridges: enriched, last_updated: new Date().toISOString() });
});

function getLiftData(bridge) {
  const status = lastStatus[bridge];
  if (!['bientot_leve','raising','leve','lowering'].includes(status)) return {};

  const history = liftHistory[bridge] || [];
  const completed = history.filter(e => e.durationMin);
  const completedLowering = history.filter(e => e.loweringDurationMin);

  const avgLift = completed.length
    ? Math.round(completed.reduce((a,b) => a + b.durationMin, 0) / completed.length)
    : 20;
  const avgLowering = completedLowering.length
    ? Math.round(completedLowering.reduce((a,b) => a + b.loweringDurationMin, 0) / completedLowering.length)
    : 2;

  const current = history[history.length - 1];
  const raisedAt = (current && !current.loweredAt) ? current.raisedAt : null;

  return { avgLift, avgLowering, raisedAt };
}

app.get('/history', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const result = {};
  for (const id of BRIDGE_IDS) {
    const entries = liftHistory[id] || [];
    const completed = entries.filter(e => e.loweredAt).sort((a, b) => new Date(b.loweredAt) - new Date(a.loweredAt));
    const lastEntry = completed[0];
    const durations = completed.filter(e => e.durationMin).map(e => e.durationMin);
    const loweringDurations = completed.filter(e => e.loweringDurationMin).map(e => e.loweringDurationMin);

    const heatmap = {};
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    for (const e of entries) {
      if (!e.raisedAt) continue;
      const dt = new Date(e.raisedAt);
      if (dt.getTime() < cutoff) continue;
      const day = dt.toLocaleDateString('en-CA', { timeZone: 'America/Toronto', weekday: 'short' });
      const hour = parseInt(dt.toLocaleString('en-CA', { timeZone: 'America/Toronto', hour: 'numeric', hour12: false }));
      const dayIndex = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(day);
      if (dayIndex === -1) continue;
      const key = `${dayIndex}-${hour}`;
      heatmap[key] = (heatmap[key] || 0) + 1;
    }

    result[id] = {
      entries: entries.length,
      lastLift: lastEntry ? lastEntry.loweredAt : null,
      avgDuration: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
      avgLowering: loweringDurations.length ? Math.round(loweringDurations.reduce((a, b) => a + b, 0) / loweringDurations.length) : null,
      heatmap,
      raw: entries,
    };
  }
  res.json(result);
});

app.get('/cleanup-history', async (req, res) => {
  const results = {};
  for (const id of BRIDGE_IDS) {
    const before = liftHistory[id].length;
    liftHistory[id] = liftHistory[id].filter(e => !e.durationMin || e.durationMin >= 2);
    await saveHistory(id);
    results[id] = { before, after: liftHistory[id].length };
  }
  res.json({ ok: true, results });
});

app.get('/debug-subs', (req, res) => {
  res.json(subscriptions.map(s => ({
    endpoint: s.endpoint.slice(-30),
    notifTypes: s.notifTypes,
    bridges: s.bridges,
    theme: s.theme,
  })));
});

app.get('/test-notif', async (req, res) => {
  const bridge = req.query.bridge || 'mainwelland';
  const status = req.query.status || 'bientot_leve';
  if (!BRIDGE_IDS.includes(bridge)) return res.status(400).json({ error: 'Invalid bridge' });
  await sendNotifications(bridge, status, lastData[bridge] || {});
  res.json({ ok: true, bridge, status });
});

app.get('/remove-sub', async (req, res) => {
  const partial = req.query.endpoint;
  if (!partial) return res.status(400).json({ error: 'Missing endpoint param' });
  const before = subscriptions.length;
  subscriptions = subscriptions.filter(s => !s.endpoint.includes(partial));
  await saveSubs();
  res.json({ ok: true, removed: before - subscriptions.length, remaining: subscriptions.length });
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

app.post('/subscribe', async (req, res) => {
  const sub = req.body;
  if (!sub || !sub.endpoint) return res.status(400).json({ error: 'Invalid subscription' });
  const idx = subscriptions.findIndex(s => s.endpoint === sub.endpoint);
  if (idx !== -1) {
    subscriptions[idx] = { ...subscriptions[idx], ...sub };
    log(`✏️ Updated subscriber. Total: ${subscriptions.length}`);
  } else {
    subscriptions.push(sub);
    log(`➕ New subscriber. Total: ${subscriptions.length}`);
  }
  await saveSubs();
  res.json({ ok: true });
});

app.post('/unsubscribe', async (req, res) => {
  const { endpoint } = req.body;
  if (!endpoint) return res.status(400).json({ error: 'Missing endpoint' });
  const before = subscriptions.length;
  subscriptions = subscriptions.filter(s => s.endpoint !== endpoint);
  if (subscriptions.length < before) {
    await saveSubs();
    log(`➖ Unsubscribed. Total: ${subscriptions.length}`);
  }
  res.json({ ok: true });
});

app.post('/update-subscription', async (req, res) => {
  const updated = req.body;
  if (!updated || !updated.endpoint) return res.status(400).json({ error: 'Invalid' });
  const idx = subscriptions.findIndex(s => s.endpoint === updated.endpoint);
  if (idx !== -1) {
    subscriptions[idx] = { ...subscriptions[idx], ...updated };
    await saveSubs();
    log(`✏️ Updated subscription for ${updated.endpoint.slice(-20)}`);
    res.json({ ok: true });
  } else {
    res.status(404).json({ error: 'Subscription not found' });
  }
});

// ── Start ─────────────────────────────────────────────────────────────
async function start() {
  await loadSubs();
  await loadHistory();
  await loadLastStatus();
  monitor();
  // Adaptive polling managed inside monitor() via setTimeout
  app.listen(PORT, () => {
    log(`🚀 Server running on port ${PORT}`);
    setInterval(() => {
      fetch(`http://localhost:${PORT}/ping`).catch(() => {});
    }, 10 * 60 * 1000);
  });
}

start();

process.on('uncaughtException', (err) => {
  log(`🚨 uncaughtException: ${err.message}`);
  console.error(err);
});

process.on('unhandledRejection', (reason) => {
  log(`🚨 unhandledRejection: ${reason}`);
  console.error(reason);
});
