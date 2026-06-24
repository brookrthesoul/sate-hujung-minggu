// sync.js — Supabase sync (final)
// Supabase is source of truth. IndexedDB is a local cache.
// db.js functions delegate here via window._sb* / window._idbGetAll.

const SUPABASE_URL      = 'https://efrwvksxttauhoxllhqu.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_SOoDs65SPw_G_m-lZ6NP-w_MbbqxOUw';
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
const _IDB_VERSION = 3;
const _IDB_STORE   = 'orders';
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
    if (typeof loadOrders === 'function') loadOrders();
}

async function syncNow() {
    if (_syncing || _draining) return; // don't sync while draining queue
    _syncing = true;
    setSyncStatus('syncing');
    try {
        const remote = await _sbGetAll();
        // Keep offline-only orders (negative IDs not yet pushed to Supabase)
        const localOffline = (await _idbGetAll()).filter(o => o._offline === true);
        try { await _checkForNewOrders(remote); } catch(e) { console.warn('Order noti error:', e); }
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
        _ws.send(JSON.stringify({
            topic: 'realtime:orders-sync', event: 'phx_join',
            payload: { config: {
                broadcast: { self: false }, presence: { key: '' },
                postgres_changes: [{ event: '*', schema: 'public', table: TABLE }]
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
                if (!_syncing) syncNow().catch(console.error);
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

function setOrderNotiEnabled(val) {
    localStorage.setItem('orderNotiEnabled', val ? 'true' : 'false');
    const toggle = document.getElementById('orderNotiToggle');
    if (toggle) toggle.checked = val;
    const hint = document.getElementById('orderNotiHint');
    if (val) {
        requestNotificationPermission().then(granted => {
            if (hint) hint.textContent = granted ? '🔔 Kitchen alerts ON' : '⚠️ Permission denied — check browser settings';
            if (!granted) setOrderNotiEnabled(false);
        });
    } else {
        if (hint) hint.textContent = '🔕 Kitchen alerts OFF';
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
        ? '🍢 New Order!'
        : `🍢 ${newOrders.length} New Orders!`;
    const body = lines.join('\n');

    playOrderBeep();

    if (Notification.permission === 'granted') {
        new Notification(title, {
            body,
            icon: './icon-192.png',
            badge: './icon-192.png',
            tag: 'new-order-' + Date.now(),
            requireInteraction: true
        });
    }

    // Also show an in-app banner
    showOrderBanner(title, body);
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

    // Restore toggle states
    setSyncToastEnabled(isSyncToastEnabled());
    setOrderNotiEnabled(isOrderNotiEnabled());

    if (navigator.onLine) {
        await syncNow();
        connectRealtime();
    } else {
        setSyncStatus('offline');
        _rerender();
    }
});
