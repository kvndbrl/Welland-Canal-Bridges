const express = require('express');
const webpush = require('web-push');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
const cors = require('cors');
const WebSocket = require('ws');

const app = express();
app.use(cors());
app.use(express.json());

// ── AIS vessel tracking ───────────────────────────────────────────────
const AIS_API_KEY = process.env.AIS_API_KEY || 'f34af67c17c71094f8c307646b6e5db74f860168';

// Bounding box around canal de Beauharnois
// [minLat, minLon], [maxLat, maxLon]
const AIS_BBOX = [[45.18, -74.02], [45.22, -73.95]];

// Last known vessel in zone per bridge
let vesselNearBridge = { gonzague: null, larocque: null };

// Exact bridge coordinates
const BRIDGES = {
  gonzague: { lat: 45.2053, lon: -73.9855 },
  larocque: { lat: 45.1942, lon: -74.0020 }
};

// Canal de Beauharnois runs roughly E-W
// Valid headings for eastbound (lake → river): 60-120°
// Valid headings for westbound (river → lake): 240-300°
const VALID_HEADINGS = [[60, 120], [240, 300]];

// Track vessel history per MMSI: last N positions + metadata
const vesselHistory = new Map(); // mmsi → [{lat, lon, heading, ts}]
const MAX_HISTORY = 20;

function isValidHeading(cog) {
  if (cog === undefined || cog === null || cog === 511) return true; // unknown → don't filter
  return VALID_HEADINGS.some(([min, max]) => cog >= min && cog <= max);
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function getBestVesselForBridge(bridge) {
  const bp = BRIDGES[bridge];
  const now = Date.now();
  const candidates = [];

  for (const [mmsi, history] of vesselHistory.entries()) {
    if (!history.length) continue;

    // Only consider positions from last 5 minutes
    const recent = history.filter(p => now - p.ts < 300000);
    if (!recent.length) continue;

    const latest = recent[recent.length - 1];
    const distKm = haversineKm(latest.lat, latest.lon, bp.lat, bp.lon);

    // Must be within 2km of the bridge
    if (distKm > 2.0) continue;

    // Check if vessel is moving toward or through the bridge
    // (has more than 1 position point showing movement)
    const isMoving = recent.length > 1;
    const headingOk = isValidHeading(latest.cog);

    let confidence = 0;
    confidence += Math.max(0, 100 - distKm * 50); // closer = higher confidence
    if (headingOk) confidence += 20;
    if (isMoving) confidence += 10;
    // Bonus if vessel has been tracked crossing through bridge zone
    const crossed = recent.some(p => haversineKm(p.lat, p.lon, bp.lat, bp.lon) < 0.3);
    if (crossed) confidence += 30;

    candidates.push({ mmsi, name: latest.name, distKm, confidence, cog: latest.cog });
  }

  if (!candidates.length) return null;

  // Sort by confidence desc
  candidates.sort((a, b) => b.confidence - a.confidence);
  const best = candidates[0];

  // Only return if confidence is reasonable
  if (best.confidence < 40) return null;

  return {
    name: best.name,
    mmsi: best.mmsi,
    distKm: Math.round(best.distKm * 10) / 10,
    confidence: Math.round(best.confidence),
    cog: best.cog
  };
}

function startAISTracking() {
  let ws;
  let reconnectDelay = 30000;
  const MAX_DELAY = 300000; // 5 min max

  function connect() {
    ws = new WebSocket('wss://stream.aisstream.io/v0/stream');

    ws.on('open', () => {
      log('🚢 AIS WebSocket connecté');
      reconnectDelay = 30000; // reset on success
      ws.send(JSON.stringify({
        APIKey: AIS_API_KEY,
        BoundingBoxes: [AIS_BBOX],
        FilterMessageTypes: ['PositionReport', 'ShipStaticData']
      }));
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        const meta = msg.MetaData;
        if (!meta) return;

        const lat = meta.latitude;
        const lon = meta.longitude;
        const mmsi = String(meta.MMSI || '');
        const name = meta.ShipName?.trim().replace(/[^\x20-\x7E]/g, '').trim() || null;
        if (!name || name === '!!!ANYSUCHVESSEL!!!' || !mmsi) return;

        // Get COG from PositionReport if available
        const cog = msg.Message?.PositionReport?.Cog ?? null;

        // Update vessel history
        if (!vesselHistory.has(mmsi)) vesselHistory.set(mmsi, []);
        const hist = vesselHistory.get(mmsi);
        hist.push({ lat, lon, cog, name, ts: Date.now() });
        if (hist.length > MAX_HISTORY) hist.shift();

        // Update best vessel per bridge
        for (const bridge of ['gonzague', 'larocque']) {
          const best = getBestVesselForBridge(bridge);
          if (best) {
            vesselNearBridge[bridge] = { ...best, updatedAt: Date.now() };
            if (!vesselNearBridge[bridge]._logged) {
              log(`🚢 Navire détecté [${bridge}]: ${best.name} à ${best.distKm}km (confiance: ${best.confidence})`);
              vesselNearBridge[bridge]._logged = true;
            }
          }
        }
      } catch(e) {}
    });

    ws.on('close', () => {
      log(`🚢 AIS WebSocket déconnecté — reconnexion dans ${reconnectDelay/1000}s`);
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_DELAY);
    });

    ws.on('error', (e) => {
      log(`🚢 AIS erreur: ${e.message}`);
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_DELAY);
    });
  }

  connect();
}

// Cleanup stale vessel data every minute
setInterval(() => {
  const now = Date.now();
  // Remove old history entries
  for (const [mmsi, hist] of vesselHistory.entries()) {
    const recent = hist.filter(p => now - p.ts < 600000);
    if (!recent.length) vesselHistory.delete(mmsi);
    else vesselHistory.set(mmsi, recent);
  }
  // Re-evaluate best vessel per bridge
  for (const bridge of ['gonzague', 'larocque']) {
    const best = getBestVesselForBridge(bridge);
    if (best) {
      vesselNearBridge[bridge] = { ...best, updatedAt: now };
    } else {
      vesselNearBridge[bridge] = null;
    }
  }
}, 60000);

