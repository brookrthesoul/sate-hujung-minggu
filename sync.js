// sync.js — Supabase real-time sync with soft-delete support
// ──────────────────────────────────────────────────────────
const SUPABASE_URL     = 'https://efrwvksxttauhoxllhqu.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_SOoDs65SPw_G_m-lZ6NP-w_MbbqxOUw';
const TABLE = 'orders';

// ─── Supabase REST helpers ────────────────────────────────────────────────────

function sbHeaders(extra = {}) {
    return {
        'apikey':        SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type':  'application/json',
        ...extra
    };
}

async function sbFetch(path, options = {}) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
        ...options,
        headers: sbHeaders(options.headers || {})
    });
    if (!res.ok) {
        const err = await res.text();
        throw new Error(`Supabase ${res.status}: ${err}`);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : [];
}

// Fetch ALL rows (including soft-deleted) from Supabase
async function fetchRemoteOrders() {
    const rows = await sbFetch(`${TABLE}?select=id,data,updated_ms&order=id.asc`);
    return rows.map(row => ({ ...row.data, id: row.id, updatedAt: row.updated_ms }));
}

// Upsert rows in bulk — includes soft-deleted ones
async function pushToSupabase(orders) {
    if (orders.length === 0) return;
    const rows = orders.map(o => {
        const { id, updatedAt, ...rest } = o;
        return { id, data: rest, updated_ms: updatedAt || Date.now() };
    });
    await sbFetch(TABLE, {
        method: 'POST',
        headers: { 'Prefer': 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify(rows)
    });
}

// ─── Merge strategy: last-write-wins per order (soft-delete aware) ────────────

function mergeOrders(local, remote) {
    const map = {};
    // Start with local
    local.forEach(o => { map[o.id] = o; });
    // Remote wins if it's newer
    remote.forEach(o => {
        const existing = map[o.id];
        if (!existing || (o.updatedAt || 0) > (existing.updatedAt || 0)) {
            map[o.id] = o;
        }
    });
    return Object.values(map);
}

// ─── Prevent re-entrant syncs ────────────────────────────────────────────────
let _syncing = false;

// ─── IndexedDB: offline sync queue ───────────────────────────────────────────
const QUEUE_STORE = 'syncQueue';

async function openSyncDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('OrdersDB', 2);
        request.onerror   = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
        request.onupgradeneeded = (ev) => {
            const db = ev.target.result;
            if (!db.objectStoreNames.contains('orders')) {
                const s = db.createObjectStore('orders', { keyPath: 'id', autoIncrement: true });
                s.createIndex('createdAt', 'createdAt');
            }
            if (!db.objectStoreNames.contains(QUEUE_STORE)) {
                db.createObjectStore(QUEUE_STORE, { keyPath: 'queueId', autoIncrement: true });
            }
        };
    });
}

async function enqueueAction(action) {
    const db = await openSyncDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(QUEUE_STORE, 'readwrite');
        tx.objectStore(QUEUE_STORE).add({ ...action, timestamp: Date.now() });
        tx.oncomplete = resolve;
        tx.onerror    = () => reject(tx.error);
    });
}

async function getQueue() {
    const db = await openSyncDB();
    return new Promise((resolve, reject) => {
        const tx  = db.transaction(QUEUE_STORE, 'readonly');
        const req = tx.objectStore(QUEUE_STORE).getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror   = () => reject(req.error);
    });
}

async function clearQueue() {
    const db = await openSyncDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(QUEUE_STORE, 'readwrite');
        tx.objectStore(QUEUE_STORE).clear();
        tx.oncomplete = resolve;
        tx.onerror    = () => reject(tx.error);
    });
}

// ─── Raw IndexedDB access (bypasses patched wrappers) ────────────────────────

async function _rawGetAll() {
    const db = await openSyncDB();
    return new Promise((resolve, reject) => {
        const tx  = db.transaction('orders', 'readonly');
        const req = tx.objectStore('orders').getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror   = () => reject(req.error);
    });
}

async function _rawPut(order) {
    const db = await openSyncDB();
    return new Promise((resolve, reject) => {
        const tx  = db.transaction('orders', 'readwrite');
        const req = tx.objectStore('orders').put(order);
        req.onsuccess = () => resolve(req.result);
        req.onerror   = () => reject(req.error);
    });
}

async function _rawDelete(id) {
    const db = await openSyncDB();
    return new Promise((resolve, reject) => {
        const tx  = db.transaction('orders', 'readwrite');
        const req = tx.objectStore('orders').delete(id);
        req.onsuccess = () => resolve();
        req.onerror   = () => reject(req.error);
    });
}

// ─── Core sync ───────────────────────────────────────────────────────────────

