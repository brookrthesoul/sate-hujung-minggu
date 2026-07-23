// sync.js — Supabase sync (final)
// Supabase is source of truth. IndexedDB is a local cache.
// db.js functions delegate here via window._sb* / window._idbGetAll.

const SUPABASE_URL      = APP_CONFIG.SUPABASE_URL;
const SUPABASE_ANON_KEY = APP_CONFIG.SUPABASE_ANON_KEY;
const TABLE = 'orders';

// ─── Supabase REST ────────────────────────────────────────────────────────────

function _h(extra = {}) {
    return {
        'apikey':        SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type':  'application/json',
        ...extra
    };
}

async function _sbFetch(path, opts = {}) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
        ...opts, headers: _h(opts.headers || {})
    });
    if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
    const t = await res.text();
    return t ? JSON.parse(t) : null;
}

function _rowToOrder(row) {
    return { ...row.data, id: row.id, updatedAt: row.updated_ms };
}

async function _sbGetAll() {
    const rows = await _sbFetch(`${TABLE}?select=id,data,updated_ms&order=id.asc`) || [];
    return rows.map(_rowToOrder);
}

async function _sbInsert(order) {
    const { id: _a, updatedAt: _b, ...data } = order;
    const rows = await _sbFetch(TABLE, {
        method: 'POST',
        headers: { 'Prefer': 'return=representation' },
        body: JSON.stringify({ data, updated_ms: Date.now() })
    });
    const row = Array.isArray(rows) ? rows[0] : rows;
    return _rowToOrder(row);
}

async function _sbUpdate(order) {
    const { id, updatedAt: _a, ...data } = order;
    await _sbFetch(`${TABLE}?id=eq.${id}`, {
        method: 'PATCH',
        headers: { 'Prefer': 'return=minimal' },
        body: JSON.stringify({ data, updated_ms: Date.now() })
    });
}

async function _sbDelete(id) {
    await _sbFetch(`${TABLE}?id=eq.${id}`, { method: 'DELETE' });
}

// ─── IndexedDB cache ──────────────────────────────────────────────────────────

const _IDB_NAME    = 'OrdersDB';
const _IDB_VERSION = 4;  // bumped to add stock store
const _IDB_STORE   = 'orders';
const _IDB_STOCK   = 'stock';
let   _idbConn     = null; // singleton connection

function _idbOpen() {
    if (_idbConn) return Promise.resolve(_idbConn);
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(_IDB_NAME, _IDB_VERSION);
        req.onerror   = () => reject(req.error);
        req.onsuccess = () => { _idbConn = req.result; resolve(_idbConn); };
        req.onupgradeneeded = (ev) => {
            const db = ev.target.result;
            if (db.objectStoreNames.contains(_IDB_STORE)) db.deleteObjectStore(_IDB_STORE);
            db.createObjectStore(_IDB_STORE, { keyPath: 'id' }).createIndex('createdAt','createdAt');
            // Add stock store in v4
            if (!db.objectStoreNames.contains(_IDB_STOCK)) {
                db.createObjectStore(_IDB_STOCK, { keyPath: 'id' });
            }
            if (db.objectStoreNames.contains('syncQueue')) db.deleteObjectStore('syncQueue');
        };
    });
}

async function _idbGetAll() {
    const db = await _idbOpen();
    return new Promise((res, rej) => {
        const req = db.transaction(_IDB_STORE,'readonly').objectStore(_IDB_STORE).getAll();
        req.onsuccess = () => res(req.result);
        req.onerror   = () => rej(req.error);
    });
}

async function _idbPut(order) {
    const db = await _idbOpen();
    return new Promise((res, rej) => {
        const req = db.transaction(_IDB_STORE,'readwrite').objectStore(_IDB_STORE).put(order);
        req.onsuccess = () => res();
        req.onerror   = () => rej(req.error);
    });
}

async function _idbDelete(id) {
    const db = await _idbOpen();
    return new Promise((res, rej) => {
        const req = db.transaction(_IDB_STORE,'readwrite').objectStore(_IDB_STORE).delete(id);
        req.onsuccess = () => res();
        req.onerror   = () => rej(req.error);
    });
}

