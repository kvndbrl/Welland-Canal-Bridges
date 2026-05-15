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
let widgetUpdateTimeout = null;
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
    // Only restore if raisedAt is within the last 4 hours — avoids stale data
    const last = liftHistory[id]?.[liftHistory[id].length - 1];
    if (last && last.raisedAt && !last.loweredAt) {
      const ageMin = (Date.now() - new Date(last.raisedAt)) / 60000;
      if (ageMin < 240) {
        liftActive[id] = true;
        log(`🔄 Restored liftActive[${id}] raisedAt:${last.raisedAt} (${Math.round(ageMin)}min ago)`);
      } else {
        // Too old — mark as completed with unknown loweredAt so it doesn't affect estimates
        last.loweredAt = last.raisedAt;
        last.durationMin = 0;
        await saveHistory(id);
        log(`⚠️ Stale liftActive[${id}] discarded (${Math.round(ageMin)}min ago)`);
      }
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
  if (t.includes('work in progress') || t.includes('travaux en cours')) return { status: 'outage', raisedSince: null };
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
      // logged on status change only
    }
  }

  return result;
}

// ── Notification helpers ──────────────────────────────────────────────
const BASE_URL = 'https://wellandcanalbridges.ca';
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
      // Reconstruct raised time in Eastern Time (server runs UTC on Render)
      const estNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/Toronto' }));
      const utcOffset = now.getTime() - estNow.getTime();
      const estRaised = new Date(estNow);
      estRaised.setHours(h, m, 0, 0);
      if (estRaised > estNow) estRaised.setDate(estRaised.getDate() - 1);
      const raised = new Date(estRaised.getTime() + utcOffset);
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
    outage:       { title: `🚧 ${n}`, body: `Bridge closed — work in progress` },
  } : {
    bientot_leve: { title: `⚠️ ${n}`, body: `Bridge lifting soon · Still open, expect delays` },
    raising:      { title: `🔼 ${n}`, body: `Bridge lifting${reopenStr}` },
    leve:         { title: `🚢 ${n}`, body: `Bridge lifted · Ship passing${reopenStr}` },
    lowering:     { title: `🔽 ${n}`, body: `Bridge lowering · Opening soon` },
    disponible:   { title: `✅ ${n}`, body: `Normal traffic` },
    outage:       { title: `🚧 ${n}`, body: `Bridge closed — work in progress` },
  };
  return msgs[status] || msgs.disponible;
}

// ── Send notifications ────────────────────────────────────────────────

// -- Persistent widget notification --
const WIDGET_STATUS_EMOJI = {
  disponible:   '✅',
  bientot_leve: '⚠️',
  raising:      '🔼',
  leve:         '⛔',
  lowering:     '🔽',
  outage:       '🚧',
};

const WIDGET_STATUS_LABEL = {
  disponible:   'Available',
  bientot_leve: 'Lifting soon',
  raising:      'Raising',
  leve:         'Lifted',
  lowering:     'Lowering',
  outage:       'Closed',
};

const WIDGET_STATUS_PRIORITY = ['outage', 'leve', 'raising', 'lowering', 'bientot_leve', 'disponible'];

function getAvgLiftMin(bridge) {
  const h = liftHistory[bridge] || [];
  const durations = h.filter(e => e.durationMin).map(e => e.durationMin);
  return durations.length ? Math.round(durations.reduce((a,b) => a+b, 0) / durations.length) : 20;
}

