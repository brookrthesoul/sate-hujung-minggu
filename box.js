// ═══════════════════════════════════════════════════════════════════════════
// BOX STOCK — "prepared items box" (Prepare tab)
// ═══════════════════════════════════════════════════════════════════════════
// See supabase/migrations/box_stock.sql for the full explanation of the data
// model — short version:
//
//   qty          – physical box quantity right now, ready to pack. Goes down
//                  automatically when an order draws from it (admin New
//                  Order form here, or a customer's own order — see the
//                  place_customer_order RPC), or manually when staff grab
//                  items without a formal order. Goes up when staff add a
//                  freshly-cooked batch via the Box popup.
//   cooked_total – running total of everything cooked into the box TODAY.
//                  Drives the "still need to cook" number in the skewer /
//                  custom-unit summary bar (see updateSateSummaryBar in
//                  orders.js): remaining = total ordered − cooked_total.
//
// Lives in Supabase (table `box_stock`) rather than localStorage, on purpose
// — the customer's own online order page also needs to see/deduct it, and
// that happens on a completely different device than this admin dashboard.
//
// OFFLINE: fully supported, same pattern as stock.js/sync.js — every read
// comes from an IndexedDB cache first (instant, works with zero connection)
// and every write updates that cache immediately too. Writes made offline
// get queued and automatically replayed once the connection comes back (see
// window._syncBox / _writeBoxAdjust / _resetBoxLocal in sync.js) — nothing
// typed in while offline is ever silently lost.
//
// ── EASY-TO-ADJUST NOTES (read this before changing behaviour) ─────────────
// • Only items in BOX_TRACKED_CATEGORIES are Box-aware. Add/remove category
//   strings here to change what the Box applies to.
// • Adding stock to the Box always bumps cooked_total by the same amount
//   (see openBoxModal/saveBoxModal below) — the assumption is anything put
//   into the box only got there by being freshly cooked. Removing stock
//   (grabbing from the box, or an order drawing from it) never touches
//   cooked_total — that stock was already counted as cooked earlier.
//   If you ever need a "correction" that removes stock WITHOUT it having
//   been cooked (e.g. fixing a data-entry mistake), that's the one case
//   this simple rule doesn't cover — you'd want a separate control for it.
// • Day-close calls resetBoxStock() — see autoClosePreviousDay() in
//   orders.js — which zeroes both numbers for every item via the
//   reset_box_stock() RPC.
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

// ── Order-time deduction (admin "New Order" walk-in form) ──────────────────
// Called from saveOrder() in orders.js BEFORE the raw-stock check, so the
// stock check can run against the smaller shortfall instead of the full
// ordered quantity. Returns { shortfallItems, boxUsed }:
//   shortfallItems – same shape as the items passed in, but qty replaced by
//                    "how much still needs fresh stock/cooking" for
//                    Box-tracked categories (untouched for everything else).
//   boxUsed        – { itemId: amount } actually available to take from the
//                    Box right now — NOT yet applied. Call applyBoxUsage()
//                    with this only after confirming the order will go
//                    through (see saveOrder()), so a failed stock check
//                    never leaves the Box wrongly drawn down.
function computeBoxUsage(items) {
    const shortfallItems = {};
    const boxUsed = {};
    Object.entries(items || {}).forEach(([id, item]) => {
        if (item.qty <= 0 || !BOX_TRACKED_CATEGORIES.includes(item.category)) {
            shortfallItems[id] = { ...item };
            return;
        }
        const avail = getBoxQty(id);
        const used  = Math.min(avail, item.qty);
        if (used > 0) boxUsed[id] = used;
        shortfallItems[id] = { ...item, qty: item.qty - used };
    });
    return { shortfallItems, boxUsed };
}

// Actually deduct the Box amounts computed above. cooked_total is
// deliberately left alone — see the header comment.
async function applyBoxUsage(boxUsed) {
    for (const [id, amount] of Object.entries(boxUsed || {})) {
        if (amount > 0) await adjustBoxStock(id, -amount, 0);
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

// ── UI: edit an existing Box item (steppers + exact number) ────────────────
function openBoxModal(id) {
    _boxModalItemId = id;
    const menuById = {};
    getMenuItems().forEach(m => { menuById[m.id] = m.name; });
    document.getElementById('boxModalTitle').textContent = `📦 ${menuById[id] || id}`;
    document.getElementById('boxModalInput').value = getBoxQty(id);
    document.getElementById('boxModalPicker').style.display = 'none';
    document.getElementById('boxModalInputRow').style.display = '';
    showModalById('boxModal');
}

// "+ Add" — shows a grid of item-name buttons instead of a dropdown, so
// picking which item to add is one tap instead of open-dropdown-then-select.
function openBoxAddPicker() {
    _boxModalItemId = null;
    const picker = document.getElementById('boxModalPicker');
    const menuItems = getMenuItems().filter(m => BOX_TRACKED_CATEGORIES.includes(m.category));
    picker.innerHTML = menuItems.map(m =>
        `<button type="button" class="box-picker-btn" onclick="selectBoxAddItem('${m.id}')">${escapeHtml(m.name)}</button>`
    ).join('');
    picker.style.display = 'flex';
    document.getElementById('boxModalInputRow').style.display = 'none';
    document.getElementById('boxModalTitle').textContent = '📦 Add item to Box — pick one';
    showModalById('boxModal');
}

// Tapping an item button above selects it immediately (no separate confirm
// step) and reveals the quantity input for it — same stepper flow as
// editing an item already in the box.
function selectBoxAddItem(id) {
    _boxModalItemId = id;
    const menuById = {};
    getMenuItems().forEach(m => { menuById[m.id] = m.name; });
    document.getElementById('boxModalTitle').textContent = `📦 ${menuById[id] || id}`;
    document.getElementById('boxModalInput').value = getBoxQty(id);
    document.getElementById('boxModalPicker').style.display = 'none';
    document.getElementById('boxModalInputRow').style.display = '';
}

function closeBoxModal() {
    hideModalById('boxModal');
}

function adjustBoxModalInput(delta) {
    const input = document.getElementById('boxModalInput');
    input.value = Math.max(0, (parseInt(input.value) || 0) + delta);
}

// Save = compute the delta from what's currently stored, then apply it.
// Going UP counts as "just cooked a fresh batch" (cooked_total rises too).
// Going DOWN does not touch cooked_total — see header comment for why.
async function saveBoxModal() {
    const id = _boxModalItemId;
    if (!id) { closeBoxModal(); return; }

    const newVal   = Math.max(0, parseInt(document.getElementById('boxModalInput').value) || 0);
    const current  = getBoxQty(id);
    const delta    = newVal - current;
    const cookedDelta = delta > 0 ? delta : 0;

    closeBoxModal();
    await adjustBoxStock(id, delta, cookedDelta);
}

function resetBoxModalInput() {
    document.getElementById('boxModalInput').value = 0;
}
