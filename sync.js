// sync.js — Supabase sync (v4)
// ════════════════════════════════════════════════════════════════════════════
// KEY DESIGN DECISIONS
// 1. Supabase is the source of truth. IndexedDB is just a local cache.
// 2. addOrder() gets its ID from Supabase (not autoIncrement) to prevent
//    ID collisions between devices.
// 3. deleteOrder() sends a DELETE to Supabase immediately and removes from
//    IndexedDB — no tombstones needed because Supabase owns the record set.
// 4. syncNow() = pull remote → write to local cache → re-render. Simple.
// 5. Realtime WebSocket triggers syncNow() on any remote change.
// ════════════════════════════════════════════════════════════════════════════

const SUPABASE_URL      = 'https://efrwvksxttauhoxllhqu.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_SOoDs65SPw_G_m-lZ6NP-w_MbbqxOUw';
const TABLE = 'orders';

// ─── Supabase REST ────────────────────────────────────────────────────────────

function _sbHeaders(extra = {}) {
    return {
        'apikey':        SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type':  'application/json',
        ...extra
    };
}

async function _sbFetch(path, opts = {}) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
        ...opts,
        headers: _sbHeaders(opts.headers || {})
    });
    if (!res.ok) {
        const body = await res.text();
        throw new Error(`Supabase ${res.status}: ${body}`);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
}

// Returns all orders from Supabase as plain order objects
async function _sbGetAll() {
    const rows = await _sbFetch(`${TABLE}?select=id,data,updated_ms&order=id.asc`);
    return (rows || []).map(r => ({ ...r.data, id: r.id, updatedAt: r.updated_ms }));
}

// Inserts one order into Supabase, returns the row with its new server-assigned id
async function _sbInsert(orderData) {
    // Explicitly strip id so Postgres serial generates a fresh one
    const { id: _ignore, updatedAt: _ignore2, ...rest } = orderData;
    const rows = await _sbFetch(TABLE, {
        method:  'POST',
        headers: { 'Prefer': 'return=representation' },
        body:    JSON.stringify({ data: rest, updated_ms: Date.now() })
        // NOTE: no `id` field — Postgres serial assigns it
    });
    const row = Array.isArray(rows) ? rows[0] : rows;
    return { ...row.data, id: row.id, updatedAt: row.updated_ms };
}

// Updates one order in Supabase
async function _sbUpdate(order) {
    const { id, updatedAt, ...rest } = order;
    await _sbFetch(`${TABLE}?id=eq.${id}`, {
        method:  'PATCH',
        headers: { 'Prefer': 'return=minimal' },
        body:    JSON.stringify({ data: rest, updated_ms: Date.now() })
    });
}

// Deletes one order from Supabase
async function _sbDelete(id) {
    await _sbFetch(`${TABLE}?id=eq.${id}`, { method: 'DELETE' });
}

// ─── IndexedDB local cache ────────────────────────────────────────────────────
// Pure cache — Supabase decides the IDs and the truth.

async function _idbOpen() {
    return new Promise((resolve, reject) => {
        // Bump to version 3 so we can clear old autoIncrement assumptions
        const req = indexedDB.open('OrdersDB', 3);
        req.onerror = () => reject(req.error);
        req.onsuccess = () => resolve(req.result);
        req.onupgradeneeded = (ev) => {
            const db = ev.target.result;
            // Drop old store if it exists (v1/v2 used autoIncrement — incompatible)
            if (db.objectStoreNames.contains('orders')) {
                db.deleteObjectStore('orders');
            }
            // Re-create without autoIncrement; IDs always come from Supabase
            const store = db.createObjectStore('orders', { keyPath: 'id' });
            store.createIndex('createdAt', 'createdAt');

            if (db.objectStoreNames.contains('syncQueue')) {
                db.deleteObjectStore('syncQueue');
            }
        };
    });
}

async function _idbGetAll() {
    const db = await _idbOpen();
    return new Promise((resolve, reject) => {
        const req = db.transaction('orders', 'readonly').objectStore('orders').getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror   = () => reject(req.error);
    });
}

async function _idbPut(order) {
    const db = await _idbOpen();
    return new Promise((resolve, reject) => {
        const req = db.transaction('orders', 'readwrite').objectStore('orders').put(order);
        req.onsuccess = () => resolve();
        req.onerror   = () => reject(req.error);
    });
}

async function _idbDelete(id) {
    const db = await _idbOpen();
    return new Promise((resolve, reject) => {
        const req = db.transaction('orders', 'readwrite').objectStore('orders').delete(id);
        req.onsuccess = () => resolve();
        req.onerror   = () => reject(req.error);
    });
}

async function _idbClear() {
    const db = await _idbOpen();
    return new Promise((resolve, reject) => {
        const req = db.transaction('orders', 'readwrite').objectStore('orders').clear();
        req.onsuccess = () => resolve();
        req.onerror   = () => reject(req.error);
    });
}

// ─── Sync ─────────────────────────────────────────────────────────────────────

let _syncing = false;

// Pull everything from Supabase → overwrite local cache → re-render
async function syncNow() {
    if (_syncing) return;
    _syncing = true;
    setSyncStatus('syncing');
    try {
        const remote = await _sbGetAll();
        // Replace local cache entirely with what Supabase says
        await _idbClear();
        for (const o of remote) await _idbPut(o);
        setSyncStatus('ok');
        if (typeof loadOrders === 'function') loadOrders();
        showSyncToast('✅ Synced');
    } catch (e) {
        console.error('Sync error:', e);
        setSyncStatus('error');
        showSyncToast('❌ ' + e.message);
    } finally {
        _syncing = false;
    }
}

const pullFromCloud = syncNow; // alias used by Settings button

