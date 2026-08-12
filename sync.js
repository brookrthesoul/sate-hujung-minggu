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

// Insert an order that was created offline, asking the server to keep the
// same id we already predicted and printed on the receipt (see
// admin_insert_order_with_id.sql). Falls back to a normal auto-assigned id
// server-side if that number was somehow already taken.
async function _sbInsertWithId(id, order) {
    const { id: _a, updatedAt: _b, ...data } = order;
    const result = await _sbFetch('rpc/admin_insert_order_with_id', {
        method: 'POST',
        body: JSON.stringify({ p_id: id, p_data: data, p_updated_ms: Date.now() })
    });
    return { ...result.data, id: result.id, updatedAt: result.updated_ms };
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
    // A 200 here does NOT guarantee a row was actually removed — PostgREST
    // returns success even if the filter matched zero rows. Ask for the
    // deleted row(s) back so we can tell the difference between "deleted"
    // and "silently matched nothing", which would otherwise let the order
    // quietly reappear on the next sync with no error ever shown.
    const result = await _sbFetch(`${TABLE}?id=eq.${id}`, {
        method: 'DELETE',
        headers: { 'Prefer': 'return=representation' }
    });
    if (!Array.isArray(result) || result.length === 0) {
        throw new Error(`Server reported success but order #${id} was not found/removed (check RLS policy on 'orders' table for DELETE).`);
    }
}

// ─── IndexedDB cache ──────────────────────────────────────────────────────────

