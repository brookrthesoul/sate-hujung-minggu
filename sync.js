// sync.js — two‑way sync with offline support

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
    return { ...row.data, id: row.id, updatedAt: row.updated_ms, _synced: true };
}

async function _sbGetAll() {
    const rows = await _sbFetch(`${TABLE}?select=id,data,updated_ms&order=id.asc`) || [];
    return rows.map(_rowToOrder);
}

// Upsert (insert or update) by ID
async function _sbUpsert(order) {
    const { id, updatedAt, _synced, ...data } = order;
    await _sbFetch(`${TABLE}?id=eq.${id}`, {
        method: 'PATCH',
        headers: { 'Prefer': 'return=minimal' },
        body: JSON.stringify({
            data,
            updated_ms: Date.now()
        })
    });
}

async function _sbDelete(id) {
    await _sbFetch(`${TABLE}?id=eq.${id}`, { method: 'DELETE' });
}

// ─── IndexedDB cache ──────────────────────────────────────────────────────────

const _IDB_NAME    = 'OrdersDB';
const _IDB_VERSION = 4;   // increment to add new index if needed
const _IDB_STORE   = 'orders';
let   _idbConn     = null;

function _idbOpen() {
    if (_idbConn) return Promise.resolve(_idbConn);
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(_IDB_NAME, _IDB_VERSION);
        req.onerror   = () => reject(req.error);
        req.onsuccess = () => { _idbConn = req.result; resolve(_idbConn); };
        req.onupgradeneeded = (ev) => {
            const db = ev.target.result;
            if (db.objectStoreNames.contains(_IDB_STORE)) db.deleteObjectStore(_IDB_STORE);
            db.createObjectStore(_IDB_STORE, { keyPath: 'id' });
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

// ─── Public CRUD ──────────────────────────────────────────────────────────────

window._idbGetAll = _idbGetAll;

window._sbAddOrder = async function(order) {
    const { id: _a, updatedAt: _b, _synced: _c, ...clean } = order;
    clean.createdAt = clean.createdAt || Date.now();
    clean.id = clean.id || crypto.randomUUID();   // generate unique ID

    const localOrder = { ...clean, _synced: false, updatedAt: Date.now() };
    await _idbPut(localOrder);
    _rerender();

    if (navigator.onLine) {
        try {
            await _sbUpsert(localOrder);
            await _idbPut({ ...localOrder, _synced: true });
        } catch (e) {
            console.warn('Push failed, will retry later', e);
        }
    }
    return localOrder.id;
};

window._sbUpdateOrder = async function(order) {
    const updated = { ...order, updatedAt: Date.now(), _synced: false };
    await _idbPut(updated);
    _rerender();
    if (navigator.onLine) {
        try {
            await _sbUpsert(updated);
            await _idbPut({ ...updated, _synced: true });
        } catch (e) { /* retry later */ }
    }
};

window._sbDeleteOrder = async function(id) {
    await _idbDelete(id);
    _rerender();
    if (navigator.onLine) {
        try {
            await _sbDelete(id);
        } catch (e) { /* retry later */ }
    } else {
        // optional: store ID in a deletion queue
    }
};

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
        // 1. Push all locally unsynced orders
        const localOrders = await _idbGetAll();
        const unsynced = localOrders.filter(o => o._synced === false);
        for (const order of unsynced) {
            try {
                await _sbUpsert(order);
                await _idbPut({ ...order, _synced: true });
            } catch (e) {
                console.warn('Failed to push order', order.id, e);
            }
        }

        // 2. Pull remote changes (newer than local)
        const remote = await _sbGetAll();
        for (const remoteOrder of remote) {
            const local = localOrders.find(o => o.id === remoteOrder.id);
            if (!local || remoteOrder.updatedAt > local.updatedAt) {
                await _idbPut({ ...remoteOrder, _synced: true });
            }
        }

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

// ─── Online / offline events ─────────────────────────────────────────────────

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

// ─── Polling (every 10s) ─────────────────────────────────────────────────────

setInterval(() => {
    if (navigator.onLine && !_syncing) syncNow().catch(console.error);
    // Also refresh menu from Supabase if needed (optional)
}, 10000);

// ─── Realtime WebSocket ──────────────────────────────────────────────────────

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

// ─── UI helpers ──────────────────────────────────────────────────────────────

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
