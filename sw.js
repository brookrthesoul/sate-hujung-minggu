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

const CACHE_NAME = 'order-pwa-v29';

// The full app shell — precached on install so the app works offline even on
// the very first load after install (previously this list only had 3 files,
// which is the main reason offline wasn't working: index.html and every JS/CSS
// file were never being stored anywhere for the browser to fall back to).
const STATIC_CACHE = [
  './',
  './index.html',
  './order.html',
  './style.css',
  './config.js',
  './stock.js',
  './sync.js',
  './menu.js',
  './info.js',
  './policies.js',
  './db.js',
  './orders.js',
  './ratio.js',
  './printer.js',
  './app.js',
  './sw-register.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
];

// A few third-party library scripts the admin app depends on (PDF export,
// Bluetooth receipt printing). These are cross-origin, so they're precached
// explicitly here — the fetch handler below otherwise ignores cross-origin
// requests entirely (that's intentional, so Supabase/Firebase API calls are
// never cached or served stale).
const CDN_CACHE = [
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  'https://cdn.jsdelivr.net/npm/@point-of-sale/receipt-printer-encoder/dist/receipt-printer-encoder.umd.js',
  'https://cdn.jsdelivr.net/npm/@point-of-sale/webbluetooth-receipt-printer/dist/webbluetooth-receipt-printer.umd.js',
];

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      // addAll() fails the whole batch if any single request fails — CDN
      // scripts are more likely to hiccup than same-origin files, so cache
      // them separately and don't let a CDN failure block the app shell
      // (which is the part that actually matters for the app to load offline).
      cache.addAll(STATIC_CACHE).then(() =>
        Promise.all(CDN_CACHE.map(url =>
          cache.add(url).catch(err => console.warn('[SW] could not precache', url, err))
        ))
      )
    )
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

  if (url.protocol !== 'https:' && url.protocol !== 'http:') return;
  if (event.request.method !== 'GET') return;

  // Cross-origin: only handle the specific whitelisted CDN library scripts
  // (cache-first, since library code at a pinned version never changes).
  // Everything else cross-origin (Supabase, Firebase, etc.) is left alone —
  // those must always go to the network for live data.
  if (url.origin !== self.location.origin) {
    if (CDN_CACHE.includes(event.request.url)) {
      event.respondWith(
        caches.match(event.request).then(cached => cached || fetch(event.request).then(res => {
          if (res && res.status === 200) {
            const toCache = res.clone();
            caches.open(CACHE_NAME).then(c => c.put(event.request, toCache));
          }
          return res;
        }))
      );
    }
    return;
  }

  // JS, HTML, CSS: network-first so deploys are instant when online — but
  // every successful response is ALSO written to the cache, so there's
  // something to fall back to the next time the device is offline. (This
  // write-back was missing before, which is why offline never actually
  // worked even after browsing the site while online.)
  if (url.pathname.endsWith('.js') || url.pathname.endsWith('.html') ||
      url.pathname.endsWith('.css') || url.pathname.endsWith('/')) {
    event.respondWith(
      fetch(event.request).then(res => {
        if (res && res.status === 200) {
          const toCache = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(event.request, toCache));
        }
        return res;
      }).catch(() => caches.match(event.request).then(cached => cached || caches.match('./index.html')))
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
