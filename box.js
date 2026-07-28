// ═══════════════════════════════════════════════════════════════════════════
// BOX STOCK — "prepared items box" (Prepare tab)
// ═══════════════════════════════════════════════════════════════════════════
// UNIFIED MODEL (v2) — Stock (stock.js) and Box are the SAME underlying
// inventory, just in a different state:
//   Stock = raw, not yet cooked.   Box = cooked, ready to pack.
// Cooking is the "raw → cooked" conversion — see cookIntoBox() below, which
// deducts Stock by the same amount it adds to the Box.
//
// Box qty changes at exactly three points, matching the real physical flow:
//   1. Cooking:        cookIntoBox()        — Box up, Stock down (same amount)
//   2. Packing an order (Ready button):   deductBoxForPacking() — Box down
//      — see markPrepared() in orders.js. This is the ONLY place an order's
//      items ever leave the Box; placing an order does NOT touch the Box.
//   3. Cancelling an already-packed-but-unpaid order: returnItemsToBox()
//      — Box up again (already cooked, still good for the next order) — see
//      deleteOrderConfirm() in orders.js. Cancelling BEFORE Ready needs no
//      action (nothing was ever taken). Cancelling AFTER payment needs no
//      action either — the sale is already final either way.
//   4. Manual adjustment (the Box popup) — steppers, works like #1 for an
//      increase (also deducts Stock) and like a plain removal for a decrease
//      (Stock untouched — matches "grabbed from the box" or a correction).
//
// The "still need to cook" number (skewer/custom-unit summary bar — see
// updateSateSummaryBar in orders.js) is now a LIVE calculation, not a running
// counter: remaining = (items needed across Prepare orders) − (Box qty). This
// self-corrects automatically and stays in sync with #2 above by
// construction, since an order's items leave the Prepare tally at the exact
// same moment #2 removes them from the Box.
//
// The customer-facing busy/not-busy badge (see loadBusy() in order.html)
// uses this same formula.
//
// Whether NEW orders can even be placed is a separate, purely informational
// LIVE check — see place_customer_order / saveOrder() — nothing is deducted
// there; see box_stock_v2_unified.sql for the full explanation.
//
// (cooked_total still exists as an unused column in box_stock for backwards
// compatibility with the DB schema — it's no longer read or written here.)
//
// Lives in Supabase (table `box_stock`) rather than localStorage, on purpose
// — the customer's own online order page also needs to see it, and that
// happens on a completely different device than this admin dashboard.
//
// OFFLINE: fully supported, same pattern as stock.js/sync.js — every read
// comes from an IndexedDB cache first (instant, works with zero connection)
// and every write updates that cache immediately too. Writes made offline
// get queued and automatically replayed once the connection comes back (see
// window._syncBox / _writeBoxAdjust / _resetBoxLocal in sync.js) — nothing
// typed in while offline is ever silently lost. cookIntoBox()'s Stock side
// reuses stock.js's setStockFor(), which has its own separate, equally
// offline-safe queue (see sync.js's stock section) — so a cooking entry made
// offline correctly updates both numbers locally and syncs both once back
// online, even though they're two different underlying queues.
//
// ── EASY-TO-ADJUST NOTES ─────────────────────────────────────────────────
// • Only items in BOX_TRACKED_CATEGORIES are Box-aware. Add/remove category
//   strings here to change what the Box applies to.
// • Day-close calls resetBoxStock() — see autoClosePreviousDay() in
//   orders.js — which zeroes the Box for every item via reset_box_stock().
//   Stock is untouched by day-close (restocking is a separate, manual Settings
//   action) — only the Box (today's cooked buffer) resets automatically.
// ═══════════════════════════════════════════════════════════════════════════

const BOX_TRACKED_CATEGORIES = ['skewer', 'no-kuah', 'custom-unit'];

let boxData        = {}; // { itemId: { qty, cooked_total } } — local cache of box_stock
let _boxModalItemId = null;

// ── Loading / syncing ───────────────────────────────────────────────────────
// The actual Supabase + IndexedDB + offline-queue plumbing lives in sync.js
// (window._syncBox / _writeBoxAdjust / _resetBoxLocal) so it follows the
// exact same local-first, works-offline pattern as stock.js — box.js just
// calls into it and handles rendering.