// Replace local cache with remote data WITHOUT clearing first
// (avoids empty-store race condition during loadOrders)
async function _idbReplaceAll(orders) {
    const db = await _idbOpen();
    return new Promise((res, rej) => {
        const tx    = db.transaction(_IDB_STORE, 'readwrite');
        const store = tx.objectStore(_IDB_STORE);
        tx.oncomplete = () => res();
        tx.onerror    = () => rej(tx.error);
        // Delete all then put all — inside ONE transaction (atomic)
        const clearReq = store.clear();
        clearReq.onsuccess = () => {
            orders.forEach(o => store.put(o));
        };
    });
}

// ─── Sync ─────────────────────────────────────────────────────────────────────

let _syncing  = false;
let _draining = false;

function _rerender() {
    if (typeof loadOrders    === 'function') loadOrders();
    if (typeof loadPreorders === 'function') loadPreorders();
}

async function syncNow() {
    if (_syncing || _draining) return; // don't sync while draining queue
    _syncing = true;
    setSyncStatus('syncing');
    try {
        const remote = await _sbGetAll();
        // Keep offline-only orders (negative IDs not yet pushed to Supabase)
        const localOffline = (await _idbGetAll()).filter(o => o._offline === true);
        await _idbReplaceAll(remote);
        for (const o of localOffline) await _idbPut(o);
        setSyncStatus('ok');
        _rerender();
        showSyncToast('✅ Synced');
    } catch (e) {
        console.error('Sync error:', e);
        setSyncStatus('error');
        showSyncToast('❌ ' + e.message);
    } finally {
        _syncing = false;
    }
}

const pullFromCloud = syncNow;

// ─── Offline queue ────────────────────────────────────────────────────────────

const _offlineQueue = [];

async function _drainOfflineQueue() {
    if (_offlineQueue.length === 0) { await syncNow(); return; }
    _draining = true;
    showSyncToast('🔄 Uploading offline orders...');

    const queue = [..._offlineQueue];
    _offlineQueue.length = 0;

    for (const item of queue) {
        try {
            if (item.op === 'add') {
                const { id: tempId, updatedAt: _a, _deleted: _b, _offline: _c, ...clean } = item.order;
                const saved = await _sbInsert(clean);
                // Swap temp ID for real Supabase ID in IndexedDB
                await _idbDelete(tempId);
                await _idbPut(saved);
            } else if (item.op === 'update') {
                await _sbUpdate(item.order);
            } else if (item.op === 'delete') {
                await _sbDelete(item.id);
            }
        } catch (e) {
            console.error('Queue drain error:', e);
            _offlineQueue.push(item); // retry next time
        }
    }

    _draining = false;
    await syncNow(); // full sync to reconcile all devices
}

// ─── Public CRUD (called by db.js) ───────────────────────────────────────────

window._idbGetAll = _idbGetAll;

window._sbAddOrder = async function(order) {
    const { id: _a, updatedAt: _b, _deleted: _c, ...clean } = order;
    clean.createdAt = clean.createdAt || Date.now();

    if (!navigator.onLine) {
        // Save locally with a temporary negative ID (won't clash with Supabase serial IDs)
        const tempId = -Date.now();
        const tempOrder = { ...clean, id: tempId, _offline: true };
        await _idbPut(tempOrder);
        _offlineQueue.push({ op: 'add', order: tempOrder });
        _pendingSync = true;
        _rerender();
        showSyncToast('📴 Saved offline — will sync when connected');
        return tempId;
    }

    const saved = await _sbInsert(clean);
    await _idbPut(saved);
    _rerender();
    setTimeout(() => syncNow().catch(console.error), 200);
    return saved.id;
};

window._sbUpdateOrder = async function(order) {
    await _idbPut(order);
    _rerender();
    if (navigator.onLine) {
        await _sbUpdate(order);
        setTimeout(() => syncNow().catch(console.error), 200);
    } else {
        _offlineQueue.push({ op: 'update', order });
        _pendingSync = true;
        showSyncToast('📴 Saved offline — will sync when connected');
    }
    return order.id;
};

window._sbDeleteOrder = async function(id) {
    await _idbDelete(id);
    _rerender();
    if (navigator.onLine) {
        await _sbDelete(id);
        setTimeout(() => syncNow().catch(console.error), 200);
    } else {
        // Only queue delete for real IDs (positive = Supabase), not temp offline ones
        if (id > 0) _offlineQueue.push({ op: 'delete', id });
        _pendingSync = true;
        showSyncToast('📴 Deleted offline — will sync when connected');
    }
};

