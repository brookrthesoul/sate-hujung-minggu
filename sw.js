const CACHE_NAME = 'order-pwa-v3';

const urlsToCache = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  'https://cdn.jsdelivr.net/npm/@point-of-sale/webbluetooth-receipt-printer@2.0.0/dist/webbluetooth-receipt-printer.umd.js',
  'https://cdn.jsdelivr.net/npm/@point-of-sale/receipt-printer-encoder@2.0.0/dist/receipt-printer-encoder.umd.js'
];

// Install
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(urlsToCache))
  );
  self.skipWaiting();
});

// Activate
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(names =>
      Promise.all(
        names.map(name => {
          if (name !== CACHE_NAME) return caches.delete(name);
        })
      )
    )
  );
  self.clients.claim();
});

// Fetch
self.addEventListener('fetch', event => {
  const req = event.request;

  if (req.method !== 'GET') return;
  if (!req.url.startsWith(self.location.origin)) return;

  event.respondWith(
    caches.match(req)
      .then(res => {
        return res || fetch(req).then(fetchRes => {
          if (!fetchRes || fetchRes.status !== 200) return fetchRes;

          const clone = fetchRes.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(req, clone));

          return fetchRes;
        });
      })
      .catch(() => caches.match('/index.html'))
  );
});
