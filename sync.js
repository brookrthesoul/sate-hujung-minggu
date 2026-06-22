// sync.js — GitHub Gist sync with offline queue
// ─────────────────────────────────────────────
// HOW TO SET UP:
//   1. Create a GitHub Personal Access Token:
//      GitHub → Settings → Developer Settings → Personal access tokens → Tokens (classic)
//      Scopes needed: "gist"
//   2. Create a new Secret Gist at https://gist.github.com
//      Add a file named: orders.json  with content: []
//      Copy the Gist ID from the URL: gist.github.com/<username>/<GIST_ID>
//   3. Fill in GITHUB_TOKEN and GIST_ID below, then redeploy your PWA.
// ─────────────────────────────────────────────

const GITHUB_TOKEN = '';   // ← paste your GitHub PAT here
const GIST_ID      = '';   // ← paste your Gist ID here
const GIST_FILENAME = 'orders.json';

// ─── Sync queue store in IndexedDB ───────────────────────────────────────────
const QUEUE_STORE = 'syncQueue';

async function openSyncDB() {
    return new Promise((resolve, reject) => {
        // We piggyback on the existing OrdersDB but need to add the syncQueue store.
        // We do this by opening with a higher version than db.js uses (v1 → v2).
        const request = indexedDB.open('OrdersDB', 2);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
        request.onupgradeneeded = (ev) => {
            const db = ev.target.result;
            // Create syncQueue if it doesn't exist yet
            if (!db.objectStoreNames.contains(QUEUE_STORE)) {
                db.createObjectStore(QUEUE_STORE, { keyPath: 'queueId', autoIncrement: true });
            }
        };
    });
}

async function enqueueAction(action) {
    // action: { type: 'upsert'|'delete', order, orderId, timestamp }
    const db = await openSyncDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(QUEUE_STORE, 'readwrite');
        tx.objectStore(QUEUE_STORE).add({ ...action, timestamp: Date.now() });
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
    });
}

async function getQueue() {
    const db = await openSyncDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(QUEUE_STORE, 'readonly');
        const req = tx.objectStore(QUEUE_STORE).getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function clearQueue() {
    const db = await openSyncDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(QUEUE_STORE, 'readwrite');
        tx.objectStore(QUEUE_STORE).clear();
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
    });
}

// ─── GitHub Gist helpers ──────────────────────────────────────────────────────

function isConfigured() {
    return GITHUB_TOKEN.trim() !== '' && GIST_ID.trim() !== '';
}

async function fetchOrdersFromGist() {
    const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
        headers: {
            Authorization: `token ${GITHUB_TOKEN}`,
            Accept: 'application/vnd.github+json'
        }
    });
    if (!res.ok) throw new Error(`GitHub fetch failed: ${res.status} ${res.statusText}`);
    const data = await res.json();
    const content = data.files?.[GIST_FILENAME]?.content;
    if (!content) return [];
    return JSON.parse(content);
}

async function pushOrdersToGist(orders) {
    const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
        method: 'PATCH',
        headers: {
            Authorization: `token ${GITHUB_TOKEN}`,
            Accept: 'application/vnd.github+json',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            files: {
                [GIST_FILENAME]: { content: JSON.stringify(orders, null, 2) }
            }
        })
    });
    if (!res.ok) throw new Error(`GitHub push failed: ${res.status} ${res.statusText}`);
}

// ─── Core sync logic ──────────────────────────────────────────────────────────

// Pull remote orders → merge into local IndexedDB (remote wins on conflict)
async function pullFromGist() {
    if (!isConfigured()) return;
    setSyncStatus('syncing');
    try {
        const remoteOrders = await fetchOrdersFromGist();
        const localOrders = await getAllOrders();

        // Build a map of local orders by id
        const localMap = {};
        localOrders.forEach(o => { localMap[o.id] = o; });

        let changed = false;
        for (const remote of remoteOrders) {
            const local = localMap[remote.id];
            // Remote wins if newer or not present locally
            if (!local || remote.updatedAt > (local.updatedAt || 0)) {
                await updateOrder(remote);
                changed = true;
            }
            delete localMap[remote.id]; // mark as seen
        }

        // Any remaining localMap entries are local-only (not yet pushed)
        // Leave them; they'll be pushed on next pushToGist().

        setSyncStatus('ok');
        if (changed) {
            loadOrders(); // refresh UI
            showSyncToast('📥 Orders updated from GitHub');
        }
    } catch (e) {
        console.warn('Pull failed:', e);
        setSyncStatus('error');
    }
}

// Push all local orders → Gist (full replace)
async function pushToGist() {
    if (!isConfigured()) return;
    setSyncStatus('syncing');
    try {
        const orders = await getAllOrders();
        await pushOrdersToGist(orders);
        await clearQueue(); // all pending changes are now synced
        setSyncStatus('ok');
    } catch (e) {
        console.warn('Push failed:', e);
        setSyncStatus('error');
    }
}

