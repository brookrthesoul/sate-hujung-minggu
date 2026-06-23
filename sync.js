// sync.js — Supabase real-time sync with offline queue
// ─────────────────────────────────────────────────────
// Supabase config (anon/public key — safe for browser use)
const SUPABASE_URL = 'https://efrwvksxttauhoxllhqu.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_SOoDs65SPw_G_m-lZ6NP-w_MbbqxOUw';
const TABLE = 'orders';

// ─── Supabase REST helpers ────────────────────────────────────────────────────

function sbHeaders() {
    return {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
    };
}

async function sbFetch(path, options = {}) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
        ...options,
        headers: { ...sbHeaders(), ...(options.headers || {}) }
    });
    if (!res.ok) {
        const err = await res.text();
        throw new Error(`Supabase error ${res.status}: ${err}`);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : [];
}

// Fetch all orders from Supabase
async function fetchOrdersFromSupabase() {
    const rows = await sbFetch(`${TABLE}?select=id,data,updated_ms&order=id.asc`);
    // Each row: { id, data: {...orderFields}, updated_ms }
    return rows.map(row => ({ ...row.data, id: row.id, updatedAt: row.updated_ms }));
}

// Upsert a single order row to Supabase
async function upsertOrderToSupabase(order) {
    const { id, updatedAt, ...rest } = order;
    await sbFetch(`${TABLE}`, {
        method: 'POST',
        headers: { 'Prefer': 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify({ id, data: rest, updated_ms: updatedAt || Date.now() })
    });
}

// Delete a single order row from Supabase
async function deleteOrderFromSupabase(id) {
    await sbFetch(`${TABLE}?id=eq.${id}`, { method: 'DELETE' });
}

// Push ALL local orders to Supabase (full upsert)
async function pushAllOrdersToSupabase(orders) {
    if (orders.length === 0) return;
    const rows = orders.map(o => {
        const { id, updatedAt, ...rest } = o;
        return { id, data: rest, updated_ms: updatedAt || Date.now() };
    });
    await sbFetch(`${TABLE}`, {
        method: 'POST',
        headers: { 'Prefer': 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify(rows)
    });
}

// ─── Merge strategy: last-write-wins per order ───────────────────────────────

function mergeOrders(local, remote) {
    const map = {};
    local.forEach(o  => { map[o.id] = o; });
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

async function _rawUpdate(order) {
    const db = await openSyncDB();
    return new Promise((resolve, reject) => {
        const tx  = db.transaction('orders', 'readwrite');
        const req = tx.objectStore('orders').put(order);
        req.onsuccess = () => resolve(req.result);
        req.onerror   = () => reject(req.error);
    });
}

// ─── Core sync ───────────────────────────────────────────────────────────────

async function syncNow() {
    if (_syncing) return;
    _syncing = true;
    setSyncStatus('syncing');

    try {
        const remoteOrders = await fetchOrdersFromSupabase();
        const localOrders  = await _rawGetAll();
        const merged       = mergeOrders(localOrders, remoteOrders);

        // Write merged back to local IndexedDB
        for (const order of merged) {
            await _rawUpdate(order);
        }

        // Push merged to Supabase
        await pushAllOrdersToSupabase(merged);
        await clearQueue();

        setSyncStatus('ok');
        if (typeof loadOrders === 'function') loadOrders();
        showSyncToast('✅ Synced with Supabase');
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
        const remoteOrders = await fetchOrdersFromSupabase();
        for (const order of remoteOrders) {
            await _rawUpdate(order);
        }
        setSyncStatus('ok');
        if (typeof loadOrders === 'function') loadOrders();
        showSyncToast('📥 Pulled from Supabase');
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

// ─── Patch db.js public functions (add updatedAt + trigger sync) ─────────────

function patchDbFunctions() {
    const origAdd    = window.addOrder;
    const origUpdate = window.updateOrder;
    const origDelete = window.deleteOrder;

    window.addOrder = async function(order) {
        order.updatedAt = Date.now();
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

    window.deleteOrder = async function(id) {
        // Best-effort delete from Supabase immediately if online
        if (navigator.onLine) {
            deleteOrderFromSupabase(id).catch(console.error);
        }
        const result = await origDelete(id);
        _scheduleSync();
        return result;
    };
}

// Debounce sync triggers so rapid saves don't stack up
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

// ─── Real-time subscription (Supabase Realtime over WebSocket) ───────────────

let _realtimeWs = null;

function connectRealtime() {
    if (_realtimeWs) return; // already connected

    const wsUrl = SUPABASE_URL.replace('https://', 'wss://') +
        `/realtime/v1/websocket?apikey=${SUPABASE_ANON_KEY}&vsn=1.0.0`;

    _realtimeWs = new WebSocket(wsUrl);

    _realtimeWs.onopen = () => {
        console.log('✅ Supabase Realtime connected');
        // Join the postgres_changes channel
        _realtimeWs.send(JSON.stringify({
            topic: `realtime:public:${TABLE}`,
            event: 'phx_join',
            payload: {
                config: {
                    broadcast: { self: false },
                    postgres_changes: [{ event: '*', schema: 'public', table: TABLE }]
                }
            },
            ref: '1'
        }));
    };

    _realtimeWs.onmessage = (msg) => {
        try {
            const payload = JSON.parse(msg.data);
            // Heartbeat reply
            if (payload.event === 'phx_reply' && payload.ref === 'heartbeat') return;
            // Data change event
            if (payload.event === 'postgres_changes') {
                console.log('🔔 Realtime change:', payload.payload?.data?.type);
                if (!_syncing) {
                    syncNow().catch(console.error);
                }
            }
        } catch (e) { /* ignore parse errors */ }
    };

    _realtimeWs.onerror = (e) => console.warn('Realtime WS error:', e);

    _realtimeWs.onclose = () => {
        console.warn('Realtime WS closed — reconnecting in 5s');
        _realtimeWs = null;
        setTimeout(() => { if (navigator.onLine) connectRealtime(); }, 5000);
    };

    // Heartbeat every 30s to keep the connection alive
    setInterval(() => {
        if (_realtimeWs && _realtimeWs.readyState === WebSocket.OPEN) {
            _realtimeWs.send(JSON.stringify({
                topic: 'phoenix', event: 'heartbeat', payload: {}, ref: 'heartbeat'
            }));
        }
    }, 30000);
}

// ─── Online / offline event listeners ────────────────────────────────────────

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