function buildWellandWidgetBody(sub, bridgeStatuses) {
  const bridges = sub.bridges || BRIDGE_IDS;
  const lines = [];
  for (const bridge of BRIDGE_IDS) {
    if (!bridges.includes(bridge)) continue;
    const d = bridgeStatuses[bridge];
    if (!d) continue;
    const emoji = WIDGET_STATUS_EMOJI[d.status] || '✅';
    const label = WIDGET_STATUS_LABEL[d.status] || d.status;
    const name = BRIDGE_NAMES[bridge] || bridge;
    let line = `${emoji} ${name}: ${label}`;
    if ((d.status === 'leve' || d.status === 'lowering' || d.status === 'raising') && d.avgMin) {
      let reopenTime;
      if (d.status === 'lowering') {
        // Bridge is lowering — use avgLowering only (a few minutes)
        const avgLow = d.avgLowering || 3;
        reopenTime = new Date(Date.now() + avgLow * 60000);
      } else if (d.liftingSince) {
        const elapsed = (Date.now() - d.liftingSince) / 60000;
        const remaining = Math.max(1, d.avgMin - elapsed);
        reopenTime = new Date(Date.now() + remaining * 60000);
      } else {
        reopenTime = new Date(Date.now() + d.avgMin * 60000);
      }
      const hm = reopenTime.toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/Toronto' });
      line += ` · Reopen ~${hm}`;
    }
    if (d.status === 'outage') line += ' · Work in progress';
    if (d.scheduledTimes && d.scheduledTimes.length > 0 && d.status === 'disponible') {
      line += ` · Lifts at ${d.scheduledTimes.join(', ')}`;
    } else if (d.scheduledTime && d.status === 'disponible') {
      line += ` · Lift at ${d.scheduledTime}`;
    }
    lines.push(line);
  }
  return lines.join('\n');
}

async function sendWellandWidgetUpdate(bridgeStatuses) {
  let sent = 0, failed = 0;
  for (const sub of [...subscriptions]) {
    const body = buildWellandWidgetBody(sub, bridgeStatuses);
    if (!body) continue;
    const bridges = sub.bridges || BRIDGE_IDS;
    const activeStatuses = bridges.map(b => bridgeStatuses[b]?.status).filter(Boolean);
    const criticalStatus = WIDGET_STATUS_PRIORITY.find(s => activeStatuses.includes(s)) || 'disponible';
    const payload = JSON.stringify({
      title: 'Welland Canal Bridges',
      body,
      tag: 'wcb-widget',
      icon: notifIcon(sub),
      badge: statusBadge(criticalStatus),
    });
    try {
      await webpush.sendNotification(sub, payload, { urgency: 'low', TTL: 900 });
      sent++;
    } catch(e) {
      failed++;
      if (e.statusCode === 410 || e.statusCode === 404) {
        subscriptions = subscriptions.filter(s => s.endpoint !== sub.endpoint);
        await saveSubs();
      }
    }
  }
  if (sent > 0 || failed > 0) log(`Widget update -- ${sent} sent | ${failed} failed`);
}