async function syncNow() {
    if (_syncing) return;
    _syncing = true;
    setSyncStatus('syncing');

    try {
        const remote = await fetchRemoteOrders();
        const local  = await _rawGetAll();
        const merged = mergeOrders(local, remote);

        // Apply merged back to local IndexedDB
        for (const order of merged) {
            if (order._deleted) {
                // Soft-deleted: remove from local IndexedDB so UI doesn't show it
                await _rawDelete(order.id);
            } else {
                await _rawPut(order);
            }
        }

        // Push full merged set (including soft-deletes) to Supabase
        await pushToSupabase(merged);
        await clearQueue();

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

async function pullFromCloud() {
    if (_syncing) return;
    _syncing = true;
    setSyncStatus('syncing');
    try {
        const remote = await fetchRemoteOrders();
        for (const order of remote) {
            if (order._deleted) {
                await _rawDelete(order.id);
            } else {
                await _rawPut(order);
            }
        }
        setSyncStatus('ok');
        if (typeof loadOrders === 'function') loadOrders();
        showSyncToast('📥 Pulled from cloud');
    } catch (e) {
        console.error('Pull error:', e);
        setSyncStatus('error');
        showSyncToast('❌ ' + e.message);
    } finally {
        _syncing = false;
    }
}

async function drainQueue() {
    const queue = await getQueue();
    if (queue.length === 0) return;
    await syncNow();
}

// ─── Patch db.js public functions ────────────────────────────────────────────
// Intercepts add/update/delete to stamp updatedAt and trigger sync.
// deleteOrder now does a SOFT DELETE — marks _deleted:true — so all devices
// learn about the deletion on next sync instead of the dead order being
// re-uploaded from another device's IndexedDB.

function patchDbFunctions() {
    const origAdd    = window.addOrder;
    const origUpdate = window.updateOrder;
    const origDelete = window.deleteOrder;

    window.addOrder = async function(order) {
        order.updatedAt  = Date.now();
        order._deleted   = false;
        const id = await origAdd(order);
        _scheduleSync();
        return id;
    };

    window.updateOrder = async function(order) {
        if (!_syncing) order.updatedAt = Date.now();
        const result = await origUpdate(order);
        if (!_syncing) _scheduleSync();
        return result;
    };

    // Soft delete: write a tombstone row to IndexedDB, then sync it up
    window.deleteOrder = async function(id) {
        const db = await openSyncDB();
        // Fetch current order to build tombstone
        const current = await new Promise((res, rej) => {
            const tx  = db.transaction('orders', 'readonly');
            const req = tx.objectStore('orders').get(id);
            req.onsuccess = () => res(req.result);
            req.onerror   = () => rej(req.error);
        });

        if (current) {
            // Write tombstone (keeps the row so other devices can learn it's deleted)
            const tombstone = { ...current, _deleted: true, updatedAt: Date.now() };
            await _rawPut(tombstone);
        }

        // Remove from IndexedDB so the UI no longer shows it
        await origDelete(id);

        _scheduleSync();
    };
}

// Debounce sync triggers
let _syncTimer = null;
function _scheduleSync() {
    clearTimeout(_syncTimer);
    _syncTimer = setTimeout(() => {
        if (navigator.onLine) {
            syncNow().catch(console.error);
        } else {
            enqueueAction({ type: 'pending' }).catch(() => {});
        }
    }, 500);
}

// ─── Real-time subscription (Supabase Realtime v2) ───────────────────────────

let _realtimeWs  = null;
let _heartbeatId = null;
let _ref         = 1;

function connectRealtime() {
    if (_realtimeWs &&
        (_realtimeWs.readyState === WebSocket.OPEN ||
         _realtimeWs.readyState === WebSocket.CONNECTING)) return;

    const wsUrl = SUPABASE_URL.replace('https://', 'wss://') +
        `/realtime/v1/websocket?apikey=${SUPABASE_ANON_KEY}&vsn=1.0.0`;

    _realtimeWs = new WebSocket(wsUrl);

    _realtimeWs.onopen = () => {
        console.log('✅ Supabase Realtime connected');

        // Supabase Realtime v2 channel join format
        _realtimeWs.send(JSON.stringify({
            topic:   'realtime:sync-channel',
            event:   'phx_join',
            payload: {
                config: {
                    broadcast:        { self: false },
                    presence:         { key: '' },
                    postgres_changes: [{ event: '*', schema: 'public', table: TABLE }]
                }
            },
            ref: String(_ref++)
        }));

        // Heartbeat every 25s
        _heartbeatId = setInterval(() => {
            if (_realtimeWs.readyState === WebSocket.OPEN) {
                _realtimeWs.send(JSON.stringify({
                    topic: 'phoenix', event: 'heartbeat',
                    payload: {}, ref: String(_ref++)
                }));
            }
        }, 25000);
    };

    _realtimeWs.onmessage = (msg) => {
        try {
            const frame = JSON.parse(msg.data);
            // Ignore heartbeat acks and join confirmations
            if (frame.event === 'phx_reply') return;
            // postgres_changes events arrive with event === 'postgres_changes'
            // OR as insert/update/delete inside payload.data.type
            const isChange = frame.event === 'postgres_changes' ||
                             frame.payload?.data?.type != null;
            if (isChange && !_syncing) {
                console.log('🔔 Realtime change received — syncing');
                syncNow().catch(console.error);
            }
        } catch (_) {}
    };

    _realtimeWs.onerror = (e) => console.warn('Realtime WS error', e);

    _realtimeWs.onclose = () => {
        console.warn('Realtime WS closed — will retry in 5s');
        clearInterval(_heartbeatId);
        _realtimeWs = null;
        setTimeout(() => { if (navigator.onLine) connectRealtime(); }, 5000);
    };
}

// ─── Online / offline listeners ───────────────────────────────────────────────

window.addEventListener('online', async () => {
    updateOnlineBadge(true);
    connectRealtime();
    await drainQueue();
});

window.addEventListener('offline', () => {
    updateOnlineBadge(false);
    setSyncStatus('offline');
});

// ─── UI helpers ───────────────────────────────────────────────────────────────

function updateOnlineBadge(online) {
    const badge = document.getElementById('onlineBadge');
    if (!badge) return;
    badge.textContent = online ? '🌐 Online' : '📴 Offline';
    badge.className   = 'online-badge ' + (online ? 'badge-online' : 'badge-offline');
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
    }
});