// ─── Online / offline ─────────────────────────────────────────────────────────

let _pendingSync = false;

window.addEventListener('online', async () => {
    updateOnlineBadge(true);
    connectRealtime();
    if (_pendingSync || _offlineQueue.length > 0) {
        _pendingSync = false;
        showSyncToast('🌐 Back online — syncing...');
        await _drainOfflineQueue();
    }
});

window.addEventListener('offline', () => {
    updateOnlineBadge(false);
    setSyncStatus('offline');
    _pendingSync = true;
});

// ─── Polling fallback every 10s ───────────────────────────────────────────────

setInterval(() => {
    if (navigator.onLine && !_syncing && !_draining) syncNow().catch(console.error);
    // Also refresh menu so price/item changes from other devices appear
    if (navigator.onLine && typeof _loadMenuFromSupabase === 'function') {
        _loadMenuFromSupabase().then(remote => {
            if (!remote) return;
            const current = JSON.stringify(getMenuItems());
            const incoming = JSON.stringify(remote);
            if (current !== incoming) {
                // Menu changed on another device — update locally
                menuItems = remote;
                localStorage.setItem('menuItems', JSON.stringify(menuItems));
                if (typeof renderSettingsMenuList === 'function') renderSettingsMenuList();
                if (typeof refreshAfterMenuChange === 'function') refreshAfterMenuChange();
            }
        }).catch(() => {});
    }
}, 10000);

// ─── Realtime WebSocket ───────────────────────────────────────────────────────

let _ws = null, _wsRef = 1, _wsHB = null;

function connectRealtime() {
    if (_ws && (_ws.readyState === WebSocket.OPEN || _ws.readyState === WebSocket.CONNECTING)) return;
    const url = SUPABASE_URL.replace('https://','wss://')
        + `/realtime/v1/websocket?apikey=${SUPABASE_ANON_KEY}&vsn=1.0.0`;
    _ws = new WebSocket(url);

    _ws.onopen = () => {
        // Subscribe to orders table
        _ws.send(JSON.stringify({
            topic: 'realtime:orders-sync', event: 'phx_join',
            payload: { config: {
                broadcast: { self: false }, presence: { key: '' },
                postgres_changes: [{ event: '*', schema: 'public', table: TABLE }]
            }},
            ref: String(_wsRef++)
        }));
        // Subscribe to stock table
        _ws.send(JSON.stringify({
            topic: 'realtime:stock-sync', event: 'phx_join',
            payload: { config: {
                broadcast: { self: false }, presence: { key: '' },
                postgres_changes: [{ event: '*', schema: 'public', table: 'stock' }]
            }},
            ref: String(_wsRef++)
        }));
        _wsHB = setInterval(() => {
            if (_ws.readyState === WebSocket.OPEN)
                _ws.send(JSON.stringify({ topic:'phoenix', event:'heartbeat', payload:{}, ref: String(_wsRef++) }));
        }, 25000);
    };

    _ws.onmessage = ({ data }) => {
        try {
            const f = JSON.parse(data);
            if (f.event === 'phx_reply') return;
            if (f.event === 'postgres_changes' || f.payload?.data?.type) {
                const table = f.payload?.data?.table || f.topic || '';
                if (table.includes('stock')) {
                    // Stock changed on another device — re-sync stock
                    if (typeof window._syncStock === 'function') window._syncStock().catch(console.warn);
                } else {
                    // Orders changed
                    if (!_syncing) syncNow().catch(console.error);
                }
            }
        } catch(_) {}
    };

    _ws.onerror = e => console.warn('WS error', e);
    _ws.onclose = () => {
        clearInterval(_wsHB); _ws = null;
        setTimeout(() => { if (navigator.onLine) connectRealtime(); }, 5000);
    };
}

// ─── Sync Toast Toggle ────────────────────────────────────────────────────────

function isSyncToastEnabled() {
    return localStorage.getItem('syncToastEnabled') !== 'false';
}

