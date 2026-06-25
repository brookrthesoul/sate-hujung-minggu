const CACHE_NAME = 'order-pwa-v13';

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


// ─── Background Push via Supabase Realtime ────────────────────────────────────
// This runs inside the SW so notifications fire even when the app is closed.

const SW_SUPABASE_URL      = 'https://efrwvksxttauhoxllhqu.supabase.co';
const SW_SUPABASE_ANON_KEY = 'sb_publishable_SOoDs65SPw_G_m-lZ6NP-w_MbbqxOUw';
const SW_TABLE             = 'orders';

let _swWs = null, _swWsRef = 1, _swWsHB = null;
let _swKnownIds = null;   // null = first load, don't notify yet
let _swOrderNotiEnabled = false;

// The main app tells us the setting via postMessage
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') { self.skipWaiting(); return; }
  if (event.data && event.data.type === 'ORDER_NOTI_SETTING') {
    _swOrderNotiEnabled = event.data.enabled;
    if (_swOrderNotiEnabled) {
      _swConnectRealtime();
    } else {
      _swDisconnect();
    }
  }
});

function _swDisconnect() {
  clearInterval(_swWsHB);
  if (_swWs) { try { _swWs.close(); } catch(_) {} _swWs = null; }
}

function _swConnectRealtime() {
  if (_swWs && (_swWs.readyState === 0 || _swWs.readyState === 1)) return;
  const url = SW_SUPABASE_URL.replace('https://', 'wss://')
    + `/realtime/v1/websocket?apikey=${SW_SUPABASE_ANON_KEY}&vsn=1.0.0`;
  _swWs = new WebSocket(url);

  _swWs.onopen = () => {
    _swWs.send(JSON.stringify({
      topic: 'realtime:sw-orders', event: 'phx_join',
      payload: { config: {
        broadcast: { self: false }, presence: { key: '' },
        postgres_changes: [{ event: 'INSERT', schema: 'public', table: SW_TABLE }]
      }},
      ref: String(_swWsRef++)
    }));
    _swWsHB = setInterval(() => {
      if (_swWs && _swWs.readyState === 1)
        _swWs.send(JSON.stringify({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: String(_swWsRef++) }));
    }, 25000);
  };

  _swWs.onmessage = ({ data }) => {
    try {
      const f = JSON.parse(data);
      const record = f.payload?.data?.record;
      if (!record) return;

      // First connect: just seed known IDs, don't notify
      if (_swKnownIds === null) { _swKnownIds = new Set([record.id]); return; }
      if (_swKnownIds.has(record.id)) return;
      _swKnownIds.add(record.id);

      if (!_swOrderNotiEnabled) return;

      // Parse order data
      const orderData = record.data || {};
      const items = orderData.items && typeof orderData.items === 'object'
        ? Object.values(orderData.items) : [];
      const parts = items.filter(i => i.qty > 0).map(i => `${i.qty}\u00d7 ${i.name}`);
      const label = orderData.description || `Order #${record.id}`;
      const body  = parts.length > 0 ? `${label}: ${parts.join(', ')}` : label;

      self.registration.showNotification('\uD83C\uDF62 New Order!', {
        body,
        icon: './icon-192.png',
        badge: './icon-192.png',
        tag: 'new-order-' + record.id,
        requireInteraction: true,
        vibrate: [200, 100, 200, 100, 200],
        data: { url: self.registration.scope }
      });

      // Tell all open clients to play beep + show in-app banner
      self.clients.matchAll({ includeUncontrolled: true, type: 'window' }).then(clients => {
        clients.forEach(c => c.postMessage({ type: 'NEW_ORDER', body }));
      });
    } catch(e) { console.warn('[SW] realtime parse error', e); }
  };

  _swWs.onerror = e => console.warn('[SW] WS error', e);
  _swWs.onclose = () => {
    clearInterval(_swWsHB); _swWs = null;
    // Reconnect after 5 s if still enabled
    if (_swOrderNotiEnabled) setTimeout(_swConnectRealtime, 5000);
  };
}

// Tap notification → open/focus the app
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