async function sendNotifications(bridge, status, bridgeData = {}) {
  if (status !== 'disponible') disponibleSince[bridge] = null;
  const statuses = Object.fromEntries(BRIDGE_IDS.map(id => {
    const last = liftHistory[id]?.[liftHistory[id].length - 1];
    const st = lastStatus[id] || 'disponible';
    // Use raisedSince from live data for accurate EST-based liftingSince
    let ls = null;
    const rs = lastData[id]?.raisedSince;
    if (rs && ['leve','raising','lowering'].includes(st)) {
      const [rh, rm] = rs.split(':').map(Number);
      const now2 = new Date();
      const estNow2 = new Date(now2.toLocaleString('en-US', { timeZone: 'America/Toronto' }));
      const utcOff2 = now2.getTime() - estNow2.getTime();
      const estR2 = new Date(estNow2);
      estR2.setHours(rh, rm, 0, 0);
      if (estR2 > estNow2) estR2.setDate(estR2.getDate() - 1);
      ls = estR2.getTime() + utcOff2;
    } else if (last && last.raisedAt && !last.loweredAt) {
      ls = new Date(last.raisedAt).getTime();
    }
    const ld2 = getLiftData(id);
    return [id, {
      status: st,
      avgMin: (ld2.avgLift || 16) + (ld2.avgLowering || 3),
      avgLowering: ld2.avgLowering || 3,
      liftingSince: ls,
    }];
  }));
  const lastEntry = liftHistory[bridge]?.[liftHistory[bridge].length - 1];
  // Prefer raisedSince from live Seaway data for most accurate lift start time
  let liftingSinceMs = null;
  if (bridgeData.raisedSince && (status === 'leve' || status === 'raising' || status === 'lowering')) {
    const [h, m] = bridgeData.raisedSince.split(':').map(Number);
    const now = new Date();
    const estNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/Toronto' }));
    const utcOffset = now.getTime() - estNow.getTime();
    const estRaised = new Date(estNow);
    estRaised.setHours(h, m, 0, 0);
    if (estRaised > estNow) estRaised.setDate(estRaised.getDate() - 1);
    liftingSinceMs = estRaised.getTime() + utcOffset;
  } else if (lastEntry && lastEntry.raisedAt && !lastEntry.loweredAt) {
    liftingSinceMs = new Date(lastEntry.raisedAt).getTime();
  }
  statuses[bridge] = {
    status,
    avgMin: bridgeData.avgMin || getAvgLiftMin(bridge),
    liftingSince: liftingSinceMs,
  };
  await sendWellandWidgetUpdate(statuses);
  log(`Widget notification [${bridge}] ${status}`);
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

        if (['raising','bientot_leve','leve'].includes(curr) && !liftActive[bridge]) {
          liftActive[bridge] = true;
          loweringActive[bridge] = null;
          liftHistory[bridge].push({ raisedAt: new Date().toISOString(), bridge });
          await saveHistory(bridge);
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

    // Scheduled lift notifications
    for (const bridge of BRIDGE_IDS) {
      if (lastStatus[bridge] === 'outage') continue;
      const liftsRaw = data[bridge]?.next_lifts || '';
      const times = liftsRaw ? [...liftsRaw.matchAll(/(\d{1,2}:\d{2})/g)].map(m => m[1]) : [];
      const newTimes = [];
      for (const time of times) {
        const key = `sched:${bridge}:${time}`;
        const already = await redisCmd('GET', key);
        if (!already) {
          await redisCmd('SET', key, '1', 'EX', 10800);
          newTimes.push(time);
        }
      }
      if (newTimes.length > 0) {
        log(`📅 Scheduled lifts [${bridge}]: ${newTimes.join(', ')}`);
        const statuses = Object.fromEntries(BRIDGE_IDS.map(id => [id, {
          status: lastStatus[id] || 'disponible',
          avgMin: (() => { const _ld = getLiftData(id); return (_ld.avgLift||16)+(_ld.avgLowering||3); })(),
          avgLowering: getLiftData(id).avgLowering || 3,
          liftingSince: null,
          scheduledTimes: id === bridge ? newTimes : null,
        }]));
        await sendWellandWidgetUpdate(statuses);
      }
    }

    if (!anyChange) log('💤 No changes');

    // Multi-bridge alert
    const MULTI_CORRIDORS = [
      { bridges: ['queenston','glendale'], msgEn: 'Queenston & Glendale bridges lifted — consider the QEW' },
      { bridges: ['lakeshore','carlton'], msgEn: 'Lakeshore & Carlton bridges lifted — multiple bridges blocked' },
      { bridges: ['carlton','queenston'], msgEn: 'Carlton & Queenston bridges lifted — multiple bridges blocked' },
      { bridges: ['mainwelland','mellanby','clarence'], msgEn: '3 Port Colborne bridges lifted — expect major delays' },
    ];
    for (const corridor of MULTI_CORRIDORS) {
      const activeCount = corridor.bridges.filter(b => ['leve','raising'].includes(lastStatus[b])).length;
      if (activeCount >= 2) {
        const key = `multi:${corridor.bridges.join('-')}:${new Date().toISOString().slice(0,13)}`;
        const alreadySent = await redisCmd('GET', key);
        if (!alreadySent) {
          await redisCmd('SET', key, '1', 'EX', 3600);
          log(`🌉🌉 Multi-bridge alert: ${corridor.bridges.join(', ')}`);
          for (const sub of subscriptions) {
            const subBridges = sub.bridges || BRIDGE_IDS;
            if (!corridor.bridges.some(b => subBridges.includes(b))) continue;
            try {
              await webpush.sendNotification(sub, JSON.stringify({
                title: '⚠️ Multiple bridges lifted',
                body: corridor.msgEn,
                tag: `multi-${corridor.bridges.join('-')}`,
                status: 'multi',
              }), { urgency: 'high', TTL: 3600 });
            } catch(e) {
              if (e.statusCode === 410) subscriptions.splice(subscriptions.indexOf(sub), 1);
            }
          }
        }
      }
    }

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
    if (anyActive) {
      log(`⚡ Active bridges detected -- polling every 5s`);
      clearTimeout(widgetUpdateTimeout);
      widgetUpdateTimeout = setTimeout(async () => {
        const statuses = Object.fromEntries(BRIDGE_IDS.map(id => {
          const last = liftHistory[id]?.[liftHistory[id].length - 1];
          return [id, {
            status: lastStatus[id] || 'disponible',
            avgMin: getAvgLiftMin(id),
            liftingSince: (last && last.raisedAt && !last.loweredAt) ? new Date(last.raisedAt).getTime() : null,
          }];
        }));
        await sendWellandWidgetUpdate(statuses);
      }, 2 * 60 * 1000);
    }
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

app.get('/admin/fix-raisedAt', async (req, res) => {
  const results = {};
  for (const id of BRIDGE_IDS) {
    const last = liftHistory[id]?.[liftHistory[id].length - 1];
    if (last && last.raisedAt && !last.loweredAt) {
      const ageMin = Math.round((Date.now() - new Date(last.raisedAt)) / 60000);
      const newRaisedAt = new Date().toISOString();
      last.raisedAt = newRaisedAt;
      await saveHistory(id);
      results[id] = { fixed: true, wasAgeMin: ageMin, newRaisedAt };
    } else {
      results[id] = { fixed: false };
    }
  }
  log(`🔧 fix-raisedAt: ${JSON.stringify(results)}`);
  res.json(results);
});

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

  // Use raisedSince from Seaway scraper as source of truth (e.g. "22:37")
  let raisedAt = null;
  const raisedSince = lastData[bridge]?.raisedSince;

  if (raisedSince && status === 'leve') {
    // Seaway provides "raised since HH:MM" in Eastern Time — reconstruct correctly
    const [h, m] = raisedSince.split(':').map(Number);
    const now = new Date();
    // Get current date in EST/EDT
    const estNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/Toronto' }));
    const candidate = new Date(now);
    // Offset: difference between UTC and EST
    const utcOffset = now.getTime() - estNow.getTime();
    const estCandidate = new Date(estNow);
    estCandidate.setHours(h, m, 0, 0);
    if (estCandidate > estNow) estCandidate.setDate(estCandidate.getDate() - 1);
    raisedAt = new Date(estCandidate.getTime() + utcOffset).toISOString();
  } else if (status === 'leve') {
    const current = history[history.length - 1];
    if (current && current.raisedAt && !current.loweredAt) {
      const ageMin = (Date.now() - new Date(current.raisedAt)) / 60000;
      const maxAge = avgLift + 60;
      if (ageMin < maxAge) raisedAt = current.raisedAt;
    }
  }

  // Compute liftingSince in correct EST timezone
  let liftingSince = null;
  if (raisedAt) {
    const now2 = new Date();
    const estNow2 = new Date(now2.toLocaleString('en-US', { timeZone: 'America/Toronto' }));
    const utcOff2 = now2.getTime() - estNow2.getTime();
    const [rh, rm] = raisedAt.split(':').map(Number);
    const estR = new Date(estNow2);
    estR.setHours(rh, rm, 0, 0);
    if (estR > estNow2) estR.setDate(estR.getDate() - 1);
    liftingSince = estR.getTime() + utcOff2;
  }
  return { avgLift, avgLowering, raisedAt, liftingSince };
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
    log(`Server running on port ${PORT}`);
    // Send boot widget after subscriptions are loaded
    setTimeout(async () => {
      const bootStatuses = Object.fromEntries(BRIDGE_IDS.map(id => {
        const last = liftHistory[id]?.[liftHistory[id].length - 1];
        return [id, {
          status: lastStatus[id] || 'disponible',
          avgMin: getAvgLiftMin(id),
          liftingSince: (last && last.raisedAt && !last.loweredAt) ? new Date(last.raisedAt).getTime() : null,
        }];
      }));
      await sendWellandWidgetUpdate(bootStatuses);
    }, 3000);
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