function setSyncToastEnabled(val) {
    localStorage.setItem('syncToastEnabled', val ? 'true' : 'false');
    const toggle = document.getElementById('syncToastToggle');
    if (toggle) toggle.checked = val;
    const hint = document.getElementById('syncToastHint');
    if (hint) hint.textContent = val ? '🔔 Sync alerts visible' : '🔕 Sync alerts hidden';
}

// ─── New Order Notification ───────────────────────────────────────────────────

function isOrderNotiEnabled() {
    return localStorage.getItem('orderNotiEnabled') === 'true';
}

const VAPID_PUBLIC_KEY = APP_CONFIG.VAPID_PUBLIC_KEY;

function _urlB64ToUint8(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

async function _getPushSubscription() {
    if (!navigator.serviceWorker) return null;
    const reg = await navigator.serviceWorker.ready;
    return reg.pushManager.getSubscription();
}

async function _getFirebaseToken() {
    // Dynamically load Firebase SDK
    if (!window._firebaseApp) {
        await Promise.all([
            _loadScript('https://www.gstatic.com/firebasejs/9.0.0/firebase-app-compat.js'),
            _loadScript('https://www.gstatic.com/firebasejs/9.0.0/firebase-messaging-compat.js')
        ]);
        window._firebaseApp = firebase.initializeApp(APP_CONFIG.FIREBASE);
    }
    // Tell Firebase to use our existing SW instead of looking for firebase-messaging-sw.js
    const swReg = await navigator.serviceWorker.ready;
    const messaging = firebase.messaging();
    const VAPID_KEY = APP_CONFIG.VAPID_PUBLIC_KEY;
    const token = await messaging.getToken({ vapidKey: VAPID_KEY, serviceWorkerRegistration: swReg });
    console.log('[Push] Firebase token:', token.slice(0, 30) + '...');
    return token;
}

function _loadScript(src) {
    return new Promise((resolve, reject) => {
        if (document.querySelector('script[src="' + src + '"]')) { resolve(); return; }
        const s = document.createElement('script'); s.src = src;
        s.onload = resolve; s.onerror = reject;
        document.head.appendChild(s);
    });
}

async function _subscribePush() {
    // Returns a Firebase token string instead of a PushSubscription object
    const token = await _getFirebaseToken();
    // Wrap in an object with the same interface our save function expects
    return {
        _isFirebase: true,
        _token: token,
        endpoint: 'https://fcm.googleapis.com/fcm/send/' + token,
        getKey: () => null
    };
}

async function _saveSubscriptionToSupabase(sub) {
    let body;
    if (sub._isFirebase) {
        // Firebase token — store with empty keys, edge function uses FCM v1
        body = JSON.stringify({ endpoint: sub.endpoint, keys: { p256dh: '', auth: '' }, firebase_token: sub._token });
        console.log('[Push] saving Firebase token to Supabase...', sub._token.slice(0, 30));
    } else {
        const p256dh = btoa(String.fromCharCode(...new Uint8Array(sub.getKey('p256dh'))));
        const auth   = btoa(String.fromCharCode(...new Uint8Array(sub.getKey('auth'))));
        body = JSON.stringify({ endpoint: sub.endpoint, keys: { p256dh, auth } });
        console.log('[Push] saving subscription to Supabase...', sub.endpoint.slice(0, 60));
    }
    const res = await fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions`, {
        method: 'POST',
        headers: { ..._h(), 'Prefer': 'resolution=merge-duplicates' },
        body
    });
    if (!res.ok) {
        const txt = await res.text();
        throw new Error(`save sub failed ${res.status}: ${txt}`);
    }
    console.log('[Push] subscription saved OK');
}

async function _unsubscribePush() {
    // Delete all subscriptions for this device from Supabase
    // (We don't track the exact endpoint locally anymore with Firebase)
    try {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (sub) { await sub.unsubscribe(); }
    } catch(e) { console.warn('unsubscribe error', e); }
    // Also try to delete via Firebase if available
    if (window._firebaseApp) {
        try {
            const messaging = firebase.messaging();
            await messaging.deleteToken();
        } catch(e) { console.warn('firebase deleteToken error', e); }
    }
}

async function setOrderNotiEnabled(val) {
    const hint   = document.getElementById('orderNotiHint');
    const toggle = document.getElementById('orderNotiToggle');
    if (val) {
        if (hint) hint.textContent = '⏳ Setting up...';
        const granted = await requestNotificationPermission();
        if (!granted) {
            if (hint) hint.textContent = '⚠️ Permission denied — go to Android Settings → Apps → Chrome → Notifications and allow';
            if (toggle) toggle.checked = false;
            localStorage.setItem('orderNotiEnabled', 'false');
            return;
        }
        try {
            if (!navigator.serviceWorker) throw new Error('Service Worker not supported');
            console.log('[Push] getting Firebase token...');
            const sub = await _subscribePush();
            await _saveSubscriptionToSupabase(sub);
            localStorage.setItem('orderNotiEnabled', 'true');
            if (toggle) toggle.checked = true;
            if (hint) hint.textContent = '🔔 Order alerts ON (works when closed)';
        } catch(e) {
            console.error('[Push] subscribe failed', e);
            if (hint) hint.textContent = '❌ Failed: ' + e.message;
            if (toggle) toggle.checked = false;
            localStorage.setItem('orderNotiEnabled', 'false');
        }
    } else {
        await _unsubscribePush().catch(console.warn);
        localStorage.setItem('orderNotiEnabled', 'false');
        if (toggle) toggle.checked = false;
        if (hint) hint.textContent = '🔕 Order alerts OFF';
    }
}

async function requestNotificationPermission() {
    if (!('Notification' in window)) return false;
    if (Notification.permission === 'granted') return true;
    const result = await Notification.requestPermission();
    return result === 'granted';
}

// Beep sound using Web Audio API
function playOrderBeep() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const times = [0, 0.18, 0.36];
        times.forEach(t => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.frequency.value = 880;
            osc.type = 'sine';
            gain.gain.setValueAtTime(0.6, ctx.currentTime + t);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.15);
            osc.start(ctx.currentTime + t);
            osc.stop(ctx.currentTime + t + 0.15);
        });
    } catch(e) { console.warn('Audio error', e); }
}

// Track known order IDs so we only notify on genuinely new ones
let _knownOrderIds = null;

async function _checkForNewOrders(freshOrders) {
    if (!isOrderNotiEnabled()) return;

    // First sync: just record IDs, don't notify
    if (_knownOrderIds === null) {
        _knownOrderIds = new Set(freshOrders.map(o => o.id));
        return;
    }

    const newOrders = freshOrders.filter(o => !_knownOrderIds.has(o.id));
    if (newOrders.length === 0) return;

    newOrders.forEach(o => _knownOrderIds.add(o.id));

    // Build notification message listing sate quantities
    // items is an object: { id: { name, qty, cost, ... } }
    const lines = newOrders.map(o => {
        const items = o.items && typeof o.items === 'object' ? Object.values(o.items) : [];
        const parts = items
            .filter(i => i.qty > 0)
            .map(i => `${i.qty}× ${i.name}`);
        const customerName = o.description || o.customerName || o.name || `Order #${o.id}`;
        return parts.length > 0
            ? `${customerName}: ${parts.join(', ')}`
            : customerName;
    });

    const title = newOrders.length === 1
        ? '🔔 New Order!'
        : `🔔 ${newOrders.length} New Orders!`;
    const body = lines.join('\n');

    playOrderBeep();

    if (Notification.permission === 'granted') {
        // Use SW showNotification — works on Android even when app is foregrounded
        const notiOpts = {
            body,
            icon: './icon-192.png',
            badge: './icon-192.png',
            tag: 'new-order-' + Date.now(),
            requireInteraction: true,
            vibrate: [200, 100, 200, 100, 200]
        };
        if (navigator.serviceWorker) {
            navigator.serviceWorker.ready
                .then(reg => reg.showNotification(title, notiOpts))
                .catch(() => new Notification(title, notiOpts));
        } else {
            new Notification(title, notiOpts);
        }
    }

    // Also show an in-app banner
    showOrderBanner(title, body);
}

