
// ─── Stock management ─────────────────────────────────────────────────────────
// Stock is stored in localStorage as { itemId: qty }
// It is global across the day — restocking is done via Settings.

const STOCK_KEY = 'shmStock';

function getStock() {
    try { return JSON.parse(localStorage.getItem(STOCK_KEY)) || {}; }
    catch(_) { return {}; }
}

function saveStock(stock) {
    // saveStock only updates localStorage — callers handle Supabase sync individually
    localStorage.setItem(STOCK_KEY, JSON.stringify(stock));
}

function getStockFor(id) {
    return getStock()[id] ?? null; // null = not set (unlimited)
}

function setStockFor(id, qty) {
    const s    = getStock();
    s[id]      = Math.max(0, qty);
    localStorage.setItem(STOCK_KEY, JSON.stringify(s));
    // Only write this one item to Supabase
    if (typeof window._writeStock === 'function') {
        window._writeStock(id, Math.max(0, qty));
    }
}

// Deduct stock for an order's items. Returns true if successful, false if insufficient.
function deductStock(items) {
    const stock = getStock();
    // First pass — check all
    for (const [id, item] of Object.entries(items)) {
        if (item.qty <= 0) continue;
        if (stock[id] !== undefined && stock[id] !== null) {
            if (stock[id] < item.qty) return { ok: false, id, name: item.name, available: stock[id], requested: item.qty };
        }
    }
    // Second pass — deduct
    for (const [id, item] of Object.entries(items)) {
        if (item.qty <= 0) continue;
        if (stock[id] !== undefined && stock[id] !== null) {
            stock[id] = Math.max(0, stock[id] - item.qty);
        }
    }
    // Write each deducted item to Supabase
    for (const [id, item] of Object.entries(items)) {
        if (item.qty <= 0) continue;
        if (stock[id] !== undefined && stock[id] !== null) {
            if (typeof window._writeStock === 'function') window._writeStock(id, stock[id]);
        }
    }
    localStorage.setItem(STOCK_KEY, JSON.stringify(stock));
    updateStockIndicators();
    return { ok: true };
}

// Return stock when order is cancelled or items reduced via edit
function returnStock(items) {
    const stock = getStock();
    for (const [id, item] of Object.entries(items)) {
        if (item.qty <= 0) continue;
        if (stock[id] !== undefined && stock[id] !== null) {
            stock[id] += item.qty;
            if (typeof window._writeStock === 'function') window._writeStock(id, stock[id]);
        }
    }
    localStorage.setItem(STOCK_KEY, JSON.stringify(stock));
    updateStockIndicators();
}

// Adjust stock on edit: diff per item (positive = deduct more, negative = return)
function adjustStock(oldItems, newItems) {
    const stock = getStock();
    // Check if we can deduct the extra amounts
    for (const id of new Set([...Object.keys(oldItems), ...Object.keys(newItems)])) {
        const oldQty = (oldItems[id] && oldItems[id].qty) || 0;
        const newQty = (newItems[id] && newItems[id].qty) || 0;
        const diff   = newQty - oldQty; // positive = need more stock
        if (diff > 0 && stock[id] !== undefined && stock[id] !== null) {
            if (stock[id] < diff) {
                const name = (newItems[id] && newItems[id].name) || id;
                return { ok: false, id, name, available: stock[id], requested: diff };
            }
        }
    }
    // Apply adjustments
    for (const id of new Set([...Object.keys(oldItems), ...Object.keys(newItems)])) {
        const oldQty = (oldItems[id] && oldItems[id].qty) || 0;
        const newQty = (newItems[id] && newItems[id].qty) || 0;
        const diff   = newQty - oldQty;
        if (stock[id] !== undefined && stock[id] !== null) {
            stock[id] = Math.max(0, stock[id] - diff);
        }
    }
    // Write each deducted item to Supabase
    for (const [id, item] of Object.entries(items)) {
        if (item.qty <= 0) continue;
        if (stock[id] !== undefined && stock[id] !== null) {
            if (typeof window._writeStock === 'function') window._writeStock(id, stock[id]);
        }
    }
    localStorage.setItem(STOCK_KEY, JSON.stringify(stock));
    updateStockIndicators();
    return { ok: true };
}