// ─── Offline queue (simple pending flag) ─────────────────────────────────────

let _pendingSync = false;

function _scheduleSync() {
    if (navigator.onLine) {
        syncNow().catch(console.error);
    } else {
        _pendingSync = true;
        showSyncToast('📴 Offline — will sync when reconnected');
    }
}

window.addEventListener('online', async () => {
    updateOnlineBadge(true);
    connectRealtime();
    if (_pendingSync) {
        _pendingSync = false;
        await syncNow();
    }
});

window.addEventListener('offline', () => {
    updateOnlineBadge(false);
    setSyncStatus('offline');
});

// ─── Patch db.js functions ────────────────────────────────────────────────────
// Replace IndexedDB-only functions with versions that hit Supabase first,
// then update the local cache to match.

function patchDbFunctions() {

    // addOrder: insert to Supabase → get server ID → cache locally
    window.addOrder = async function(order) {
        order.updatedAt = Date.now();
        order._deleted  = false;
        delete order.id; // ensure no stale id reaches Supabase
        if (navigator.onLine) {
            const saved = await _sbInsert(order); // gets real id from server
            await _idbPut(saved);
            _scheduleSync(); // pull to make sure all devices get it
            return saved.id;
        } else {
            // Offline: can't save without a server ID — alert user
            _pendingSync = true;
            throw new Error('You are offline. Please connect to the internet to save orders.');
        }
    };

    // updateOrder: update Supabase → update local cache
    window.updateOrder = async function(order) {
        order.updatedAt = Date.now();
        if (navigator.onLine) {
            await _sbUpdate(order);
            await _idbPut(order);
            _scheduleSync();
        } else {
            await _idbPut(order);
            _pendingSync = true;
        }
        return order.id;
    };

    // deleteOrder: delete from Supabase → delete from local cache
    window.deleteOrder = async function(id) {
        if (navigator.onLine) {
            await _sbDelete(id);
        }
        await _idbDelete(id);
        _scheduleSync();
    };

    // getAllOrders: read from local cache (already populated by syncNow)
    window.getAllOrders = async function() {
        return _idbGetAll();
    };
}

// ─── Realtime WebSocket ───────────────────────────────────────────────────────

let _ws = null;
let _wsRef = 1;
let _wsHeartbeat = null;

function connectRealtime() {
    if (_ws && (_ws.readyState === WebSocket.OPEN || _ws.readyState === WebSocket.CONNECTING)) return;

    const url = SUPABASE_URL.replace('https://', 'wss://')
        + `/realtime/v1/websocket?apikey=${SUPABASE_ANON_KEY}&vsn=1.0.0`;

    _ws = new WebSocket(url);

    _ws.onopen = () => {
        console.log('✅ Realtime connected');
        _ws.send(JSON.stringify({
            topic:   'realtime:orders-sync',
            event:   'phx_join',
            payload: {
                config: {
                    broadcast:        { self: false },
                    presence:         { key: '' },
                    postgres_changes: [{ event: '*', schema: 'public', table: TABLE }]
                }
            },
            ref: String(_wsRef++)
        }));

        _wsHeartbeat = setInterval(() => {
            if (_ws.readyState === WebSocket.OPEN) {
                _ws.send(JSON.stringify({
                    topic: 'phoenix', event: 'heartbeat',
                    payload: {}, ref: String(_wsRef++)
                }));
            }
        }, 25000);
    };

    _ws.onmessage = ({ data }) => {
        try {
            const frame = JSON.parse(data);
            // Ignore heartbeat acks and phx_reply confirmations
            if (frame.event === 'phx_reply') return;
            // Any postgres_changes event → pull fresh data
            if (frame.event === 'postgres_changes' || frame.payload?.data?.type) {
                console.log('🔔 Remote change — syncing');
                if (!_syncing) syncNow().catch(console.error);
            }
        } catch (_) {}
    };

    _ws.onerror = e => console.warn('Realtime error', e);

    _ws.onclose = () => {
        clearInterval(_wsHeartbeat);
        _ws = null;
        console.warn('Realtime closed — retry in 5s');
        setTimeout(() => { if (navigator.onLine) connectRealtime(); }, 5000);
    };
}

// ─── UI helpers ───────────────────────────────────────────────────────────────

function updateOnlineBadge(online) {
    const el = document.getElementById('onlineBadge');
    if (!el) return;
    el.textContent = online ? '🌐 Online' : '📴 Offline';
    el.className   = 'online-badge ' + (online ? 'badge-online' : 'badge-offline');
}

function setSyncStatus(state) {
    const map = {
        ok:      { icon: '✅', text: 'Synced',     cls: 'sync-ok'      },
        syncing: { icon: '🔄', text: 'Syncing…',   cls: 'sync-syncing' },
        error:   { icon: '❌', text: 'Sync error', cls: 'sync-error'   },
        offline: { icon: '📴', text: 'Offline',    cls: 'sync-offline' },
    };
    const s = map[state] || map.ok;
    ['syncStatus', 'syncStatusSettings'].forEach(id => {
        const el = document.getElementById(id);
        if (el) { el.innerHTML = `${s.icon} ${s.text}`; el.className = 'sync-status ' + s.cls; }
    });
}

let _toastTimer = null;
function showSyncToast(msg) {
    let toast = document.getElementById('syncToast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'syncToast';
        document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.className   = 'sync-toast visible';
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => { toast.className = 'sync-toast'; }, 5000);
}

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
    patchDbFunctions();
    updateOnlineBadge(navigator.onLine);
    if (navigator.onLine) {
        await syncNow();
        connectRealtime();
    } else {
        setSyncStatus('offline');
        // Load whatever is cached locally
        if (typeof loadOrders === 'function') loadOrders();
    }
});