function _gotoOrdersTab() {
    const attempt = (tries) => {
        if (typeof switchTab === 'function' && typeof switchOrderSubTab === 'function') {
            switchTab('orders');
            switchOrderSubTab('prepare');
        } else if (tries > 0) {
            setTimeout(() => attempt(tries - 1), 200);
        }
    };
    attempt(20); // retry up to 20x × 200ms = 4 seconds
}

let _bannerTimer = null;
function showOrderBanner(title, body) {
    let b = document.getElementById('orderNotisBanner');
    if (!b) {
        b = document.createElement('div');
        b.id = 'orderNotisBanner';
        document.body.appendChild(b);
    }
    b.innerHTML = `<strong>${title}</strong><br><span style="white-space:pre-line">${body}</span>`;
    b.className = 'order-banner visible';
    clearTimeout(_bannerTimer);
    _bannerTimer = setTimeout(() => { b.className = 'order-banner'; }, 8000);
}

// ─── UI ───────────────────────────────────────────────────────────────────────

function updateOnlineBadge(online) {
    const el = document.getElementById('onlineBadge');
    if (!el) return;
    el.textContent = online ? '🌐 Online' : '📴 Offline';
    el.className   = 'online-badge ' + (online ? 'badge-online' : 'badge-offline');
}

function setSyncStatus(state) {
    const map = {
        ok:      { icon:'✅', text:'Synced',     cls:'sync-ok'      },
        syncing: { icon:'🔄', text:'Syncing…',   cls:'sync-syncing' },
        error:   { icon:'❌', text:'Sync error', cls:'sync-error'   },
        offline: { icon:'📴', text:'Offline',    cls:'sync-offline' },
    };
    const s = map[state] || map.ok;
    ['syncStatus','syncStatusSettings'].forEach(id => {
        const el = document.getElementById(id);
        if (el) { el.innerHTML = `${s.icon} ${s.text}`; el.className = 'sync-status ' + s.cls; }
    });
}

