// SW v1.2.0 — single persistent widget notification + static asset caching

// ─── Cache ──────────────────────────────────────────────────────────────
// Bump this version on every deploy that changes images, icons, CSS or JS:
// the new service worker then deletes the old cache and re-downloads them.
const CACHE_VERSION = 'v1';
const STATIC_CACHE = 'static-' + CACHE_VERSION;
const PAGES_CACHE = 'pages-' + CACHE_VERSION;

// Files served cache-first (one download, then zero network requests)
const STATIC_EXT = /\.(?:png|jpe?g|gif|webp|avif|svg|ico|css|js|woff2?|ttf|otf|json|webmanifest)$/i;

// Never touched by the service worker
const BYPASS_PATHS = ['/sw.js', '/visitor-ping', '/_vercel/'];

self.addEventListener('install', event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(key => key !== STATIC_CACHE && key !== PAGES_CACHE)
          .map(key => caches.delete(key))
      ))
      .then(() => clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Same origin only: Render backend, SSE, Umami, GitHub, BMC go straight to the network
  if (url.origin !== self.location.origin) return;
  if (BYPASS_PATHS.some(p => url.pathname.startsWith(p))) return;

  // HTML pages: network-first (always fresh), cache as offline fallback
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then(res => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(PAGES_CACHE).then(cache => cache.put(req, copy));
          }
          return res;
        })
        .catch(() =>
          caches.match(req, { ignoreSearch: true })
            .then(cached => cached || caches.match('/', { ignoreSearch: true }))
        )
    );
    return;
  }

  // Static assets: cache-first
  if (STATIC_EXT.test(url.pathname)) {
    event.respondWith(
      caches.open(STATIC_CACHE).then(cache =>
        cache.match(req).then(cached => {
          if (cached) return cached;
          return fetch(req).then(res => {
            if (res.ok && res.type === 'basic') cache.put(req, res.clone());
            return res;
          });
        })
      )
    );
  }
});

// ─── Push ───────────────────────────────────────────────────────────────
self.addEventListener('push', function(event) {
  const data = event.data ? event.data.json() : {};

  event.waitUntil(
    self.registration.showNotification(data.title || 'Welland Canal Bridges', {
      body: data.body || '',
      icon: data.icon || '/icon-192.png',
      badge: data.badge || '/icon-192.png',
      tag: 'wcb-widget',
      renotify: false,
      requireInteraction: false,
      silent: false,
      vibrate: [],
    })
  );
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  event.waitUntil(clients.openWindow('/'));
});