// window._applyBoxRows is how sync.js hands updated rows back to us —
// replace=true for a full refresh (Supabase or IDB fallback), falsy for a
// single-item merge (an individual adjustment just applied locally).
window._applyBoxRows = function(rows, replace) {
    if (replace) boxData = {};
    (rows || []).forEach(r => { boxData[r.id] = { qty: r.qty, cooked_total: r.cooked_total }; });
    renderBoxBar();
    if (typeof updateSateSummaryBar === 'function') {
        updateSateSummaryBar(_lastPrepareOrdersForSate || []);
    }
};

async function loadBoxStock() {
    if (typeof window._syncBox === 'function') {
        await window._syncBox();
    } else {
        // Shouldn't normally happen — sync.js not loaded yet/failed
        console.warn('window._syncBox unavailable — Box will not sync');
        renderBoxBar();
    }
}

function getBoxQty(id)         { return (boxData[id] && boxData[id].qty) || 0; }
function getBoxCookedTotal(id) { return (boxData[id] && boxData[id].cooked_total) || 0; }

// Add/remove box stock. Works offline — see window._writeBoxAdjust in
// sync.js: the local cache + UI update instantly either way; the write to
// Supabase either goes through now (online) or gets queued and replayed
// automatically once the connection comes back (see the 'online' listener
// in sync.js), so nothing is ever silently lost.
async function adjustBoxStock(id, qtyDelta, cookedDelta = 0) {
    if (typeof window._writeBoxAdjust === 'function') {
        await window._writeBoxAdjust(id, qtyDelta, cookedDelta);
    } else {
        console.warn('window._writeBoxAdjust unavailable — Box change not saved');
    }
    return true;
}

// Day-close — see autoClosePreviousDay() in orders.js. Offline-safe: zeroes
// the local cache immediately either way (see window._resetBoxLocal).
async function resetBoxStock() {
    if (typeof window._resetBoxLocal === 'function') {
        await window._resetBoxLocal();
    } else {
        console.warn('window._resetBoxLocal unavailable — Box was not reset');
    }
}

// ── Cooking: raw Stock → cooked Box (the ONLY place Stock gets touched by
// the Box system). Called from adjustBoxModalInput/applyBoxModalInputChange
// below for a manual increase (see index.html's Box modal).
// Never blocks — if addedQty exceeds what Stock shows, Stock just clamps to
// 0 (same "trust the staff over the number" pattern used everywhere else in
// this app, e.g. deductStock/adjustStockUI in stock.js).
async function cookIntoBox(id, addedQty) {
    if (addedQty <= 0) return;
    const currentStock = (typeof getStockFor === 'function') ? getStockFor(id) : null;
    if (currentStock !== null && currentStock !== undefined) {
        // null/undefined = unlimited (no stock row) — leave it untouched.
        const newStock = Math.max(0, currentStock - addedQty);
        if (typeof setStockFor === 'function') setStockFor(id, newStock);
    }
    await adjustBoxStock(id, addedQty);
}

// ── Packing (Ready button, Prepare → Prepared) — see markPrepared() in
// orders.js. Takes this order's Box-tracked items out of the Box. Never
// blocks and never touches Stock (that was already spent when it was cooked).
async function deductBoxForPacking(items) {
    for (const [id, item] of Object.entries(items || {})) {
        if (item.qty > 0 && BOX_TRACKED_CATEGORIES.includes(item.category)) {
            await adjustBoxStock(id, -item.qty);
        }
    }
}

// ── Un-packing (cancelling an order that's already Prepared but not yet
// paid) — see deleteOrderConfirm() in orders.js. Puts the already-cooked
// items back in the Box for the next order. Never touches Stock.
async function returnItemsToBox(items) {
    for (const [id, item] of Object.entries(items || {})) {
        if (item.qty > 0 && BOX_TRACKED_CATEGORIES.includes(item.category)) {
            await adjustBoxStock(id, item.qty);
        }
    }
}

// ── UI: the Box bar (top of the Prepare tab, next to "Customer Orders") ────
function renderBoxBar() {
    const bar = document.getElementById('boxSummaryBar');
    if (!bar) return;
    const menuById = {};
    getMenuItems().forEach(m => { menuById[m.id] = m.name; });

    const entries = Object.entries(boxData).filter(([id, d]) => d.qty > 0 && menuById[id]);
    const chips = entries.map(([id, d]) =>
        `<span class="box-chip" onclick="openBoxModal('${id}')" role="button" tabindex="0">📦 <strong>${d.qty}</strong> ${escapeHtml(menuById[id])}</span>`
    ).join('');

    bar.innerHTML = chips +
        `<span class="box-chip box-chip-add" onclick="openBoxAddPicker()" role="button" tabindex="0">+ Add</span>`;
}