let _toastTimer = null;
function showSyncToast(msg) {
    if (!isSyncToastEnabled()) return;
    let t = document.getElementById('syncToast');
    if (!t) { t = document.createElement('div'); t.id = 'syncToast'; document.body.appendChild(t); }
    t.textContent = msg; t.className = 'sync-toast visible';
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => { t.className = 'sync-toast'; }, 4000);
}

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
    updateOnlineBadge(navigator.onLine);

    // Listen for NEW_ORDER messages from the service worker (background detection)
    if (navigator.serviceWorker) {
        navigator.serviceWorker.addEventListener('message', event => {
            console.log('[Page] SW message received:', event.data);
            if (event.data && event.data.type === 'NEW_ORDER') {
                playOrderBeep();
                showOrderBanner('🔔 New Order!', event.data.body);
            }
            if (event.data && event.data.type === 'GOTO_ORDERS') {
                _gotoOrdersTab();
            }
        });

    // If opened via notification click (?tab=orders), navigate there
    if (new URLSearchParams(window.location.search).get('tab') === 'orders') {
        // Delay to allow all scripts and DOM to fully initialize
        setTimeout(_gotoOrdersTab, 800);
    }
    }

    // Restore toggle states
    setSyncToastEnabled(isSyncToastEnabled());

    // Restore order noti toggle UI — but only re-subscribe if was enabled
    const _wasEnabled = isOrderNotiEnabled();
    const _notiToggle = document.getElementById('orderNotiToggle');
    const _notiHint   = document.getElementById('orderNotiHint');
    if (_notiToggle) _notiToggle.checked = _wasEnabled;
    if (_wasEnabled) {
        if (_notiHint) _notiHint.textContent = '🔔 Order alerts ON (works when closed)';
        // Silently ensure subscription is still valid
        navigator.serviceWorker && navigator.serviceWorker.ready.then(async reg => {
            const sub = await reg.pushManager.getSubscription();
            if (!sub) {
                console.log('[Push] subscription lost, re-subscribing...');
                setOrderNotiEnabled(true);
            } else {
                console.log('[Push] subscription still active');
            }
        }).catch(console.warn);
    } else {
        if (_notiHint) _notiHint.textContent = '🔕 Order alerts OFF';
    }

    if (navigator.onLine) {
        await syncNow();
        connectRealtime();
    } else {
        setSyncStatus('offline');
        _rerender();
    }

    // Sync stock from Supabase
    try {
        if (typeof window._syncStock === 'function') await window._syncStock();
    } catch(e) { console.warn('Stock sync error:', e); }

    // Sync shop status from Supabase
    try {
        const remote = await window._readShopStatus();
        if (remote !== null) {
            localStorage.setItem('shmShopOpen', remote ? '1' : '0');
            if (typeof initShopToggle === 'function') initShopToggle();
        }
    } catch(e) { console.warn('Shop status sync error:', e); }

    // Sync busy threshold from Supabase
    try {
        const threshold = await window._readSetting('notBusyMax');
        if (threshold !== null) {
            localStorage.setItem('shmNotBusyMax', threshold);
            if (typeof initBusyThresholds === 'function') initBusyThresholds();
        }
    } catch(e) { console.warn('Threshold sync error:', e); }

    // Sync business name from Supabase
    try {
        const name = await window._readSetting('businessName');
        if (name) {
            localStorage.setItem('shmBusinessName', name);
            if (typeof initBusinessName === 'function') initBusinessName();
        }
    } catch(e) { console.warn('Business name sync error:', e); }

    // Sync kuah ratio from Supabase
    try {
        const ratio = await window._readSetting('kuahRatio');
        if (ratio) {
            localStorage.setItem('shmKuahRatio', ratio);
            if (typeof initKuahRatio === 'function') initKuahRatio();
        }
    } catch(e) { console.warn('Kuah ratio sync error:', e); }

    // Sync preorder enabled from Supabase
    try {
        const pre = await window._readSetting('preorderEnabled');
        if (pre !== null) {
            localStorage.setItem('shmPreorderEnabled', pre === 'true' ? '1' : '0');
            if (typeof initPreorderToggle === 'function') initPreorderToggle();
        }
    } catch(e) { console.warn('Preorder toggle sync error:', e); }

    // Run day-close check AFTER sync completes — guaranteed fresh data
    try {
        if (typeof autoClosePreviousDay === 'function') {
            await autoClosePreviousDay();
            if (typeof loadOrders === 'function') loadOrders();
        }
    } catch(e) { console.error('Day-close error:', e); }
});


