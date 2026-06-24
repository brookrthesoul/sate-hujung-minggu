// db.js — delegates all operations to sync.js (Supabase + IndexedDB cache)
// IndexedDB is managed entirely by sync.js. These functions are the public
// API called by orders.js, app.js etc. — they forward to sync.js internals.

const DB_NAME    = 'OrdersDB';
const DB_VERSION = 3;
const STORE_NAME = 'orders';

// openDB used by sync.js _idbOpen — keep it here so both files share one def
function openDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onerror   = () => reject(req.error);
        req.onsuccess = () => resolve(req.result);
        req.onupgradeneeded = (ev) => {
            const db = ev.target.result;
            if (db.objectStoreNames.contains(STORE_NAME)) {
                db.deleteObjectStore(STORE_NAME);
            }
            const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
            store.createIndex('createdAt', 'createdAt');
            if (db.objectStoreNames.contains('syncQueue')) {
                db.deleteObjectStore('syncQueue');
            }
        };
    });
}

// Test DB on load
(async function testDB() {
    try {
        await openDB();
        console.log('✅ Database ready');
    } catch (e) {
        alert('❌ IndexedDB error: ' + e.message);
    }
})();

// ─── Public API (called by orders.js / app.js) ────────────────────────────────
// These all delegate to sync.js functions which are defined on window.
// sync.js loads before db.js so they are always available.

async function getAllOrders() {
    // Read directly from local IndexedDB cache (populated by syncNow)
    return _idbGetAll();
}

async function addOrder(order) {
    // Insert to Supabase → cache locally → re-render
    return _sbAddOrder(order);
}

async function updateOrder(order) {
    // Update Supabase → update cache → re-render
    return _sbUpdateOrder(order);
}

async function deleteOrder(id) {
    // Delete from Supabase → delete from cache → re-render
    return _sbDeleteOrder(id);
}
