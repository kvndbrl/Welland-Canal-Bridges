// Nautical vibration patterns inspired by maritime signaling
const VIBRATION_PATTERNS = {
  bientot_leve: [200,100,200,100,200],        // 3 short — warning signal
  raising:      [500,100,200,100,200],         // 1 long + 2 short — maneuver signal
  leve:         [600,200,600],                 // 2 long — vessel in transit
  lowering:     [300,100,200,100,100],         // decreasing — end of maneuver
  disponible:   [800],                         // 1 long — all clear
  scheduled:    [200,100,200],                 // 2 short — announcement
  outage:       [500,100,500,100,500],         // 3 long — danger signal
  achalandage:  [100,100,100,100,100,100,100], // 4 short rapid — alert
};

self.addEventListener('push', function(event) {
  const data = event.data ? event.data.json() : {};
  const title = data.title || 'Welland Canal Bridges';
  const tag = data.tag || ('wcb-' + (data.bridge || 'lakeshore'));

  const status = data.status || detectStatus(data);
  const isAvailable = status === 'disponible';

  const vibrate = VIBRATION_PATTERNS[status] || VIBRATION_PATTERNS.scheduled;

  const options = {
    body: data.body || '',
    icon: data.icon || '/icon-192.png',
    badge: data.badge || '/icon-192.png',
    tag: tag,
    renotify: true,
    requireInteraction: false,
    silent: false,
    vibrate: isAvailable ? [800] : vibrate,
    // Force high priority to show on locked screen (Android)
    priority: 'high',
    importance: 'high',
    visibility: 'public',
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

function detectStatus(data) {
  const body = (data.body || '').toLowerCase();
  const title = (data.title || '').toLowerCase();
  if (body.includes('lifting soon') || body.includes('rising soon') || body.includes('expect delays')) return 'bientot_leve';
  if (body.includes('bridge lifting') || body.includes('span rising') || body.includes('raising')) return 'raising';
  if (body.includes('bridge lifted') || body.includes('span raised') || body.includes('lifted')) return 'leve';
  if (body.includes('lowering') || body.includes('opening soon')) return 'lowering';
  if (body.includes('traffic normal') || body.includes('available')) return 'disponible';
  if (body.includes('scheduled') || body.includes('lift scheduled')) return 'scheduled';
  if (body.includes('closure') || body.includes('closed')) return 'outage';
  if (body.includes('busy period')) return 'achalandage';
  return 'scheduled';
}

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  event.waitUntil(clients.openWindow('/'));
});