const _IDB_NAME    = 'OrdersDB';
const _IDB_VERSION = 5;  // bumped to add box store (see box.js)
const _IDB_STORE   = 'orders';
const _IDB_STOCK   = 'stock';
const _IDB_BOX     = 'box';
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
            // Add box store in v5 — same shape as stock: { id, qty, cooked_total }
            if (!db.objectStoreNames.contains(_IDB_BOX)) {
                db.createObjectStore(_IDB_BOX, { keyPath: 'id' });
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

// ─── Offline order numbering ──────────────────────────────────────────────────
// Predicts the next real order id so a receipt printed while offline shows a
// normal number (e.g. #164) instead of a giant temp id, and generally *is*
// the real number once synced (see admin_insert_order_with_id.sql).
const _NEXT_ORDER_NUM_KEY = 'nextOfflineOrderNumber';

function _peekNextOrderNumber(floorId) {
    const stored = parseInt(localStorage.getItem(_NEXT_ORDER_NUM_KEY), 10) || 0;
    return Math.max(stored, (floorId || 0) + 1);
}

function _commitNextOrderNumber(n) {
    const stored = parseInt(localStorage.getItem(_NEXT_ORDER_NUM_KEY), 10) || 0;
    localStorage.setItem(_NEXT_ORDER_NUM_KEY, String(Math.max(n, stored)));
}

async function _takeNextOrderNumber() {
    const idbAll  = await _idbGetAll();
    const localMax = idbAll.length ? Math.max(...idbAll.map(o => o.id)) : 0;
    const num = _peekNextOrderNumber(localMax);
    _commitNextOrderNumber(num + 1);
    return num;
}



let _syncing  = false;
let _draining = false;

// Orders we've just told the server to delete. A concurrent sync (the 10s
// poll, a websocket event, or even the delete's own follow-up sync) can
// fetch the full order list from Supabase before that DELETE has actually
// committed — the fetch still includes the row, and a plain replace-all
// would put it right back in IndexedDB and on screen a few seconds after
// it was deleted. Filtering these ids out of every sync for a short window
// closes that race regardless of which sync call wins it.
const _recentlyDeletedIds = new Set();

function _rerender() {
    if (typeof loadOrders    === 'function') loadOrders();
    if (typeof loadPreorders === 'function') loadPreorders();
}

// A cold load races the service worker / network stack coming up, so the very
// first fetch often rejects with a bare "Failed to fetch" even though the
// connection is fine a moment later. Retry those transient failures quietly
// instead of flashing a red "Sync error".
function _isTransientNetworkError(e) {
    return e instanceof TypeError || /failed to fetch|networkerror|load failed/i.test(String((e && e.message) || e));
}

async function _withNetworkRetry(fn, attempts = 3, delayMs = 500) {
    for (let i = 1; ; i++) {
        try {
            return await fn();
        } catch (e) {
            if (i >= attempts || !_isTransientNetworkError(e)) throw e;
            console.warn(`[sync] transient network error, retrying (${i}/${attempts - 1})…`);
            await new Promise(r => setTimeout(r, delayMs * i));
        }
    }
}

async function syncNow() {
    if (_syncing || _draining) return; // don't sync while draining queue
    _syncing = true;
    setSyncStatus('syncing');
    try {
        const rawRemote = await _withNetworkRetry(() => _sbGetAll());
        const remote = rawRemote.filter(o => !_recentlyDeletedIds.has(o.id));
        if (_recentlyDeletedIds.size > 0) {
            console.log('[sync] guard active for:', [..._recentlyDeletedIds],
                '| raw fetch had', rawRemote.length, 'rows, ids:', rawRemote.map(o=>o.id),
                '| after filter:', remote.length, 'rows');
        }
        // Keep offline-only orders (not yet pushed to Supabase)
        const localOffline = (await _idbGetAll()).filter(o => o._offline === true);
        await _idbReplaceAll(remote);
        for (const o of localOffline) await _idbPut(o);
        const knownIds = [...remote.map(o => o.id), ...localOffline.map(o => o.id)];
        _commitNextOrderNumber((knownIds.length ? Math.max(...knownIds) : 0) + 1);
        setSyncStatus('ok');
        _rerender();
        showSyncToast('✅ Synced');
    } catch (e) {
        // Still offline after retries isn't an app error — show the offline
        // state (the local cache is authoritative until the network returns).
        if (_isTransientNetworkError(e) || navigator.onLine === false) {
            console.warn('Sync unavailable (offline):', e);
            setSyncStatus('offline');
        } else {
            console.error('Sync error:', e);
            setSyncStatus('error');
            showSyncToast('❌ ' + e.message);
        }
    } finally {
        _syncing = false;
    }
}

const pullFromCloud = syncNow;

// ─── Offline queue ────────────────────────────────────────────────────────────
// Persisted to localStorage — this used to be a plain in-memory array, which
// meant closing or reloading the app before a pending offline order finished
// syncing would silently drop that "push this to the server" instruction
// forever. The order itself (already in IndexedDB) would survive with its
// _offline flag stuck true, permanently orphaned: never actually reaching
// the server, yet looking locally like it's just "waiting to sync".

const _OFFLINE_QUEUE_KEY = 'sate_offlineQueue';

function _loadOfflineQueue() {
    try {
        const raw = localStorage.getItem(_OFFLINE_QUEUE_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
        console.warn('Failed to load persisted offline queue:', e);
        return [];
    }
}

function _saveOfflineQueue() {
    try { localStorage.setItem(_OFFLINE_QUEUE_KEY, JSON.stringify(_offlineQueue)); }
    catch (e) { console.warn('Failed to persist offline queue:', e); }
}

const _offlineQueue = _loadOfflineQueue();
if (_offlineQueue.length > 0) {
    console.log('[offline queue] restored', _offlineQueue.length, 'pending op(s) from a previous session:', _offlineQueue);
}

async function _drainOfflineQueue() {
    if (_offlineQueue.length === 0) { await syncNow(); return; }
    _draining = true;
    showSyncToast('🔄 Uploading offline orders...');

    const queue = [..._offlineQueue];
    _offlineQueue.length = 0;
    _saveOfflineQueue();

    // If an order created offline gets renumbered on the way in (its
    // predicted id collided with something already on the server), every
    // OTHER queued op for that same order — a stage-transition update made
    // while still offline, a delete — still refers to the old predicted
    // id. A PATCH/DELETE against an id that doesn't exist matches zero
    // rows and fails completely silently, with no error, so that update
    // just vanishes instead of ever reaching the real row. Track and
    // rewrite ids as we go so the rest of the batch follows the renumber.
    const idRemap = new Map();

    for (const item of queue) {
        try {
            if (item.op === 'add') {
                const { id: tempId, updatedAt: _a, _deleted: _b, _offline: _c, ...clean } = item.order;
                const saved = await _sbInsertWithId(tempId, clean);
                // Swap temp ID for real Supabase ID in IndexedDB
                await _idbDelete(tempId);
                await _idbPut(saved);
                if (saved.id !== tempId) {
                    idRemap.set(tempId, saved.id);
                    showSyncToast(`⚠️ Order #${tempId} is now #${saved.id} — another order took that number`);
                }
            } else if (item.op === 'update') {
                const realId = idRemap.has(item.order.id) ? idRemap.get(item.order.id) : item.order.id;
                await _sbUpdate(realId === item.order.id ? item.order : { ...item.order, id: realId });
            } else if (item.op === 'delete') {
                const realId = idRemap.has(item.id) ? idRemap.get(item.id) : item.id;
                await _sbDelete(realId);
            }
        } catch (e) {
            console.error('Queue drain error:', e);
            _offlineQueue.push(item); // retry next time
        }
    }
    _saveOfflineQueue();

    _draining = false;
    await syncNow(); // full sync to reconcile all devices
}

// ─── Public CRUD (called by db.js) ───────────────────────────────────────────

window._idbGetAll = _idbGetAll;

window._sbAddOrder = async function(order) {
    const { id: _a, updatedAt: _b, _deleted: _c, ...clean } = order;
    clean.createdAt = clean.createdAt || Date.now();

    // Shared offline-fallback path: predicts the real order number (used on
    // the printed receipt), marks it _offline, and queues it for later.
    async function _goOffline() {
        const tempId = await _takeNextOrderNumber();
        const tempOrder = { ...clean, id: tempId, _offline: true };
        await _idbPut(tempOrder);
        _offlineQueue.push({ op: 'add', order: tempOrder });
        _saveOfflineQueue();
        _pendingSync = true;
        _rerender();
        showSyncToast('📴 Saved offline — will sync when connected');
        return tempId;
    }

    if (!navigator.onLine) return _goOffline();

    try {
        const saved = await _sbInsert(clean);
        await _idbPut(saved);
        _rerender();
        setTimeout(() => syncNow().catch(console.error), 200);
        return saved.id;
    } catch (e) {
        // navigator.onLine said we're connected, but the request still
        // failed — a flaky connection with no real upstream, a mid-request
        // drop, a DNS hiccup, etc. Don't lose the order: fall back to the
        // same offline path a genuinely offline write would take, instead
        // of letting the exception propagate and the order vanish.
        console.warn('Insert failed despite navigator.onLine — falling back to offline queue:', e);
        return _goOffline();
    }
};

window._sbUpdateOrder = async function(order) {
    await _idbPut(order);
    _rerender();

    if (navigator.onLine) {
        try {
            await _sbUpdate(order);
            setTimeout(() => syncNow().catch(console.error), 200);
            return order.id;
        } catch (e) {
            // Same reasoning as _sbAddOrder above — navigator.onLine can lie.
            // Without this catch, a failed PATCH here was silently dropped:
            // never queued, never retried, and the next successful sync
            // would pull the OLD server state back down over top of it —
            // which is exactly how status/payment-method changes were
            // getting quietly reverted after a flaky-connection shift.
            console.warn('Update failed despite navigator.onLine — queueing for retry:', e);
        }
    }

    _offlineQueue.push({ op: 'update', order });
    _saveOfflineQueue();
    _pendingSync = true;
    showSyncToast('📴 Saved offline — will sync when connected');
    return order.id;
};

window._sbDeleteOrder = async function(id) {
    console.log('[delete] starting for id', id, typeof id);
    // Was this order created while offline and never actually pushed to
    // Supabase yet? If so there's nothing to delete server-side — just
    // cancel the pending 'add' so it's never sent at all. (Used to detect
    // this via a negative id; offline ids now look like real numbers, so
    // check the _offline flag instead.)
    const existing = (await _idbGetAll()).find(o => o.id === id);
    const isUnsyncedLocal = !!(existing && existing._offline === true);
    console.log('[delete] existing local record:', existing, '| isUnsyncedLocal:', isUnsyncedLocal);

    _recentlyDeletedIds.add(id);
    await _idbDelete(id);
    _rerender();

    if (isUnsyncedLocal) {
        const idx = _offlineQueue.findIndex(item => item.op === 'add' && item.order.id === id);
        if (idx !== -1) { _offlineQueue.splice(idx, 1); _saveOfflineQueue(); }
        console.log('[delete] flagged unsynced-local, removed pending add op (found in queue:', idx !== -1, ')');

        // The _offline flag SHOULD mean this never reached the server — but
        // if that flag is ever stale (it actually synced successfully at
        // some point and the flag just never got cleared, e.g. the
        // in-memory offline queue was lost on a reload before it could
        // finish draining), skipping the server delete here would leave
        // the row sitting on Supabase, and the very next sync would pull
        // it right back down. So always also attempt a real server delete
        // when online — a "nothing there" result is expected/normal for a
        // genuinely never-synced order, so we don't treat that as a failure.
        if (navigator.onLine) {
            try {
                await _sbDelete(id);
                console.log('[delete] stale _offline flag confirmed — also removed a matching row on the server for id', id);
            } catch (e) {
                console.log('[delete] no matching server row found for id', id, '(expected for a genuinely never-synced order)');
            }
        }

        _recentlyDeletedIds.delete(id);
        return;
    }

    if (navigator.onLine) {
        // Retry a couple of times before giving up — a transient failure
        // here used to leave the guard set forever (blocking it silently)
        // or, after a reload reset the guard, let the still-undeleted
        // order quietly reappear with no explanation.
        let ok = false, lastErr = null;
        for (let attempt = 0; attempt < 3 && !ok; attempt++) {
            try {
                if (attempt > 0) await new Promise(r => setTimeout(r, 600));
                await _sbDelete(id);
                ok = true;
                console.log('[delete] server confirmed row removed, attempt', attempt);
            } catch (e) { lastErr = e; console.log('[delete] attempt', attempt, 'failed:', e.message); }
        }
        if (ok) {
            setTimeout(() => syncNow().catch(console.error), 200);
        } else {
            console.error('Delete failed after retries:', lastErr);
            _recentlyDeletedIds.delete(id);
            alert('❌ Could not delete order #' + id + ' — it will reappear. Check your connection and try again.' + (lastErr ? '\n\n' + lastErr.message : ''));
            syncNow().catch(console.error);
            return;
        }
    } else {
        _offlineQueue.push({ op: 'delete', id });
        _saveOfflineQueue();
        _pendingSync = true;
        showSyncToast('📴 Deleted offline — will sync when connected');
    }

    // Keep guarding for a while after the delete request itself finishes,
    // to cover any sync that was already in flight (started before the
    // DELETE committed on the server) and hasn't resolved yet.
    setTimeout(() => { _recentlyDeletedIds.delete(id); console.log('[delete] guard cleared for id', id); }, 15000);
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
    // Flush any queued Box adjustments / deferred day-close reset too
    if (typeof window._syncBox === 'function') window._syncBox().catch(console.warn);
});

window.addEventListener('offline', () => {
    updateOnlineBadge(false);
    setSyncStatus('offline');
    _pendingSync = true;
});

// Background tabs get setInterval throttled by the browser (sometimes to
// once a minute or less) and can have their websocket connection silently
// dropped without ever firing a close/error event. Neither the poll nor a
// dead realtime connection reliably catches up on their own — so force an
// immediate resync (and reconnect if needed) the moment this tab/app is
// actually looked at again, rather than leaving it stale indefinitely.
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    console.log('[visibility] tab became visible — forcing resync');
    if (navigator.onLine) {
        if (!_ws || _ws.readyState !== WebSocket.OPEN) connectRealtime();
        if (_offlineQueue.length > 0) _drainOfflineQueue().catch(console.error);
        else syncNow().catch(console.error);
        syncSettingsFromCloud().catch(console.warn);
    }
});

