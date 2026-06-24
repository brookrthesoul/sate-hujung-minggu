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

let _syncing = false;

function _rerender() {
    if (typeof loadOrders === 'function') loadOrders();
}

async function syncNow() {
    if (_syncing) return;
    _syncing = true;
    setSyncStatus('syncing');
    try {
        const remote = await _sbGetAll();
        await _idbReplaceAll(remote);   // atomic — no gap where store is empty
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

// ─── Public CRUD (called by db.js) ───────────────────────────────────────────

window._idbGetAll = _idbGetAll;

window._sbAddOrder = async function(order) {
    const { id: _a, updatedAt: _b, _deleted: _c, ...clean } = order;
    clean.createdAt = clean.createdAt || Date.now();
    if (!navigator.onLine) throw new Error('You are offline. Connect to save orders.');
    const saved = await _sbInsert(clean);
    await _idbPut(saved);
    _rerender();
    // background sync so other devices get it
    setTimeout(() => syncNow().catch(console.error), 200);
    return saved.id;
};

window._sbUpdateOrder = async function(order) {
    if (navigator.onLine) {
        await _sbUpdate(order);
        await _idbPut(order);
        setTimeout(() => syncNow().catch(console.error), 200);
    } else {
        await _idbPut(order);
    }
    _rerender();
    return order.id;
};

window._sbDeleteOrder = async function(id) {
    await _idbDelete(id);   // remove locally first so UI is instant
    _rerender();
    if (navigator.onLine) {
        await _sbDelete(id);
        setTimeout(() => syncNow().catch(console.error), 200);
    }
};

// ─── Online / offline ─────────────────────────────────────────────────────────

let _pendingSync = false;

window.addEventListener('online', () => {
    updateOnlineBadge(true);
    connectRealtime();
    if (_pendingSync) { _pendingSync = false; syncNow().catch(console.error); }
});

window.addEventListener('offline', () => {
    updateOnlineBadge(false);
    setSyncStatus('offline');
    _pendingSync = true;
});

// ─── Polling fallback every 10s ───────────────────────────────────────────────

setInterval(() => {
    if (navigator.onLine && !_syncing) syncNow().catch(console.error);
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
    let t = document.getElementById('syncToast');
    if (!t) { t = document.createElement('div'); t.id = 'syncToast'; document.body.appendChild(t); }
    t.textContent = msg; t.className = 'sync-toast visible';
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => { t.className = 'sync-toast'; }, 4000);
}

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
    updateOnlineBadge(navigator.onLine);
    if (navigator.onLine) {
        await syncNow();
        connectRealtime();
    } else {
        setSyncStatus('offline');
        _rerender();
    }
});