// ─── Generic settings helper ─────────────────────────────────────────────────
window._writeSetting = async function(key, value) {
    try {
        await _sbFetch('settings', {
            method: 'POST',
            headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
            body: JSON.stringify({ key, value })
        });
    } catch(e) { console.warn('Setting write failed (' + key + '):', e); }
};

window._readSetting = async function(key) {
    try {
        const rows = await _sbFetch('settings?key=eq.' + key + '&select=value');
        if (rows && rows.length) return rows[0].value;
    } catch(e) { console.warn('Setting read failed (' + key + '):', e); }
    return null;
};

// ─── Stock sync ───────────────────────────────────────────────────────────────
// Stock is stored in Supabase `stock` table AND in IndexedDB `stockStore`.
// Reads: IDB first (instant), then Supabase (fresh). Writes: both.
// Offline: writes to IDB + queue, pushes to Supabase when back online.

let   _stockQueue      = []; // pending offline writes { id, qty }

// Upgrade IDB to add stock store (bump version)
// Note: We patch _idbOpen below to handle this automatically.

async function _stockIdbGetAll() {
    const db = await _idbOpen();
    return new Promise((res, rej) => {
        const tx  = db.transaction(_IDB_STOCK, 'readonly');
        const req = tx.objectStore(_IDB_STOCK).getAll();
        req.onsuccess = () => res(req.result);
        req.onerror   = () => rej(req.error);
    });
}

async function _stockIdbPutAll(rows) {
    const db = await _idbOpen();
    return new Promise((res, rej) => {
        const tx    = db.transaction(_IDB_STOCK, 'readwrite');
        const store = tx.objectStore(_IDB_STOCK);
        tx.oncomplete = () => res();
        tx.onerror    = () => rej(tx.error);
        rows.forEach(r => store.put(r));
    });
}

async function _stockIdbPut(id, qty) {
    const db = await _idbOpen();
    return new Promise((res, rej) => {
        const tx  = db.transaction(_IDB_STOCK, 'readwrite');
        const req = tx.objectStore(_IDB_STOCK).put({ id, qty });
        req.onsuccess = () => res();
        req.onerror   = () => rej(req.error);
    });
}

// Fetch all stock from Supabase
async function _sbGetStock() {
    try {
        const rows = await _sbFetch('stock?select=id,qty');
        return rows || [];
    } catch(e) {
        console.warn('Stock fetch failed:', e);
        return null;
    }
}