// ─── Polling fallback every 10s ───────────────────────────────────────────────

let _pollTick = 0;

setInterval(() => {
    _pollTick++;
    if (navigator.onLine && !_syncing && !_draining) {
        if (_offlineQueue.length > 0) {
            console.log('[sync] 10s poll found pending offline queue — draining instead of a plain sync');
            _drainOfflineQueue().catch(console.error);
        } else {
            console.log('[sync] triggered by 10s poll');
            syncNow().catch(console.error);
        }
    }
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
    // Settings (shop open/closed, thresholds, etc.) rarely change, so this
    // is just a fallback for whenever the websocket happens to be down —
    // every 3rd tick (~30s) is plenty responsive without being chatty.
    if (navigator.onLine && _pollTick % 3 === 0) {
        syncSettingsFromCloud().catch(console.warn);
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
        // Subscribe to box_stock table (see box.js) — so this device's Box
        // bar stays live if another device (or a customer's own order,
        // handled server-side) changes it.
        _ws.send(JSON.stringify({
            topic: 'realtime:box-stock-sync', event: 'phx_join',
            payload: { config: {
                broadcast: { self: false }, presence: { key: '' },
                postgres_changes: [{ event: '*', schema: 'public', table: 'box_stock' }]
            }},
            ref: String(_wsRef++)
        }));
        // Subscribe to settings table — shop open/closed, busy thresholds,
        // preorder toggle, etc. Without this, a change made on one admin
        // device only ever reached OTHER admin devices on their next
        // manual page refresh (the customer-facing order page already
        // polls this on its own, so it wasn't affected).
        _ws.send(JSON.stringify({
            topic: 'realtime:settings-sync', event: 'phx_join',
            payload: { config: {
                broadcast: { self: false }, presence: { key: '' },
                postgres_changes: [{ event: '*', schema: 'public', table: 'settings' }]
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
                if (table === 'box_stock' || table.includes('box-stock')) {
                    // Box changed on another device (or a customer's own
                    // order deducted from it server-side) — re-sync the Box.
                    if (typeof loadBoxStock === 'function') loadBoxStock().catch(console.warn);
                } else if (table.includes('stock')) {
                    // Stock changed on another device — re-sync stock
                    if (typeof window._syncStock === 'function') window._syncStock().catch(console.warn);
                } else if (table === 'settings' || table.includes('settings')) {
                    // Shop open/closed, busy thresholds, preorder toggle,
                    // etc. changed on another device
                    console.log('[sync] settings changed on another device, event type:', f.payload?.data?.type);
                    syncSettingsFromCloud().catch(console.warn);
                } else {
                    // Orders changed
                    console.log('[sync] triggered by websocket, event type:', f.payload?.data?.type, 'record:', f.payload?.data?.record || f.payload?.data?.old_record);
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
    if (typeof restoreSettingsAccordions === 'function') restoreSettingsAccordions();

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
        if (_offlineQueue.length > 0) {
            console.log('[startup] draining', _offlineQueue.length, 'pending offline op(s) instead of a plain sync');
            await _drainOfflineQueue();
        } else {
            await syncNow();
        }
        connectRealtime();
    } else {
        setSyncStatus('offline');
        _rerender();
    }

    // Sync stock from Supabase
    try {
        if (typeof window._syncStock === 'function') await window._syncStock();
    } catch(e) { console.warn('Stock sync error:', e); }

    // Sync Box stock from Supabase (see box.js)
    try {
        if (typeof loadBoxStock === 'function') await loadBoxStock();
    } catch(e) { console.warn('Box stock sync error:', e); }

    await syncSettingsFromCloud();

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


// ─── Box stock sync (see box.js for the "why") ─────────────────────────────────
// Same local-first + queue pattern as stock above: reads come from IDB first
// (instant, works offline), writes update the local cache immediately and
// either push straight to Supabase (online) or get queued and replayed the
// next time we're back online (see _syncBox / the 'online' listener below).

let _boxQueue        = [];  // pending offline deltas: { id, qtyDelta, cookedDelta }
let _boxResetPending = false; // true if a day-close reset happened while offline

async function _boxIdbGetAll() {
    const db = await _idbOpen();
    return new Promise((res, rej) => {
        const tx  = db.transaction(_IDB_BOX, 'readonly');
        const req = tx.objectStore(_IDB_BOX).getAll();
        req.onsuccess = () => res(req.result);
        req.onerror   = () => rej(req.error);
    });
}

async function _boxIdbPutAll(rows) {
    const db = await _idbOpen();
    return new Promise((res, rej) => {
        const tx    = db.transaction(_IDB_BOX, 'readwrite');
        const store = tx.objectStore(_IDB_BOX);
        tx.oncomplete = () => res();
        tx.onerror    = () => rej(tx.error);
        rows.forEach(r => store.put(r));
    });
}

async function _boxIdbPut(row) {
    const db = await _idbOpen();
    return new Promise((res, rej) => {
        const tx  = db.transaction(_IDB_BOX, 'readwrite');
        const req = tx.objectStore(_IDB_BOX).put(row);
        req.onsuccess = () => res();
        req.onerror   = () => rej(req.error);
    });
}

async function _sbGetBox() {
    try {
        const rows = await _sbFetch('box_stock?select=id,qty,cooked_total');
        return rows || [];
    } catch(e) {
        console.warn('Box fetch failed:', e);
        return null;
    }
}

async function _sbAdjustBox(id, qtyDelta, cookedDelta) {
    try {
        await _sbFetch('rpc/adjust_box_stock', {
            method: 'POST',
            body: JSON.stringify({ p_id: id, p_qty_delta: qtyDelta, p_cooked_delta: cookedDelta })
        });
        return true;
    } catch(e) {
        console.warn('Box adjust failed:', e);
        return false;
    }
}

async function _sbResetBox() {
    try {
        await _sbFetch('rpc/reset_box_stock', { method: 'POST', body: JSON.stringify({}) });
        return true;
    } catch(e) {
        console.warn('Box reset failed:', e);
        return false;
    }
}

// Main box sync — call on app start, after reconnecting, and whenever local
// box data needs refreshing. box.js's window._applyBoxRows(rows) is what
// actually updates boxData + re-renders the Box bar / summary bar.
window._syncBox = async function() {
    // 1. A day-close reset that happened while offline takes priority over
    //    any older queued deltas from the day before — drop them, they're stale.
    if (_boxResetPending && navigator.onLine) {
        const ok = await _sbResetBox();
        if (ok) { _boxResetPending = false; _boxQueue = []; }
    }

    // 2. Push any queued offline adjustments, in the order they happened
    if (_boxQueue.length > 0 && navigator.onLine) {
        const queue = [..._boxQueue];
        _boxQueue = [];
        for (const { id, qtyDelta, cookedDelta } of queue) {
            const ok = await _sbAdjustBox(id, qtyDelta, cookedDelta);
            if (!ok) _boxQueue.push({ id, qtyDelta, cookedDelta }); // re-queue if it failed
        }
    }

    // 3. Fetch fresh from Supabase if online (authoritative now that queued
    //    deltas above have been applied); otherwise fall back to whatever's
    //    cached in IDB so the Box bar still shows real numbers offline.
    if (navigator.onLine) {
        const rows = await _sbGetBox();
        if (rows) {
            await _boxIdbPutAll(rows);
            if (typeof window._applyBoxRows === 'function') window._applyBoxRows(rows, true);
        }
    } else {
        const rows = await _boxIdbGetAll().catch(() => []);
        if (typeof window._applyBoxRows === 'function') window._applyBoxRows(rows, true);
    }
};

// Adjust one item's box numbers — updates the local cache + UI instantly
// (works with zero connectivity), then pushes to Supabase or queues it.
window._writeBoxAdjust = async function(id, qtyDelta, cookedDelta) {
    const rows     = await _boxIdbGetAll().catch(() => []);
    const existing = rows.find(r => r.id === id) || { id, qty: 0, cooked_total: 0 };
    const updated  = {
        id,
        qty:          Math.max(0, existing.qty + qtyDelta),
        cooked_total: Math.max(0, existing.cooked_total + cookedDelta)
    };
    await _boxIdbPut(updated);
    if (typeof window._applyBoxRows === 'function') window._applyBoxRows([updated]);

    if (navigator.onLine) {
        const ok = await _sbAdjustBox(id, qtyDelta, cookedDelta);
        if (!ok) _boxQueue.push({ id, qtyDelta, cookedDelta });
    } else {
        _boxQueue.push({ id, qtyDelta, cookedDelta });
    }
};

// Day-close reset — zeroes the local cache immediately (so it's correct even
// offline), then pushes the reset to Supabase or defers it (see _boxResetPending).
window._resetBoxLocal = async function() {
    const rows   = await _boxIdbGetAll().catch(() => []);
    const zeroed = rows.map(r => ({ id: r.id, qty: 0, cooked_total: 0 }));
    if (zeroed.length) await _boxIdbPutAll(zeroed);
    if (typeof window._applyBoxRows === 'function') window._applyBoxRows(zeroed, true);

    // A fresh day supersedes any older queued deltas — they no longer apply.
    _boxQueue = [];

    if (navigator.onLine) {
        const ok = await _sbResetBox();
        if (!ok) _boxResetPending = true;
    } else {
        _boxResetPending = true;
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

// Pulls shop-open, busy thresholds, business name, contact info, kuah
// ratio, and preorder-enabled from Supabase and applies them locally. Used
// on startup, and ALSO whenever the 'settings' table changes on another
// device (see connectRealtime's postgres_changes handler) or on the
// periodic poll — otherwise a toggle made on one admin device (e.g.
// opening/closing the shop) would only ever show up on other admin
// devices after a manual refresh, since nothing was re-pulling it live.
async function syncSettingsFromCloud() {
    try {
        const remote = await window._readShopStatus();
        if (remote !== null) {
            localStorage.setItem('shmShopOpen', remote ? '1' : '0');
            if (typeof initShopToggle === 'function') initShopToggle();
        }
    } catch(e) { console.warn('Shop status sync error:', e); }

    try {
        if (typeof BUSY_SETTINGS !== 'undefined') {
            for (const s of BUSY_SETTINGS) {
                const value = await window._readSetting(s.key);
                if (value !== null) localStorage.setItem(s.storageKey, s.type === 'bool' ? (value === 'true' || value === '1' ? '1' : '0') : value);
            }
        }
        if (typeof initBusyThresholds === 'function') initBusyThresholds();
    } catch(e) { console.warn('Threshold sync error:', e); }

    try {
        const name = await window._readSetting('businessName');
        if (name) {
            localStorage.setItem('shmBusinessName', name);
            if (typeof initBusinessName === 'function') initBusinessName();
        }
    } catch(e) { console.warn('Business name sync error:', e); }

    try {
        const phone   = await window._readSetting('contactPhone');
        const email   = await window._readSetting('contactEmail');
        const address = await window._readSetting('contactAddress');
        if (phone   !== null) localStorage.setItem('shmContactPhone', phone);
        if (email   !== null) localStorage.setItem('shmContactEmail', email);
        if (address !== null) localStorage.setItem('shmContactAddress', address);
        if (typeof initContactUs === 'function') initContactUs();
    } catch(e) { console.warn('Contact Us sync error:', e); }

    try {
        const ratio = await window._readSetting('kuahRatio');
        if (ratio) {
            localStorage.setItem('shmKuahRatio', ratio);
            if (typeof initKuahRatio === 'function') initKuahRatio();
        }
    } catch(e) { console.warn('Kuah ratio sync error:', e); }

    try {
        const pre = await window._readSetting('preorderEnabled');
        if (pre !== null) {
            localStorage.setItem('shmPreorderEnabled', pre === 'true' ? '1' : '0');
            if (typeof initPreorderToggle === 'function') initPreorderToggle();
        }
    } catch(e) { console.warn('Preorder toggle sync error:', e); }
}

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