// ── Umami server-side tracking ────────────────────────────────────────
const UMAMI_URL = 'https://cloud.umami.is/api/send';
const UMAMI_WEBSITE_ID = '1786c8da-b13f-4fec-b8d2-7d2e7102c29b';

async function umamiTrack(eventName, data = {}) {
  try {
    await fetch(UMAMI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'PontsBeau/1.0 (Server)'
      },
      body: JSON.stringify({
        type: 'event',
        payload: {
          website: UMAMI_WEBSITE_ID,
          url: '/server',
          name: eventName,
          data,
          hostname: 'pont-st-louis-de-gonzague.onrender.com',
          language: 'fr-CA',
          screen: '0x0'
        }
      })
    });
  } catch(e) {
    // Never let tracking break the app
  }
}

webpush.setVapidDetails(
  process.env.VAPID_EMAIL,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redisCommand(...args) {
  // Build URL: first arg is command, rest are path segments
  const path = args.map(a => encodeURIComponent(String(a))).join('/');
  const res = await fetch(`${REDIS_URL}/${path}`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

async function loadSubscriptions() {
  try {
    const keys = await redisCommand('keys', 'sub:*');
    if (!keys || keys.length === 0) return [];

    // Use Upstash pipeline to batch all GETs in one HTTP request
    const pipeline = keys.map(k => ['get', k]);
    const res = await fetch(`${REDIS_URL}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(pipeline)
    });
    const results = await res.json();
    const subs = results
      .map(r => r.result)
      .filter(Boolean)
      .map(v => JSON.parse(v));
    log(`Loaded ${subs.length} subscriptions from Redis (1 pipeline request)`);
    return subs;
  } catch(e) {
    console.error('Error loading subscriptions:', e.message);
    return [];
  }
}

// Throttled save — prevents Redis spam on rapid preference changes
const _savePending = new Map();
async function saveSubscription(sub) {
  const key = `sub:${Buffer.from(sub.endpoint).toString('base64').slice(0, 50)}`;
  // Clear existing timer for this sub if any
  if (_savePending.has(key)) clearTimeout(_savePending.get(key));
  _savePending.set(key, setTimeout(async () => {
    _savePending.delete(key);
    try {
      await redisCommand('set', key, JSON.stringify(sub));
    } catch(e) {
      console.error('Error saving subscription:', e.message);
    }
  }, 2000)); // 2s debounce
}

async function removeSubscription(sub) {
  try {
    const key = `sub:${Buffer.from(sub.endpoint).toString('base64').slice(0, 50)}`;
    await redisCommand('del', key);
  } catch(e) {
    console.error('Error removing subscription:', e.message);
  }
}

let subscriptions = [];
let lastStatus = { gonzague: null, larocque: null };

// ── Persist lastStatus in Redis ───────────────────────────────────────
async function saveLastStatus() {
  try {
    await redisCommand('set', 'lastStatus', JSON.stringify(lastStatus));
  } catch(e) { console.error('saveLastStatus error:', e.message); }
}

async function loadLastStatus() {
  try {
    const val = await redisCommand('get', 'lastStatus');
    if (val) {
      lastStatus = JSON.parse(val);
      console.log(`Restored lastStatus from Redis: Gonzague=${lastStatus.gonzague} Larocque=${lastStatus.larocque}`);
    }
  } catch(e) { console.error('loadLastStatus error:', e.message); }
}

// ── Lift history — track duration of each lift for estimations ────────
let liftHistory = { gonzague: [], larocque: [] }; // [{raisedAt, loweredAt, duration}]
let liftActive = { gonzague: null, larocque: null }; // timestamp when lift started

async function saveLiftHistory() {
  try {
    await redisCommand('set', 'liftHistory', JSON.stringify(liftHistory));
  } catch(e) { console.error('saveLiftHistory error:', e.message); }
}

async function loadLiftHistory() {
  try {
    const val = await redisCommand('get', 'liftHistory');
    if (val) {
      liftHistory = JSON.parse(val);
      log(`📊 Historique chargé: Gonzague=${liftHistory.gonzague.length} levées, Larocque=${liftHistory.larocque.length} levées`);
    }
  } catch(e) { console.error('loadLiftHistory error:', e.message); }
}

function getAvgLiftDuration(bridge) {
  const h = liftHistory[bridge];
  if (!h || h.length === 0) return null;
  const recent = h.slice(-20); // use last 20 lifts
  const avg = recent.reduce((a, b) => a + b.duration, 0) / recent.length;
  return Math.round(avg / 60000); // return minutes
}

function getAvgLoweringDuration(bridge) {
  const h = liftHistory[bridge];
  if (!h || h.length === 0) return null;
  const withLowering = h.slice(-20).filter(e => e.loweringDuration);
  if (!withLowering.length) return null;
  const avg = withLowering.reduce((a, b) => a + b.loweringDuration, 0) / withLowering.length;
  return Math.round(avg / 60000);
}

// Returns true if the current hour is historically busy for this bridge
// "Busy" = this 2-hour window has ≥3 lifts historically (out of all recorded)
function isBusyPeriod(bridge) {
  const h = liftHistory[bridge];
  if (!h || h.length < 5) return false; // not enough data
  const now = new Date();
  const currentHour = now.getHours();
  // Count lifts in same day-of-week ± same 2h window
  const window = h.filter(e =>
    Math.abs(e.hour - currentHour) <= 1
  );
  // Busy if this window represents ≥25% of all lifts or ≥3 entries
  return window.length >= 3 || (window.length / h.length) >= 0.25;
}

function trackStatusTransition(bridge, prev, curr) {
  const now = Date.now();
  if ((curr === 'raising' || curr === 'leve') && !liftActive[bridge]) {
    liftActive[bridge] = { raisedAt: now };
  saveLiftActive();
  }
  if (curr === 'lowering' && liftActive[bridge] && !liftActive[bridge].loweredAt) {
    liftActive[bridge].loweredAt = now;
    liftActive[bridge].duration = now - liftActive[bridge].raisedAt;
  saveLiftActive();
  }
  if (curr === 'disponible' && liftActive[bridge]) {
    const entry = liftActive[bridge];
    const loweringDuration = entry.loweredAt ? (now - entry.loweredAt) : null;
    liftHistory[bridge].push({
      raisedAt: entry.raisedAt,
      duration: entry.loweredAt ? (entry.loweredAt - entry.raisedAt) : (now - entry.raisedAt),
      loweringDuration,
      day: new Date(entry.raisedAt).getDay(),
      hour: new Date(entry.raisedAt).getHours()
    });
    // Keep last 100 entries
    if (liftHistory[bridge].length > 100) liftHistory[bridge].shift();
    liftActive[bridge] = null;
    saveLiftHistory();
  saveLiftActive();
    log(`📊 Levée [${bridge}] enregistrée: ~${Math.round((entry.loweredAt||now) - entry.raisedAt) / 60000} min`);
  }
}
async function isLiftNotified(key) {
  try {
    const val = await redisCommand('get', `lift:${key}`);
    return val !== null;
  } catch(e) { return false; }
}

async function markLiftNotified(key) {
  try {
    // Expire after 3 hours so Redis self-cleans
    await redisCommand('set', `lift:${key}`, '1', 'EX', '10800');
  } catch(e) { console.error('markLiftNotified error:', e.message); }
}

// Track last scheduled notification per bridge to prevent spam when time updates each poll
const lastScheduledNotif = { gonzague: 0, larocque: 0 };
const SCHEDULED_NOTIF_COOLDOWN = 20 * 60 * 1000; // 20 minutes

// ── Time range check (Montreal time) ─────────────────────────────────
function isInTimeRange(sub) {
  const now = new Date();
  const montreal = new Date(now.toLocaleString('en-US', { timeZone: 'America/Toronto' }));
  const currentDay = montreal.getDay();
  const currentMinutes = montreal.getHours() * 60 + montreal.getMinutes();

  const ranges = sub.timeRanges;
  // No ranges → check day filter only
  if (!ranges || ranges.length === 0) {
    const allowedDays = sub.notifDays && sub.notifDays.length > 0 ? sub.notifDays : [0,1,2,3,4,5,6];
    return allowedDays.includes(currentDay);
  }

  // Check each range with its corresponding day filter
  for (let i = 0; i < ranges.length; i++) {
    const range = ranges[i];
    if (!range.start || !range.end) continue;

    // Day filter: range 0 uses notifDays, range 1 uses notifDays2
    const daysKey = i === 0 ? 'notifDays' : 'notifDays2';
    const allowedDays = sub[daysKey] && sub[daysKey].length > 0 ? sub[daysKey] : [0,1,2,3,4,5,6];
    if (!allowedDays.includes(currentDay)) continue;

    const [startH, startM] = range.start.split(':').map(Number);
    const [endH, endM] = range.end.split(':').map(Number);
    const startMinutes = startH * 60 + startM;
    const endMinutes = endH * 60 + endM;

    if (startMinutes <= endMinutes) {
      if (currentMinutes >= startMinutes && currentMinutes <= endMinutes) return true;
    } else {
      if (currentMinutes >= startMinutes || currentMinutes <= endMinutes) return true;
    }
  }
  return false;
}

// ── Bridge status fetch ───────────────────────────────────────────────
async function fetchBridgeStatus() {
  const res = await fetch(
    'https://www.seaway-greatlakes.com/bridgestatus/detailsmai2?key=BridgeSBS',
    { headers: { 'User-Agent': 'Mozilla/5.0' } }
  );
  const html = await res.text();

  // Split HTML into two bridge sections more reliably
  // Find the two information-container divs
  const containers = [...html.matchAll(/<div[^>]*class="[^"]*information-container[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi)];

  // Identify which container belongs to which bridge by looking for bridge names nearby
  let gonzagueSection = '';
  let larocqueSection = '';

  if (containers.length >= 2) {
    // Find sections by looking at the surrounding context
    const gonzagueIdx = html.toLowerCase().indexOf('gonzague');
    const larocqueIdx = html.toLowerCase().indexOf('larocque');

    // Get the HTML chunk for each bridge based on position
    if (gonzagueIdx < larocqueIdx) {
      gonzagueSection = html.slice(gonzagueIdx, larocqueIdx);
      larocqueSection = html.slice(larocqueIdx, larocqueIdx + 3000);
    } else {
      larocqueSection = html.slice(larocqueIdx, gonzagueIdx);
      gonzagueSection = html.slice(gonzagueIdx, gonzagueIdx + 3000);
    }
  } else {
    // Fallback to original method
    gonzagueSection = html.match(/Gonzague[\s\S]{0,3000}?(?=Larocque|<\/body>)/i)?.[0] || '';
    larocqueSection = html.match(/Larocque[\s\S]{0,3000}?(?=Gonzague|<\/body>)/i)?.[0] || '';
  }

  function extractStatus(section, bridgeName) {
    const titleRegex = /<h1[^>]*status-title[^>]*>\s*<b>([^<]+)<\/b>/gi;
    const titles = [...section.matchAll(titleRegex)].map(m => m[1].trim().toLowerCase());
    const combined = titles.join(' ');

    if (combined.includes('lowering')) return { status: 'lowering', raisedSince: null };
    if (combined.includes('raising soon')) return { status: 'bientot_leve', raisedSince: null };
    if (combined.includes('raising')) return { status: 'raising', raisedSince: null };

    const raisedMatch = combined.match(/raised since\s+(\d{1,2}:\d{2})/i);
    if (raisedMatch) return { status: 'leve', raisedSince: raisedMatch[1] };

    if (combined.includes('unavailable')) return { status: 'leve', raisedSince: null };

    return { status: null, raisedSince: null, titles };
  }

  function colorToStatus(color) {
    if (!color) return 'disponible';
    const c = color.toUpperCase();
    if (c === '#E48082') return 'leve';
    if (c === '#FEEAA8') return 'bientot_leve';
    return 'disponible';
  }

  function extractColor(html, bridgePattern) {
    const regex = new RegExp(
      `background-color:\\s*(#[A-Fa-f0-9]{6})[^<]*<[^<]*${bridgePattern}`, 'i'
    );
    const match = html.match(regex);
    return match ? match[1].toUpperCase() : '#C1D6A8';
  }

  function isCurrentlyInOutage(closures) {
    if (!closures || closures.length === 0) return null;
    const nowUTC = new Date(); // UTC timestamp, same reference as parsed dates

    for (const c of closures) {
      // Seaway format: "2026-04-11 03:00 until 2026-04-11 15:00" (times are in ET/Montreal)
      const m = c.match(/(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})\s+until\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})/i);
      if (!m) continue;

      // Parse as Montreal time by appending ET offset
      // Montreal is UTC-5 (EST) or UTC-4 (EDT — April is EDT)
      const etOffset = '-04:00'; // April = EDT
      const start = new Date(m[1].replace(' ', 'T') + ':00' + etOffset);
      const end   = new Date(m[2].replace(' ', 'T') + ':00' + etOffset);

      if (isNaN(start) || isNaN(end)) continue;

      if (nowUTC >= start && nowUTC <= end) {
        log(`🚧 Outage actif [closure]: ${c} → fin à ${end.toISOString()}`);
        return { closure: c, end };
      }
    }
    return null;
  }

  function getBridgeStatus(section, color, bridgeName, closures) {
    // Check active outage first — overrides all other statuses
    const outage = isCurrentlyInOutage(closures);
    if (outage) return { status: 'outage', raisedSince: null, outageEnd: outage.end, closure: outage.closure };
    const result = extractStatus(section, bridgeName);
    if (result.status) return { status: result.status, raisedSince: result.raisedSince };
    const colorStatus = colorToStatus(color);
    return { status: colorStatus, raisedSince: null };
  }

  function extractLifts(section) {
    const matches = [...section.matchAll(/class="item-data[^"]*"[^>]*>([^<]+)/g)];
    const lifts = matches.map(m => m[1].trim()).filter(v => v && v !== 'No anticipated bridge lifts' && v !== 'Aucune levée de pont prévue');
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

  const colorGonzague = extractColor(html, 'St[\\-\\s]Louis[\\-\\s]de[\\-\\s]Gonzague');
  const colorLarocque = extractColor(html, 'Larocque');

  const closuresGonzague = extractClosures(gonzagueSection);
  const closuresLarocque = extractClosures(larocqueSection);

  const gonzague = getBridgeStatus(gonzagueSection, colorGonzague, 'gonzague', closuresGonzague);
  const larocque = getBridgeStatus(larocqueSection, colorLarocque, 'larocque', closuresLarocque);

  // Warn if sections look empty
  if (gonzagueSection.length < 100)
    log(`⚠️ gonzagueSection trop court (${gonzagueSection.length} chars) — scraping peut avoir échoué`);
  if (larocqueSection.length < 100)
    log(`⚠️ larocqueSection trop court (${larocqueSection.length} chars) — scraping peut avoir échoué`);

  const refreshMatch = html.match(/Last Refreshed at[:\s]*([\d\-: ]+)/i);
  const last_refreshed = refreshMatch ? refreshMatch[1].trim() : '';

  return {
    gonzague: {
      status: gonzague.status,
      raisedSince: gonzague.raisedSince,
      outageEnd: gonzague.outageEnd || null,
      next_lifts: extractLifts(gonzagueSection),
      closures: closuresGonzague
    },
    larocque: {
      status: larocque.status,
      raisedSince: larocque.raisedSince,
      outageEnd: larocque.outageEnd || null,
      next_lifts: extractLifts(larocqueSection),
      closures: closuresLarocque
    },
    last_refreshed,
    _sections: { gonzague: gonzagueSection, larocque: larocqueSection }
  };
}

// ── Send notifications ────────────────────────────────────────────────

function getMessages(bridge, status, lang, data) {
  const shortNames = {
    fr: { gonzague: 'Pont St-Louis', larocque: 'Pont Larocque' },
    en: { gonzague: 'St-Louis Bridge', larocque: 'Larocque Bridge' }
  };
  const n = (shortNames[lang] || shortNames.fr)[bridge];

  // Build vessel string if available
  const vesselStr = data?.vessel?.name
    ? (lang === 'fr' ? ` · Navire: ${data.vessel.name}` : ` · Vessel: ${data.vessel.name}`)
    : '';

  // Build outage time string if available
  let outageStr = '';
  if (status === 'outage' && data && data.outageEnd) {
    const end = new Date(data.outageEnd);
    const hm = end.toLocaleTimeString('fr-CA', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Toronto' });
    outageStr = lang === 'fr' ? ` · Fermé jusqu'à ${hm}` : ` · Closed until ${hm}`;
  }

  // Estimated lowering duration
  const avgLow = data?.avgLoweringDuration;
  const lowerStr = avgLow
    ? (lang === 'fr' ? ` · ~${avgLow} min avant réouverture` : ` · ~${avgLow} min to reopen`)
    : '';

  // Estimated lift duration + reopen clock time
  const avgLift = data?.avgLiftDuration || 12; // fallback 12 min
  const reopenTime = new Date(Date.now() + avgLift * 60000);
  const hm = reopenTime.toLocaleTimeString('fr-CA', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Toronto' });
  const liftStr = lang === 'fr'
    ? ` · Réouverture prévue ~${hm}`
    : ` · Expected reopen ~${hm}`;

  // Busy period warning
  const busy = isBusyPeriod(bridge);
  const busyStr = busy
    ? (lang === 'fr' ? ' · Période achalandée — prévoir un itinéraire alternatif' : ' · Busy period — consider an alternate route')
    : '';

  const fr = {
    bientot_leve: { title: `⚠️ ${n}`, body: `Bientôt levé · Prévoir un délai` },
    raising:      { title: `🔼 ${n}`, body: `En cours de levage · Réouverture ~${hm}` },
    leve:         { title: `🚢 ${n}`, body: `Pont levé · Réouverture prévue ~${hm}` },
    lowering:     { title: `🔽 ${n}`, body: `Pont redescend · Bientôt disponible` },
    disponible:   { title: `✅ ${n}`, body: `Circulation normale` },
    outage:       { title: `🚧 ${n}`, body: `Fermeture planifiée${outageStr}` }
  };
  const en = {
    bientot_leve: { title: `⚠️ ${n}`, body: `Lift soon · Expect delays` },
    raising:      { title: `🔼 ${n}`, body: `Bridge raising · Reopen ~${hm}` },
    leve:         { title: `🚢 ${n}`, body: `Bridge lifted · Expected reopen ~${hm}` },
    lowering:     { title: `🔽 ${n}`, body: `Bridge lowering · Opening soon` },
    disponible:   { title: `✅ ${n}`, body: `Traffic normal` },
    outage:       { title: `🚧 ${n}`, body: `Planned closure${outageStr}` }
  };

  return (lang === 'en' ? en : fr)[status] || null;
}

// Parse scheduled lift times from next_lifts text
// Input: "Commercial Vessel: 14:30*\nPleasure Craft: 15:00" etc.
function parseScheduledLifts(text) {
  if (!text || text === 'No anticipated bridge lifts') return [];
  const times = [];
  const matches = text.matchAll(/(\d{1,2}:\d{2})/g);
  for (const m of matches) {
    times.push(m[1]);
  }
  return times;
}

// ── Notification icon per theme ───────────────────────────────────────
const BASE_URL = 'https://ponts-canal-de-beauharnois.vercel.app';
const VALID_THEMES = ['gonzaguois', 'campivallensien', 'stanicois'];

function notifIcon(sub) {
  const theme = VALID_THEMES.includes(sub.theme) ? sub.theme : 'gonzaguois';
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
    scheduled:    '/badge-scheduled.png',
    achalandage:  '/badge-warning.png',
  };
  return `${BASE_URL}${map[status] || '/badge-default.png'}`;
}

// ── Logging helper ───────────────────────────────────────────────────
function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

// Send scheduled lift notification
async function sendScheduledLiftNotification(bridge, time) {
  const names = {
    fr: { gonzague: 'Pont St-Louis', larocque: 'Pont Larocque (Valleyfield)' },
    en: { gonzague: 'St-Louis Bridge', larocque: 'Larocque Bridge (Valleyfield)' }
  };

  let sent = 0, skippedRange = 0, skippedBridge = 0, failed = 0;

  for (const sub of [...subscriptions]) {
    const bridges = sub.bridges || ['gonzague', 'larocque'];
    if (!bridges.includes(bridge)) { skippedBridge++; continue; }
    if (!isInTimeRange(sub)) { skippedRange++; continue; }
    const bridgeKey = bridge === 'gonzague' ? 'notifTypesGonzague' : 'notifTypesLarocque';
    const allowedTypes = sub[bridgeKey] || sub.notifTypes || ['bientot_leve','raising','leve','lowering','disponible','scheduled'];
    if (!allowedTypes.includes('scheduled')) { skippedBridge++; continue; }

    const lang = sub.lang || 'fr';
    const name = (names[lang] || names.fr)[bridge];
    const msg = lang === 'en'
      ? { title: `📅 Lift scheduled at ${time}`, body: `${name} will be raised at ${time}.` }
      : { title: `📅 Levée prévue à ${time}`, body: `Le ${name} sera levé à ${time}.` };

    const payload = JSON.stringify({ ...msg, bridge, tag: `pont-${bridge}`, persistent: false, icon: notifIcon(sub), badge: statusBadge('scheduled') });
    try {
      await webpush.sendNotification(sub, payload, { urgency: 'high', TTL: 300 });
      sent++;
    } catch(e) {
      failed++;
      log(`❌ Push failed [${bridge}] scheduled ${time} — HTTP ${e.statusCode}: ${e.message}`);
      subscriptions = subscriptions.filter(s => s.endpoint !== sub.endpoint);
      await removeSubscription(sub);
      umamiTrack('subscription_lost', { reason: 'push_failed', total: subscriptions.length });
    }
  }
  log(`📅 Levée planifiée [${bridge}] ${time} — ✅ ${sent} envoyées | ⏰ ${skippedRange} hors plage | 🚫 ${skippedBridge} pont non suivi | ❌ ${failed} échouées`);
}

// Track when bridge became disponible to avoid spurious notifications
const disponibleSince = { gonzague: null, larocque: null };

async function sendNotifications(bridge, status, bridgeData = {}) {
  if (status !== 'disponible') {
    disponibleSince[bridge] = null;
  }
  let sent = 0, skippedRange = 0, skippedBridge = 0, skippedNoMsg = 0, failed = 0;

  for (const sub of [...subscriptions]) {
    const bridges = sub.bridges || ['gonzague', 'larocque'];
    if (!bridges.includes(bridge)) { skippedBridge++; continue; }

    // Always send 'disponible' regardless of time range or type filter — closes persistent notification
    const isClosing = status === 'disponible';
    if (!isClosing && !isInTimeRange(sub)) { skippedRange++; continue; }

    const bridgeKey2 = bridge === 'gonzague' ? 'notifTypesGonzague' : 'notifTypesLarocque';
    const allowedTypes = sub[bridgeKey2] || sub.notifTypes || ['bientot_leve','leve','outage'];
    if (!isClosing && !allowedTypes.includes(status)) { skippedNoMsg++; continue; }

    const lang = sub.lang || 'fr';
    const msg = getMessages(bridge, status, lang, bridgeData);
    if (!msg) { skippedNoMsg++; continue; }

    const payload = JSON.stringify({
      ...msg, bridge, status,
      tag: `pont-${bridge}`,
      persistent: true,
      icon: notifIcon(sub),
      badge: statusBadge(status)
    });

    try {
      await webpush.sendNotification(sub, payload, { urgency: 'high', TTL: 300 });
      sent++;
    } catch(e) {
      failed++;
      log(`❌ Push failed [${bridge}] ${status} — HTTP ${e.statusCode}: ${e.message}`);
      subscriptions = subscriptions.filter(s => s.endpoint !== sub.endpoint);
      await removeSubscription(sub);
      umamiTrack('subscription_lost', { reason: 'push_failed', total: subscriptions.length });
    }
  }
  log(`🔔 Notification [${bridge}] ${status} — ✅ ${sent} envoyées | ⏰ ${skippedRange} hors plage | 🚫 ${skippedBridge} pont non suivi | ❌ ${failed} échouées`);
}

// ── Monitor ───────────────────────────────────────────────────────────
async function monitor() {
  try {
    const data = await fetchBridgeStatus();
    log(`🌉 Gonzague: ${data.gonzague.status} | Larocque: ${data.larocque.status} | Abonnés: ${subscriptions.length}`);

    const notifications = [];

    // Status change notifications
    for (const bridge of ['gonzague', 'larocque']) {
      const prev = lastStatus[bridge];
      const curr = data[bridge].status;
      if (prev === null) {
        log(`⚡ Boot [${bridge}] — statut initial: ${curr} (pas de notif)`);
      } else if (prev !== curr) {
        const section = data._sections[bridge] || '';
        const titleRegex = /<h1[^>]*status-title[^>]*>\s*<b>([^<]+)<\/b>/gi;
        const titles = [...section.matchAll(titleRegex)].map(m => m[1].trim());
        log(`🔄 Changement [${bridge}]: ${prev} → ${curr} | titres HTML: [${titles.join(' / ') || 'aucun'}]`);
        trackStatusTransition(bridge, prev, curr);
        notifications.push(sendNotifications(bridge, curr, data[bridge]));
      }
    }

    // Scheduled lift notifications (next 60 min)
    // Skip if bridge is in outage — it's already closed, lift info is irrelevant
    for (const bridge of ['gonzague', 'larocque']) {
      if (data[bridge].status === 'outage') {
        log(`⏭️ Levées planifiées [${bridge}] ignorées — pont en fermeture`);
        continue;
      }
      const lifts = parseScheduledLifts(data[bridge].next_lifts);
      for (const time of lifts) {
        const key = `${bridge}:${time}`;
        const alreadyNotified = await isLiftNotified(key);
        const cooldownOk = (Date.now() - lastScheduledNotif[bridge]) > SCHEDULED_NOTIF_COOLDOWN;
        if (!alreadyNotified && cooldownOk) {
          log(`📅 Nouvelle levée planifiée [${bridge}] à ${time}`);
          await markLiftNotified(key);
          lastScheduledNotif[bridge] = Date.now();
          notifications.push(sendScheduledLiftNotification(bridge, time));
        }
      }
    }

    if (notifications.length === 0) {
      log(`💤 Aucun changement détecté`);
    }

    await Promise.all(notifications);

    lastStatus.gonzague = data.gonzague.status;
    lastStatus.larocque = data.larocque.status;
    await saveLastStatus();

    // Start VesselFinder polling when any bridge is active, stop when all disponible
    const anyActive = ['gonzague','larocque'].some(b =>
      ['raising','leve','bientot_leve'].includes(data[b].status)
    );
    // VesselFinder polling disabled — no reliable free AIS source for this area

  } catch(e) {
    log(`🚨 Monitor error: ${e.message}`);
    console.error(e);
  }
}


setInterval(async () => {
  try {
    await fetch('https://pont-st-louis-de-gonzague.onrender.com/ping');
    console.log('Auto-ping OK');
  } catch(e) {
    console.log('Auto-ping failed:', e.message);
  }
}, 600000);

// ── Routes ────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.send('Ponts Beauharnois API'));
app.get('/ping', (req, res) => res.send('OK'));

// ── Vessel update from frontend AIS ──────────────────────────────────
app.post('/vessel-update', (req, res) => {
  const { bridge, name, mmsi, confidence, cog } = req.body;
  if (!bridge || !['gonzague','larocque'].includes(bridge)) return res.status(400).json({ error: 'Invalid bridge' });
  if (name && mmsi) {
    vesselNearBridge[bridge] = { name, mmsi, confidence: confidence || 50, cog, updatedAt: Date.now() };
    log(`🚢 Navire [${bridge}] via client: ${name} (confiance: ${confidence})`);
  } else {
    vesselNearBridge[bridge] = null;
  }
  res.json({ ok: true });
});

app.get('/status', async (req, res) => {
  try {
    const data = await fetchBridgeStatus();
    // Enrich with lift history data
    for (const bridge of ['gonzague', 'larocque']) {
      data[bridge].avgLiftDuration = getAvgLiftDuration(bridge);
      data[bridge].avgLoweringDuration = getAvgLoweringDuration(bridge);
      data[bridge].liftCount = liftHistory[bridge].length;
      if (liftActive[bridge]) {
        data[bridge].liftingSince = liftActive[bridge].raisedAt;
      }
      // Add vessel info if available
      if (vesselNearBridge[bridge]) {
        data[bridge].vessel = vesselNearBridge[bridge];
      }
    }
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/subscribe', async (req, res) => {
  const sub = req.body;
  const existing = subscriptions.find(s => s.endpoint === sub.endpoint);
  if (existing) {
    existing.bridges = sub.bridges || ['gonzague', 'larocque'];
    existing.timeRanges = sub.timeRanges || [];
    existing.lang = sub.lang || 'fr';
    existing.theme = sub.theme || 'gonzaguois';
    existing.notifTypes = sub.notifTypes || ['bientot_leve','raising','leve','lowering','disponible','scheduled','outage','achalandage'];
    if (sub.notifTypesGonzague) existing.notifTypesGonzague = sub.notifTypesGonzague;
    if (sub.notifTypesLarocque) existing.notifTypesLarocque = sub.notifTypesLarocque;
    existing.notifDays = sub.notifDays !== undefined ? sub.notifDays : [0,1,2,3,4,5,6];
    existing.notifDays2 = sub.notifDays2 !== undefined ? sub.notifDays2 : [0,1,2,3,4,5,6];
    await saveSubscription(existing);
    console.log(`Updated subscriber. Lang: ${existing.lang}, Bridges: ${existing.bridges}`);
  } else {
    subscriptions.push(sub);
    await saveSubscription(sub);
    console.log(`New subscriber! Lang: ${sub.lang}, Bridges: ${sub.bridges}. Total: ${subscriptions.length}`);
    umamiTrack('subscription_new', { total: subscriptions.length, lang: sub.lang || 'fr' });
  }
  res.json({ ok: true });
});

app.post('/unsubscribe', async (req, res) => {
  const { endpoint } = req.body;
  subscriptions = subscriptions.filter(s => s.endpoint !== endpoint);
  const key = `sub:${Buffer.from(endpoint).toString('base64').slice(0, 50)}`;
  await redisCommand('del', key);
  console.log(`Unsubscribed. Total: ${subscriptions.length}`);
  umamiTrack('subscription_lost', { reason: 'user', total: subscriptions.length });
  res.json({ ok: true });
});

// ── Voice assistant status endpoint ───────────────────────────────────
app.get('/assistant', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const lang = req.query.lang || 'fr';
  const parts = [];
  for (const bridge of ['gonzague', 'larocque']) {
    const name = bridge === 'gonzague'
      ? (lang === 'fr' ? 'Pont St-Louis' : 'St-Louis Bridge')
      : (lang === 'fr' ? 'Pont Larocque' : 'Larocque Bridge');
    const s = lastStatus[bridge];
    let desc;
    if (lang === 'fr') {
      if (s === 'disponible') desc = 'est disponible';
      else if (s === 'bientot_leve') desc = 'sera bientôt levé';
      else if (s === 'raising') desc = 'est en cours de levage';
      else if (s === 'leve') desc = 'est levé';
      else if (s === 'lowering') desc = 'redescend';
      else desc = 'statut inconnu';
    } else {
      if (s === 'disponible') desc = 'is available';
      else if (s === 'bientot_leve') desc = 'will be lifted soon';
      else if (s === 'raising') desc = 'is raising';
      else if (s === 'leve') desc = 'is lifted';
      else if (s === 'lowering') desc = 'is lowering';
      else desc = 'status unknown';
    }
    parts.push(`${name} ${desc}`);
  }
  const text = parts.join(lang === 'fr' ? '. ' : '. ');
  res.json({ text, gonzague: lastStatus.gonzague, larocque: lastStatus.larocque });
});


app.get('/history', (req, res) => {
  res.set('Cache-Control', 'no-store');
  function getLastLift(bridge) {
    const h = liftHistory[bridge];
    if (!h || h.length === 0) return null;
    const last = h[h.length - 1];
    return last.raisedAt ? new Date(last.raisedAt).toISOString() : null;
  }
  function getOldestLift(bridge) {
    const h = liftHistory[bridge];
    if (!h || h.length === 0) return null;
    const oldest = h[0];
    return oldest.raisedAt ? new Date(oldest.raisedAt).toISOString() : null;
  }
  function getHeatmap(bridge) {
    const h = liftHistory[bridge];
    if (!h || h.length === 0) return {};
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const map = {};
    for (const e of h) {
      if (e.raisedAt && e.raisedAt < cutoff) continue;
      if (e.day === undefined || e.hour === undefined) continue;
      const key = `${e.day}-${e.hour}`;
      map[key] = (map[key] || 0) + 1;
    }
    return map;
  }
  res.json({
    gonzague: { entries: liftHistory.gonzague.length, avgDuration: getAvgLiftDuration('gonzague'), avgLowering: getAvgLoweringDuration('gonzague'), lastLift: getLastLift('gonzague'), oldestLift: getOldestLift('gonzague'), heatmap: getHeatmap('gonzague') },
    larocque: { entries: liftHistory.larocque.length, avgDuration: getAvgLiftDuration('larocque'), avgLowering: getAvgLoweringDuration('larocque'), lastLift: getLastLift('larocque'), oldestLift: getOldestLift('larocque'), heatmap: getHeatmap('larocque') }
  });
});

// ── Milestone push notification ───────────────────────────────────────
app.post('/milestone-notif', async (req, res) => {
  const { endpoint, milestone, lang } = req.body;
  if (!endpoint || !milestone) return res.status(400).json({ error: 'missing params' });

  const sub = subscriptions.find(s => s.endpoint === endpoint);
  if (!sub) return res.status(404).json({ error: 'subscriber not found' });

  const isFr = (lang || sub.lang || 'fr') === 'fr';
  const messages = {
    7:  { fr: { title: '🌉 Une semaine ensemble !', body: 'Ça fait 7 jours que l\'app veille sur vos traversées. Un petit mot ?' },
              en: { title: '🌉 One week together!',  body: 'The app has been watching over your crossings for 7 days. Share a thought?' } },
    30: { fr: { title: '📅 Un mois déjà !',         body: 'Merci de nous faire confiance depuis un mois. Votre avis nous aide à améliorer l\'app.' },
              en: { title: '📅 One month already!',  body: 'Thanks for trusting us for a month. Your feedback helps improve the app.' } },
    90: { fr: { title: '🏅 3 mois de traversées !', body: 'Vous faites partie de nos utilisateurs les plus fidèles. Un immense merci !' },
              en: { title: '🏅 3 months of crossings!', body: 'You\'re one of our most loyal users. Thank you so much!' } }
  };

  const msg = (messages[milestone] || {})[isFr ? 'fr' : 'en'];
  if (!msg) return res.status(400).json({ error: 'invalid milestone' });

  try {
    await webpush.sendNotification(sub, JSON.stringify({
      ...msg,
      tag: `milestone-${milestone}`,
      persistent: false,
      icon: notifIcon(sub)
    }), { urgency: 'high', TTL: 300 });
    umamiTrack('milestone_push_sent', { milestone });
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/subscribers', (req, res) => {
  res.json({ count: subscriptions.length });
});

// ── Busy period advance notifications ────────────────────────────────
// Track which bridge+day combos have already sent a busy alert today
const busyAlertSentToday = { gonzague: null, larocque: null }; // stores date string

function getBusyHoursForBridge(bridge) {
  const h = liftHistory[bridge];
  if (!h || h.length < 5) return [];
  // Count lifts per hour slot
  const counts = {};
  for (const entry of h) {
    counts[entry.hour] = (counts[entry.hour] || 0) + 1;
  }
  // Return hours where count >= 3 OR >= 25% of total
  const threshold = Math.max(3, h.length * 0.15);
  return Object.entries(counts)
    .filter(([, count]) => count >= threshold)
    .map(([hour]) => parseInt(hour));
}

async function checkBusyPeriodAlerts() {
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const currentHour = now.getHours();
  const currentMin = now.getMinutes();

  for (const bridge of ['gonzague', 'larocque']) {
    // Only send once per day per bridge
    if (busyAlertSentToday[bridge] === todayStr) continue;

    const busyHours = getBusyHoursForBridge(bridge);
    if (!busyHours.length) continue;

    // Check if any busy hour starts in ~25-35 min from now
    const inRange = busyHours.some(h => {
      const minsUntil = (h * 60) - (currentHour * 60 + currentMin);
      return minsUntil >= 25 && minsUntil <= 35;
    });

    if (!inRange) continue;

    busyAlertSentToday[bridge] = todayStr;
    log(`🔔 Alerte achalandage [${bridge}] — envoi notifications`);
    umamiTrack('busy_alert_sent', { bridge });

    const bridgeName = { fr: { gonzague: 'Pont St-Louis', larocque: 'Pont Larocque' }, en: { gonzague: 'St-Louis Bridge', larocque: 'Larocque Bridge' } };
    let sent = 0, skipped = 0;

    for (const sub of subscriptions) {
      try {
        const allowedTypes = sub.notifTypes || ['bientot_leve', 'leve', 'outage'];
        if (!allowedTypes.includes('achalandage')) { skipped++; continue; }
        if (sub.bridges && !sub.bridges.includes(bridge)) { skipped++; continue; }

        const lang = sub.lang || 'fr';
        const name = bridgeName[lang]?.[bridge] || bridgeName.fr[bridge];
        const notifIcon = sub.theme === 'gonzaguois' ? '/notification-icon-gonzaguois.png'
          : sub.theme === 'campivallensien' ? '/notification-icon-campivallensien.png'
          : sub.theme === 'stanicois' ? '/notification-icon-stanicois.png'
          : '/notification-icon.png';

        const payload = lang === 'fr'
          ? { title: `⚠️ ${name}`, body: `Période achalandée dans ~30 min`, icon: notifIcon, badge: statusBadge('achalandage'), tag: `pont-busy-${bridge}`, renotify: true }
          : { title: `⚠️ ${name}`, body: `Busy period in ~30 min`, icon: notifIcon, badge: statusBadge('achalandage'), tag: `pont-busy-${bridge}`, renotify: true };

        await webpush.sendNotification(sub, JSON.stringify(payload), { urgency: 'high', TTL: 300 });
        sent++;
      } catch (e) {
        if (e.statusCode === 410) subscriptions = subscriptions.filter(s => s !== sub);
      }
    }
    log(`🔔 Alerte achalandage [${bridge}] — ✅ ${sent} envoyées | ⏭ ${skipped} ignorées`);
  }
}

// Check every 5 minutes
setInterval(checkBusyPeriodAlerts, 5 * 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server started on port ${PORT}`));


async function saveLiftActive() {
  try {
    await redisCommand('set', 'liftActive', JSON.stringify(liftActive));
  } catch(e) { console.error('saveLiftActive error:', e.message); }
}

async function loadLiftActive() {
  try {
    const val = await redisCommand('get', 'liftActive');
    if (val) {
      liftActive = JSON.parse(val);
      const now = Date.now();
      for (const bridge of ['gonzague', 'larocque']) {
        if (liftActive[bridge]) {
          const age = now - liftActive[bridge].raisedAt;
          // If lift has been active for more than 2 hours, it's stale — discard
          if (age > 2 * 60 * 60 * 1000) {
            log('Boot: liftActive [' + bridge + '] trop ancien (' + Math.round(age/60000) + ' min), annulé');
            liftActive[bridge] = null;
          } else {
            log('Boot: liftActive [' + bridge + '] restaure depuis Redis (' + Math.round(age/60000) + ' min)');
          }
        }
      }
    }
  } catch(e) { console.error('loadLiftActive error:', e.message); }
}

async function start() {
  subscriptions = await loadSubscriptions();
  await loadLastStatus();
  await loadLiftHistory();
  await loadLiftActive();
  log(`Ready with ${subscriptions.length} subscriptions — polling every 30s`);
  umamiTrack('subscription_count', { count: subscriptions.length });
  // AIS tracking moved to frontend to avoid Render IP rate limiting
  // startAISTracking();
  await monitor();
  setInterval(monitor, 15000); // 15s to catch short status windows
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
