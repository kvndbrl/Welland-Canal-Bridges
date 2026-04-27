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
  const title = data.title || 'Ponts Beauharnois';
  const tag = data.tag || ('pont-' + (data.bridge || 'gonzague'));

  const status = data.status || detectStatus(data);
  const isAvailable = status === 'disponible';

  const vibrate = VIBRATION_PATTERNS[status] || VIBRATION_PATTERNS.scheduled;

  const options = {
    body: data.body || '',
    icon: data.icon || '/notification-icon.png',
    badge: data.badge || '/notification-icon.png',
    tag: tag,
    renotify: true,
    requireInteraction: !isAvailable,
    silent: isAvailable,
    vibrate: isAvailable ? [200] : vibrate,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

function detectStatus(data) {
  const body = (data.body || '').toLowerCase();
  const title = (data.title || '').toLowerCase();
  if (body.includes('bient\u00f4t lev\u00e9') || body.includes('lift soon') || body.includes('pr\u00e9voir un d\u00e9lai')) return 'bientot_leve';
  if (body.includes('en cours de levage') || body.includes('raising')) return 'raising';
  if (body.includes('pont lev\u00e9') || body.includes('bridge lifted') || body.includes('lev\u00e9 \u00b7')) return 'leve';
  if (body.includes('redescend') || body.includes('lowering')) return 'lowering';
  if (body.includes('circulation normale') || body.includes('traffic normal')) return 'disponible';
  if (body.includes('lev\u00e9e pr\u00e9vue') || body.includes('scheduled') || body.includes('lift scheduled') || title.includes('\ud83d\udcc5')) return 'scheduled';
  if (body.includes('fermeture') || body.includes('closure')) return 'outage';
  if (body.includes('achaland\u00e9e') || body.includes('busy period')) return 'achalandage';
  return 'scheduled';
}

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  event.waitUntil(clients.openWindow('/'));
});