// Update stock indicator labels on the home/new order page
function updateStockIndicators() {
    const stock = getStock();
    getMenuItems().forEach(item => {
        const el = document.getElementById(`stock-indicator-${item.id}`);
        if (!el) return;
        const qty = stock[item.id];
        if (qty === undefined || qty === null) {
            el.textContent = '';
            el.className = 'stock-indicator';
        } else if (qty === 0) {
            el.textContent = 'Out of stock';
            el.className = 'stock-indicator stock-out';
        } else if (qty <= 10) {
            el.textContent = `${qty} left`;
            el.className = 'stock-indicator stock-low';
        } else {
            el.textContent = `${qty} left`;
            el.className = 'stock-indicator stock-ok';
        }
    });
}

// Render Manage Stock section in Settings
function renderStockManager() {
    const container = document.getElementById('stockManagerList');
    if (!container) return;
    const stock = getStock();
    container.innerHTML = getMenuItems().map(item => {
        const qty = stock[item.id] ?? '';
        return `
        <div class="stock-row">
            <span class="stock-item-name">${escapeHtml(item.name)}</span>
            <div class="stock-input-group">
                <button onclick="adjustStockUI('${item.id}', -10)">-10</button>
                <button onclick="adjustStockUI('${item.id}', -1)">-1</button>
                <input type="number" id="stock-input-${item.id}" min="0" step="1"
                    value="${qty}" placeholder="—"
                    onchange="saveStockFromInput('${item.id}')">
                <button onclick="adjustStockUI('${item.id}', +1)">+1</button>
                <button onclick="adjustStockUI('${item.id}', +10)">+10</button>
            </div>
            <span class="stock-status-label" id="stock-label-${item.id}"></span>
        </div>`;
    }).join('');
    _updateStockManagerLabels();
}

function _updateStockManagerLabels() {
    const stock = getStock();
    getMenuItems().forEach(item => {
        const el = document.getElementById(`stock-label-${item.id}`);
        if (!el) return;
        const qty = stock[item.id];
        if (qty === undefined || qty === null) { el.textContent = 'No limit'; el.style.color = '#999'; }
        else if (qty === 0) { el.textContent = 'Out of stock'; el.style.color = '#dc3545'; }
        else if (qty <= 10) { el.textContent = `${qty} remaining`; el.style.color = '#fd7e14'; }
        else { el.textContent = `${qty} remaining`; el.style.color = '#28a745'; }
    });
}

function saveStockFromInput(id) {
    const input = document.getElementById(`stock-input-${id}`);
    if (!input) return;
    const val = input.value.trim();
    if (val === '' || val === '—') {
        // Clear stock limit for this item
        const s = getStock();
        delete s[id];
        saveStock(s);
    } else {
        setStockFor(id, parseInt(val) || 0);
    }
    _updateStockManagerLabels();
    updateStockIndicators();
}

function adjustStockUI(id, delta) {
    const input = document.getElementById(`stock-input-${id}`);
    if (!input) return;
    const current = parseInt(input.value) || 0;
    const newVal  = Math.max(0, current + delta);
    input.value   = newVal;
    setStockFor(id, newVal);
    _updateStockManagerLabels();
    updateStockIndicators();
}

// Live input validation on new order page
function checkStockInput(id, value) {
    const el  = document.getElementById(`stock-indicator-${id}`);
    if (!el) return;
    const qty   = parseInt(value) || 0;
    const stock = getStock();
    const avail = stock[id];
    if (avail === undefined || avail === null) { el.textContent = ''; el.className = 'stock-indicator'; return; }
    if (qty === 0) {
        // Just show current stock
        updateStockIndicators();
        return;
    }
    if (avail === 0) {
        el.textContent = 'Out of stock';
        el.className   = 'stock-indicator stock-out';
    } else if (qty > avail) {
        el.textContent = `Insufficient — only ${avail} left`;
        el.className   = 'stock-indicator stock-out';
    } else {
        const remaining = avail - qty;
        el.textContent  = `${avail} left → ${remaining} after this order`;
        el.className    = remaining <= 10 ? 'stock-indicator stock-low' : 'stock-indicator stock-ok';
    }
}