// Push a single stock entry to Supabase (upsert)
async function _sbUpsertStock(id, qty) {
    try {
        await _sbFetch('stock', {
            method: 'POST',
            headers: { 'Prefer': 'resolution=merge-duplicates' },
            body: JSON.stringify({ id, qty, updated_at: new Date().toISOString() })
        });
        return true;
    } catch(e) {
        console.warn('Stock upsert failed:', e);
        return false;
    }
}

// Main stock sync — call on app start and after any stock change
window._syncStock = async function() {
    // 1. Push any queued offline writes first
    if (_stockQueue.length > 0 && navigator.onLine) {
        const queue = [..._stockQueue];
        _stockQueue = [];
        for (const { id, qty } of queue) {
            const ok = await _sbUpsertStock(id, qty);
            if (!ok) _stockQueue.push({ id, qty }); // re-queue if failed
        }
    }

    // 2. Fetch fresh from Supabase if online
    if (navigator.onLine) {
        const rows = await _sbGetStock();
        if (rows && rows.length > 0) {
            await _stockIdbPutAll(rows);
            // Convert to { id: qty } object — qty of -1 means no limit (skip it)
            const stock = {};
            rows.forEach(r => {
                if (r.qty === -1) return; // -1 = no limit, don't add to stock object
                stock[r.id] = r.qty;
            });
            localStorage.setItem('shmStock', JSON.stringify(stock));
            if (typeof updateStockIndicators === 'function') updateStockIndicators();
            if (typeof renderStockManager    === 'function') {
                const mgr = document.getElementById('stockManagerList');
                if (mgr && mgr.children.length > 0) renderStockManager();
            }
        }
    }
};

// Write stock for one item — online: Supabase + IDB + localStorage. Offline: IDB + localStorage + queue.
window._writeStock = async function(id, qty) {
    // Always update local immediately
    const stock = JSON.parse(localStorage.getItem('shmStock') || '{}');
    stock[id]   = qty;
    localStorage.setItem('shmStock', JSON.stringify(stock));
    await _stockIdbPut(id, qty);
    if (typeof updateStockIndicators === 'function') updateStockIndicators();

    // Push to Supabase or queue
    if (navigator.onLine) {
        const ok = await _sbUpsertStock(id, qty);
        if (!ok) _stockQueue.push({ id, qty });
    } else {
        _stockQueue.push({ id, qty });
    }
};


// ─── Shop status sync ─────────────────────────────────────────────────────────
// Stored as a single row in Supabase 'settings' table: { key: 'shopOpen', value: 'true'/'false' }

window._writeShopStatus = async function(isOpen) {
    try {
        await _sbFetch('settings', {
            method: 'POST',
            headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
            body: JSON.stringify({ key: 'shopOpen', value: isOpen ? 'true' : 'false' })
        });
    } catch(e) { console.warn('Shop status sync failed:', e); }
};

window._readShopStatus = async function() {
    try {
        const rows = await _sbFetch('settings?key=eq.shopOpen&select=value');
        if (rows && rows.length) return rows[0].value === 'true';
    } catch(e) { console.warn('Shop status read failed:', e); }
    return null; // null = not set, treat as open
};

// ─── Reset all orders ─────────────────────────────────────────────────────────
// Deletes all orders from Supabase + IndexedDB and resets the ID sequence to 1.
// Stock, menu, and prices are kept untouched.
window._resetAllOrders = async function() {
    // 1. Delete all rows from orders table
    const delRes = await fetch(`${SUPABASE_URL}/rest/v1/orders?id=gte.0`, {
        method: 'DELETE',
        headers: {
            'apikey': SUPABASE_ANON_KEY,
            'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal'
        }
    });
    if (!delRes.ok && delRes.status !== 404) {
        const err = await delRes.text();
        throw new Error('Delete failed: ' + err);
    }

    // 2. Reset the auto-increment sequence back to 1 via Supabase RPC
    await fetch(`${SUPABASE_URL}/rest/v1/rpc/reset_orders_sequence`, {
        method: 'POST',
        headers: {
            'apikey': SUPABASE_ANON_KEY,
            'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({})
    });

    // 3. Clear IndexedDB
    await _idbReplaceAll([]);

    // 4. Re-render
    if (typeof loadOrders === 'function') loadOrders();
};
