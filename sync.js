// sync.js — GitHub Gist sync with offline queue
// ─────────────────────────────────────────────
// HOW TO SET UP:
//   1. Go to GitHub → Settings → Developer Settings →
//      Personal access tokens → Tokens (classic) → Generate new token
//      Scopes needed: "gist" only
//   2. Go to https://gist.github.com → New secret gist
//      Filename: orders.json   Content: []
//      Copy the Gist ID from the URL (the long hash after your username)
//   3. Paste both below and redeploy your PWA.
// ─────────────────────────────────────────────

const GITHUB_TOKEN  = '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';        // ← your GitHub PAT
const GIST_ID       = 'https://gist.github.com/brookrthesoul/52c82390c62650ca99e807c54bc1720e#file-orders-json-L1';        // ← your Gist ID
const GIST_FILENAME = 'orders.json';

// ─── Prevent re-entrant syncs ────────────────────────────────────────────────
let _syncing = false;

// ─── IndexedDB: sync queue store ─────────────────────────────────────────────
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

// ─── GitHub Gist helpers ──────────────────────────────────────────────────────

function isConfigured() {
    return GITHUB_TOKEN.trim() !== '' && GIST_ID.trim() !== '';
}

async function fetchOrdersFromGist() {
    const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
        headers: {
            Authorization: `Bearer ${GITHUB_TOKEN}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28'
        }
    });
    if (res.status === 401) throw new Error('GitHub 401 — token invalid or expired. Re-check your GITHUB_TOKEN in sync.js.');
    if (res.status === 404) throw new Error('GitHub 404 — Gist not found. Re-check your GIST_ID in sync.js.');
    if (!res.ok) throw new Error(`GitHub fetch failed: ${res.status} ${res.statusText}`);
    const data    = await res.json();
    const content = data.files?.[GIST_FILENAME]?.content;
    if (!content) return [];
    try { return JSON.parse(content); } catch { return []; }
}

async function pushOrdersToGist(orders) {
    const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
        method: 'PATCH',
        headers: {
            Authorization: `Bearer ${GITHUB_TOKEN}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            files: { [GIST_FILENAME]: { content: JSON.stringify(orders, null, 2) } }
        })
    });
    if (res.status === 401) throw new Error('GitHub 401 — token invalid or expired.');
    if (!res.ok) throw new Error(`GitHub push failed: ${res.status} ${res.statusText}`);
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

// ─── Core sync (uses RAW db functions — no re-entry) ─────────────────────────

async function syncNow() {
    if (!isConfigured()) {
        showSyncToast('⚠️ GitHub sync not configured — open sync.js and fill in GITHUB_TOKEN and GIST_ID.');
        setSyncStatus('unconfigured');
        return;
    }
    if (_syncing) return; // already in progress
    _syncing = true;
    setSyncStatus('syncing');

    try {
        // 1. Fetch remote
        const remoteOrders = await fetchOrdersFromGist();
        // 2. Read local using RAW function (bypasses our patch)
        const localOrders  = await _rawGetAll();
        // 3. Merge
        const merged = mergeOrders(localOrders, remoteOrders);
        // 4. Write merged back to local using RAW functions
        for (const order of merged) {
            await _rawUpdate(order);
        }
        // 5. Push merged to Gist
        await pushOrdersToGist(merged);
        await clearQueue();

        setSyncStatus('ok');
        loadOrders();
        showSyncToast('✅ Synced with GitHub');
    } catch (e) {
        console.error('Sync error:', e);
        setSyncStatus('error');
        // Show the actual error, not a generic message
        showSyncToast('❌ ' + e.message);
    } finally {
        _syncing = false;
    }
}

async function drainQueue() {
    if (!isConfigured()) return;
    const queue = await getQueue();
    if (queue.length === 0) return;
    await syncNow();
}

// ─── Raw IndexedDB access (used internally — bypasses the patched wrappers) ──

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

// ─── Patch db.js public functions (add updatedAt + trigger sync) ─────────────

function patchDbFunctions() {
    // Capture raw originals BEFORE patching
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
        // Don't stamp updatedAt if this is an internal sync write
        if (!_syncing) order.updatedAt = Date.now();
        const result = await origUpdate(order);
        if (!_syncing) _scheduleSync();
        return result;
    };

    window.deleteOrder = async function(id) {
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

// ─── Online / offline event listeners ────────────────────────────────────────

window.addEventListener('online', async () => {
    updateOnlineBadge(true);
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
        ok:           { icon: '✅', text: 'Synced',        cls: 'sync-ok'      },
        syncing:      { icon: '🔄', text: 'Syncing…',      cls: 'sync-syncing' },
        error:        { icon: '❌', text: 'Sync error',    cls: 'sync-error'   },
        offline:      { icon: '📴', text: 'Offline',       cls: 'sync-offline' },
        unconfigured: { icon: '⚙️', text: 'Not set up',   cls: 'sync-warn'    },
    };
    const s = map[state] || map.unconfigured;
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

    if (!isConfigured()) {
        setSyncStatus('unconfigured');
        return;
    }

    if (navigator.onLine) {
        await syncNow();
    } else {
        setSyncStatus('offline');
    }
});
