const CACHE_NAME = 'order-pwa-v10';

const urlsToCache = [
  './',
  './index.html',
  './style.css',
  './menu.js',
  './db.js',
  './orders.js',
  './ratio.js',
  './printer.js',
  './app.js',
  './sw-register.js',
  './sync.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
];

// Install
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async cache => {
      for (const url of urlsToCache) {
        try {
          await cache.add(url);
        } catch (err) {
          console.warn('❌ Failed to cache:', url);
        }
      }
    })
  );
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

// Lets the page tell a waiting (new) service worker to activate right away,
// instead of waiting for every open tab/installed-app instance to fully close.
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// Fetch
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // ✅ VERY IMPORTANT (fix your error)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return;
  }

  // ✅ Also recommended
  if (event.request.method !== 'GET') {
    return;
  }

  event.respondWith(
    caches.match(event.request).then(response => {
      if (response) return response;

      return fetch(event.request).then(networkResponse => {
        if (!networkResponse || networkResponse.status !== 200) {
          return networkResponse;
        }

        const clone = networkResponse.clone();

        caches.open(CACHE_NAME).then(cache => {
          cache.put(event.request, clone).catch(() => {});
        });

        return networkResponse;
      });
    })
  );
});
