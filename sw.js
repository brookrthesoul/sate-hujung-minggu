importScripts('./config.js');
importScripts('https://www.gstatic.com/firebasejs/9.0.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.0.0/firebase-messaging-compat.js');

firebase.initializeApp(APP_CONFIG.FIREBASE);

const messaging = firebase.messaging();

// Handle background messages via Firebase
messaging.onBackgroundMessage(payload => {
  console.log('[SW] Firebase background message:', payload);
  const title = payload.notification?.title || payload.data?.title || '🔔 New Order!';
  const body  = payload.notification?.body  || payload.data?.body  || '';
  const tag   = payload.data?.tag || 'new-order';
  return self.registration.showNotification(title, {
    body,
    icon:  '/sate-hujung-minggu/icon-192.png',
    badge: '/sate-hujung-minggu/icon-192.png',
    tag,
    requireInteraction: true,
    vibrate: [200, 100, 200, 100, 200],
    data: { url: self.registration.scope }
  }).then(() => {
    return self.clients.matchAll({ includeUncontrolled: true, type: 'window' })
      .then(clients => clients.forEach(c => c.postMessage({ type: 'NEW_ORDER', body })));
  });
});

const CACHE_NAME = 'order-pwa-v28';

const STATIC_CACHE = [
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
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

  // JS, HTML, CSS: always network-first so deploys are instant
  if (url.pathname.endsWith('.js') || url.pathname.endsWith('.html') ||
      url.pathname.endsWith('.css') || url.pathname.endsWith('/')) {
    event.respondWith(
      fetch(event.request).catch(() => caches.match(event.request))
    );
    return;
  }

  // Static assets (icons, manifest): cache-first
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(res => {
        if (res && res.status === 200) {
          const toCache = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(event.request, toCache));
        }
        return res;
      });
    })
  );
});


// ─── Web Push (real background notifications) ─────────────────────────────────

self.addEventListener('push', event => {
  console.log('[SW] *** PUSH EVENT FIRED ***');

  // Always show a notification - required for push events
  const title = '🔔 New Order!';
  let body = 'A new order has been placed';

  if (event.data) {
    try {
      const payload = event.data.json();
      body = payload.body || body;
    } catch(e) {
      try { body = event.data.text() || body; } catch(_) {}
    }
  }

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon:  '/sate-hujung-minggu/icon-192.png',
      badge: '/sate-hujung-minggu/icon-192.png',
      tag:   'new-order-' + Date.now(),
      requireInteraction: true,
      vibrate: [200, 100, 200, 100, 200],
    }).then(() => {
      console.log('[SW] notification shown');
      return self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
    }).then(clients => {
      console.log('[SW] notifying', clients.length, 'open clients');
      clients.forEach(c => c.postMessage({ type: 'NEW_ORDER', body }));
    }).catch(e => console.error('[SW] push handler error:', e))
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const scope = self.registration.scope;
  const target = scope + '?tab=orders';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      const match = clients.find(c => c.url.startsWith(scope) && 'focus' in c);
      if (match) {
        // App is open — focus it and tell it to go to orders tab
        match.postMessage({ type: 'GOTO_ORDERS' });
        return match.focus();
      }
      // App is closed — open it with ?tab=orders so it can navigate on load
      if (self.clients.openWindow) return self.clients.openWindow(target);
    })
  );
});
