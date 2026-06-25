const CACHE_NAME = 'order-pwa-v17';

const STATIC_CACHE = [
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './style.css',
];

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_CACHE))
  );
});

self.addEventListener('activate', event => {
  console.log('[SW] activating version:', CACHE_NAME);
  event.waitUntil(
    caches.keys()
      .then(names => Promise.all(names.map(n => n !== CACHE_NAME && caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Only handle same-origin requests — never intercept API calls to supabase.co etc.
  if (url.origin !== self.location.origin) return;

  if (url.protocol !== 'https:' && url.protocol !== 'http:') return;
  if (event.request.method !== 'GET') return;

  // JS and HTML: always network-first so deploys are instant
  if (url.pathname.endsWith('.js') || url.pathname.endsWith('.html') || url.pathname.endsWith('/')) {
    event.respondWith(
      fetch(event.request).catch(() => caches.match(event.request))
    );
    return;
  }

  // Static assets (icons, CSS, manifest): cache-first
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(res => {
        if (res && res.status === 200) {
          const toCache = res.clone(); // clone BEFORE returning
          caches.open(CACHE_NAME).then(c => c.put(event.request, toCache));
        }
        return res;
      });
    })
  );
});


// ─── Web Push (real background notifications) ─────────────────────────────────

self.addEventListener('push', event => {
  console.log('[SW] push event fired!', event.data ? 'has data' : 'no data');
  if (!event.data) return;
  let payload;
  try { payload = event.data.json(); } catch(e) { payload = { title: '🍢 New Order!', body: event.data.text() }; }

  const title = payload.title || '🍢 New Order!';
  const body  = payload.body  || '';
  const opts = {
    body,
    icon:            './icon-192.png',
    badge:           './icon-192.png',
    tag:             payload.tag || 'new-order',
    requireInteraction: true,
    vibrate:         [200, 100, 200, 100, 200],
    data:            { url: self.registration.scope }
  };

  event.waitUntil(
    Promise.all([
      // Show system notification (works when app closed)
      self.registration.showNotification(title, opts),
      // Notify open tabs to play beep + banner
      self.clients.matchAll({ includeUncontrolled: true, type: 'window' })
        .then(clients => {
          console.log('[SW] push received, open clients:', clients.length);
          clients.forEach(c => c.postMessage({ type: 'NEW_ORDER', body }));
        })
    ])
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = event.notification.data?.url || self.registration.scope;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      const match = clients.find(c => c.url.startsWith(self.registration.scope) && 'focus' in c);
      if (match) return match.focus();
      if (self.clients.openWindow) return self.clients.openWindow(target);
    })
  );
});