// Full two-way sync: pull first, then push merged result
async function syncNow() {
    if (!isConfigured()) {
        showSyncToast('⚠️ GitHub sync not configured. See sync.js for setup instructions.');
        return;
    }
    setSyncStatus('syncing');
    try {
        // 1. Pull remote changes into local DB
        const remoteOrders = await fetchOrdersFromGist();
        const localOrders  = await getAllOrders();

        const merged = mergeOrders(localOrders, remoteOrders);

        // 2. Write merged result back to local IndexedDB
        for (const order of merged) {
            await updateOrder(order);
        }

        // 3. Push merged result to Gist
        await pushOrdersToGist(merged);
        await clearQueue();

        setSyncStatus('ok');
        loadOrders(); // refresh UI
        showSyncToast('✅ Synced with GitHub');
    } catch (e) {
        console.error('Sync error:', e);
        setSyncStatus('error');
        showSyncToast('❌ Sync failed — will retry when online');
    }
}

// Merge strategy: last-write wins per order (by updatedAt timestamp)
function mergeOrders(local, remote) {
    const map = {};
    // Start with local
    local.forEach(o  => { map[o.id] = o; });
    // Remote overwrites if newer
    remote.forEach(o => {
        const existing = map[o.id];
        if (!existing || (o.updatedAt || 0) > (existing.updatedAt || 0)) {
            map[o.id] = o;
        }
    });
    return Object.values(map);
}

// ─── Offline queue drain ──────────────────────────────────────────────────────

async function drainQueue() {
    if (!isConfigured()) return;
    const queue = await getQueue();
    if (queue.length === 0) return;
    // We have pending changes — just do a full sync
    await syncNow();
}

// ─── Online / offline listeners ───────────────────────────────────────────────

window.addEventListener('online', async () => {
    console.log('🌐 Back online — syncing...');
    updateOnlineBadge(true);
    await drainQueue();
});

window.addEventListener('offline', () => {
    console.log('📴 Offline');
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
    // state: 'ok' | 'syncing' | 'error' | 'offline' | 'unconfigured'
    const el = document.getElementById('syncStatus');
    if (!el) return;
    const map = {
        ok:           { icon: '✅', text: 'Synced',     cls: 'sync-ok'       },
        syncing:      { icon: '🔄', text: 'Syncing…',   cls: 'sync-syncing'  },
        error:        { icon: '❌', text: 'Sync error', cls: 'sync-error'    },
        offline:      { icon: '📴', text: 'Offline',    cls: 'sync-offline'  },
        unconfigured: { icon: '⚙️', text: 'Not set up', cls: 'sync-warn'     },
    };
    const s = map[state] || map.unconfigured;
    el.innerHTML = `${s.icon} ${s.text}`;
    el.className = 'sync-status ' + s.cls;
    // Mirror in settings panel
    const el2 = document.getElementById('syncStatusSettings');
    if (el2) { el2.innerHTML = `${s.icon} ${s.text}`; el2.className = 'sync-status ' + s.cls; }
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
    _toastTimer = setTimeout(() => { toast.className = 'sync-toast'; }, 3500);
}

// ─── Stamp updatedAt on every order mutation ──────────────────────────────────
// Orders.js calls addOrder / updateOrder / deleteOrder from db.js.
// We wrap those here so we can intercept them and queue syncs.

const _origAdd    = window.addOrder    ? addOrder    : null;
const _origUpdate = window.updateOrder ? updateOrder : null;
const _origDelete = window.deleteOrder ? deleteOrder : null;

// Patched versions are applied after DOMContentLoaded (see bottom of file)
// because db.js functions may not be defined yet at parse time.

function patchDbFunctions() {
    const _add = addOrder;
    window.addOrder = async function(order) {
        order.updatedAt = Date.now();
        const id = await _add(order);
        if (navigator.onLine) {
            syncNow().catch(() => {});
        } else {
            await enqueueAction({ type: 'upsert', orderId: id });
        }
        return id;
    };

    const _update = updateOrder;
    window.updateOrder = async function(order) {
        order.updatedAt = Date.now();
        const result = await _update(order);
        if (navigator.onLine) {
            syncNow().catch(() => {});
        } else {
            await enqueueAction({ type: 'upsert', orderId: order.id });
        }
        return result;
    };

    const _delete = deleteOrder;
    window.deleteOrder = async function(id) {
        const result = await _delete(id);
        if (navigator.onLine) {
            syncNow().catch(() => {});
        } else {
            await enqueueAction({ type: 'delete', orderId: id });
        }
        return result;
    };
}

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
    // Patch db.js functions after they are defined
    patchDbFunctions();

    // Set initial online badge
    updateOnlineBadge(navigator.onLine);

    if (!isConfigured()) {
        setSyncStatus('unconfigured');
        return;
    }

    setSyncStatus('offline'); // default until first sync attempt

    // Initial pull on load (if online)
    if (navigator.onLine) {
        await syncNow();
    } else {
        setSyncStatus('offline');
    }
});