// ── UI: edit an existing Box item (steppers + exact number, auto-saves) ────
function openBoxModal(id) {
    _boxModalItemId = id;
    const menuById = {};
    getMenuItems().forEach(m => { menuById[m.id] = m.name; });
    document.getElementById('boxModalTitle').textContent = `📦 ${menuById[id] || id}`;
    document.getElementById('boxModalQtyLabel').textContent = 'Box quantity';
    document.getElementById('boxModalInput').value = getBoxQty(id);
    document.getElementById('boxModalInput').disabled = false;
    document.getElementById('boxModalPicker').style.display = 'none';
    document.getElementById('boxModalInputRow').style.display = '';
    showModalById('boxModal');
}

// "+ Add" — shows a grid of item-name buttons (3 per row) AND the quantity
// section together on one screen. The quantity controls stay disabled until
// an item button is tapped; tapping one enables them immediately, no
// separate "confirm" step.
function openBoxAddPicker() {
    _boxModalItemId = null;
    const picker = document.getElementById('boxModalPicker');
    const menuItems = getMenuItems().filter(m => BOX_TRACKED_CATEGORIES.includes(m.category));
    picker.innerHTML = menuItems.map(m =>
        `<button type="button" class="box-picker-btn" data-item-id="${m.id}" onclick="selectBoxAddItem('${m.id}')">${escapeHtml(m.name)}</button>`
    ).join('');
    picker.style.display = 'grid';
    document.getElementById('boxModalTitle').textContent = '📦 Add item to Box — pick one';
    document.getElementById('boxModalQtyLabel').textContent = 'Tap an item above first';
    const input = document.getElementById('boxModalInput');
    input.value = '';
    input.disabled = true;
    document.getElementById('boxModalInputRow').style.display = '';
    showModalById('boxModal');
}

// Tapping an item button above selects it immediately (highlights it) and
// enables the quantity section right below for it — same auto-save steppers
// as editing an item already in the box.
function selectBoxAddItem(id) {
    _boxModalItemId = id;
    document.querySelectorAll('#boxModalPicker .box-picker-btn').forEach(btn => {
        btn.classList.toggle('box-picker-btn-selected', btn.dataset.itemId === id);
    });
    const menuById = {};
    getMenuItems().forEach(m => { menuById[m.id] = m.name; });
    document.getElementById('boxModalQtyLabel').textContent = `Box quantity — ${menuById[id] || id}`;
    const input = document.getElementById('boxModalInput');
    input.value = getBoxQty(id);
    input.disabled = false;
}

function closeBoxModal() {
    hideModalById('boxModal');
}

// Steppers auto-save immediately — each tap both updates the number shown
// and commits the change (cookIntoBox for a rise, a plain Box-only removal
// for a drop), no separate Save button needed.
async function adjustBoxModalInput(delta) {
    const id = _boxModalItemId;
    if (!id) return; // "+ Add" flow, before an item's been picked yet
    const input   = document.getElementById('boxModalInput');
    const current = Math.max(0, parseInt(input.value) || 0);
    const newVal  = Math.max(0, current + delta);
    input.value = newVal;
    if (delta > 0) await cookIntoBox(id, delta);
    else if (delta < 0) await adjustBoxStock(id, delta);
}

// Typing an exact number and tabbing/clicking away (or hitting Enter) saves
// it the same way — computed as a delta from the current stored qty.
async function applyBoxModalInputChange() {
    const id = _boxModalItemId;
    if (!id) return;
    const input   = document.getElementById('boxModalInput');
    const newVal  = Math.max(0, parseInt(input.value) || 0);
    const current = getBoxQty(id);
    const delta   = newVal - current;
    input.value = newVal;
    if (delta > 0) await cookIntoBox(id, delta);
    else if (delta < 0) await adjustBoxStock(id, delta);
}

// Also auto-saves — zeroes this item's Box qty immediately.
async function resetBoxModalInput() {
    const id = _boxModalItemId;
    if (!id) return;
    const current = getBoxQty(id);
    document.getElementById('boxModalInput').value = 0;
    if (current > 0) await adjustBoxStock(id, -current);
}
