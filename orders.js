// orders.js — order calculation, rendering, and CRUD
// Flow: New Order → Prepare → (Prepared) → Paid → Done (Picked Up)
// Payment can be set at Prepare OR Prepared stage.
// If payment is set at Prepare → "Mark as Paid" skips Prepared and goes straight to Paid.
// If no payment at Prepare → "Done" moves to Prepared. Payment set there before "Mark as Paid".

// ---------- Helpers ----------
function formatDate(ts) {
    const d = new Date(ts);
    return d.toLocaleString(undefined, { year:'numeric', month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
}
function formatDay(ts) {
    const d = new Date(ts);
    return d.toLocaleDateString(undefined, { weekday:'long', year:'numeric', month:'long', day:'numeric' });
}

// Turn a locally-typed phone number (e.g. "0123456789") into a WhatsApp-ready
// international number (e.g. "60123456789") for wa.me links. Defaults to
// Malaysia (60) since numbers are entered without a country code.
function toWhatsAppNumber(phone) {
    let digits = String(phone || '').replace(/\D/g, '');
    if (!digits) return '';
    if (digits.startsWith('60')) return digits;      // already has country code
    if (digits.startsWith('0'))  return '60' + digits.slice(1);
    return '60' + digits;
}

function normalizeOrder(order) {
    // Backfill legacy flat-field orders into items shape
    if (!order.items) {
        const legacyIds = ['ayam','daging','lontong','shortong'];
        const items = {};
        legacyIds.forEach(id => {
            const qty  = order[id] || 0;
            const cost = order[`${id}Cost`] || 0;
            if (qty === 0 && cost === 0) return;
            const item = getMenuItem(id);
            items[id] = {
                name: item ? item.name : id.charAt(0).toUpperCase() + id.slice(1),
                category: item ? item.category : ((id==='ayam'||id==='daging') ? 'skewer' : 'side'),
                price: item ? item.price : (qty ? cost/qty : 0),
                qty, cost
            };
        });
        order = { ...order, items, totalCost: order.totalCost||0, skewerQty: order.ayamDagingQty||0, scoops: order.scoops||0 };
    }
    // Backfill prepared flag for old orders
    if (order.prepared === undefined) order.prepared = order.paid ? true : false;
    // Backfill payment fields
    if (order.paymentMethod  === undefined) order.paymentMethod  = null;
    if (order.paymentOnline  === undefined) order.paymentOnline  = 0;
    if (order.paymentCash    === undefined) order.paymentCash    = 0;
    // Backfill discount fields
    if (order.discountType   === undefined) order.discountType   = null;
    if (order.discountValue  === undefined) order.discountValue  = 0;
    if (order.discountAmount === undefined) order.discountAmount = 0;
    if (order.discountReason === undefined) order.discountReason = '';
    // Backfill group-link field
    if (order.groupId === undefined) order.groupId = null;
    // Backfill pickupMode
    if (order.pickupMode === undefined) order.pickupMode = null;
    // Backfill isReady
    if (order.isReady === undefined) order.isReady = false;
    // Backfill customer contact fields (added later)
    if (order.customerName  === undefined) order.customerName  = '';
    if (order.customerPhone === undefined) order.customerPhone = '';
    // For time-only orders, recalculate pickupTs using TODAY's date
    // This ensures the pin logic works correctly each day
    if (order.pickupMode === 'time' && order.pickupTs) {
        const stored  = new Date(order.pickupTs);
        const todayStr = dayKey();
        order.pickupTs = new Date(`${todayStr}T${stored.toTimeString().substring(0,5)}`).getTime();
    }
    return order;
}

// ---------- Home: menu inputs ----------
// v2: each item is a single tappable button — name, price, current qty
// badge, and the stock-left hint. Tapping it opens the shared Qty Editor
// modal below to set the quantity, instead of typing straight into a
// numeric field. A hidden <input id="qty-${item.id}"> still holds the real
// value for every existing consumer — getQuantitiesFromHome, checkStockInput,
// the Ratio allocator's "Fill New Order" button, and the paste-message
// auto-fill — so none of them need to know the UI changed underneath them.
function renderHomeMenuInputs() {
    const container = document.getElementById('menuInputs');
    if (!container) return;
    container.innerHTML = getMenuItems().map(item => {
        const unitSuffix = (item.category === 'custom-unit' && item.unitLabel)
            ? ` <span style="font-weight:400;color:#888;">(${escapeHtml(item.unitLabel)})</span>` : '';
        return `<div class="menu-item-cell">
            <button type="button" class="menu-item-btn" id="menu-item-btn-${item.id}" style="${menuItemButtonInlineStyle(item)}" onclick="openQtyEditor('${item.id}')">
                <span class="menu-item-name">${escapeHtml(item.name)}${unitSuffix}</span>
                <span class="menu-item-price">${formatRM(item.price)}</span>
                <span class="menu-item-qty-badge" id="menu-item-qty-${item.id}">0</span>
                <span id="stock-indicator-${item.id}" class="stock-indicator"></span>
            </button>
            <input type="number" id="qty-${item.id}" style="display:none" tabindex="-1" aria-hidden="true">
        </div>`;
    }).join('');
    if (typeof updateStockIndicators === 'function') updateStockIndicators();
}

// ── Qty Editor modal (tap a menu item button → set its quantity) ──────────
let _qtyEditorItemId = null;

function openQtyEditor(itemId) {
    const item = getMenuItems().find(i => i.id === itemId);
    if (!item) return;
    _qtyEditorItemId = itemId;

    const unitSuffix = (item.category === 'custom-unit' && item.unitLabel) ? ` (${item.unitLabel})` : '';
    document.getElementById('qtyEditorTitle').textContent = item.name + unitSuffix;
    document.getElementById('qtyEditorPrice').textContent = formatRM(item.price);

    const hiddenInput = document.getElementById(`qty-${itemId}`);
    const currentQty  = hiddenInput ? (parseInt(hiddenInput.value) || 0) : 0;
    const input = document.getElementById('qtyEditorInput');
    input.value = currentQty || '';

    // "Next" is disabled once we're on the last item — nothing further to advance to.
    const items = getMenuItems();
    const idx = items.findIndex(i => i.id === itemId);
    const nextBtn = document.getElementById('qtyEditorNextBtn');
    if (nextBtn) nextBtn.disabled = (idx === -1 || idx >= items.length - 1);

    showModalById('qtyEditorModal');
    updateQtyEditorStockHint();
}

function adjustQtyEditorInput(delta) {
    const input = document.getElementById('qtyEditorInput');
    const val = Math.max(0, (parseInt(input.value) || 0) + delta);
    input.value = val;
    updateQtyEditorStockHint();
}

function clearQtyEditorInput() {
    const input = document.getElementById('qtyEditorInput');
    input.value = '';
    updateQtyEditorStockHint();
    input.focus();
}

// Same hint text/logic checkStockInput already used, just reading from the
// modal's input instead of the (now hidden) per-item field. This is
// display-only — staff can still enter more than what's "available", same
// as the old +/- form could.
function updateQtyEditorStockHint() {
    if (!_qtyEditorItemId) return;
    const hint = document.getElementById('qtyEditorStockHint');
    if (!hint) return;
    const qty   = parseInt(document.getElementById('qtyEditorInput').value) || 0;
    const avail = (typeof _availableFor === 'function') ? _availableFor(_qtyEditorItemId) : null;
    if (avail === null) { hint.textContent = ''; hint.className = 'stock-indicator'; return; }
    if (avail === 0) { hint.textContent = 'Out of stock'; hint.className = 'stock-indicator stock-out'; return; }
    if (qty > avail) { hint.textContent = `Insufficient — only ${avail} left`; hint.className = 'stock-indicator stock-out'; return; }
    const remaining = avail - qty;
    hint.textContent = qty > 0 ? `${avail} left → ${remaining} after this order` : `${avail} left`;
    hint.className   = remaining <= 10 ? 'stock-indicator stock-low' : 'stock-indicator stock-ok';
}

function cancelQtyEditor() {
    hideModalById('qtyEditorModal');
    _qtyEditorItemId = null;
}

// Saves whatever's currently in the input to the item being edited, without
// closing the popup — shared by Done (which then closes) and Next (which
// then advances to the following item instead).
function _commitQtyEditor() {
    if (!_qtyEditorItemId) return;
    const itemId = _qtyEditorItemId;
    const qty = Math.max(0, parseInt(document.getElementById('qtyEditorInput').value) || 0);

    const hiddenInput = document.getElementById(`qty-${itemId}`);
    if (hiddenInput) hiddenInput.value = qty || '';
    if (typeof checkStockInput === 'function') checkStockInput(itemId, qty);
    refreshMenuItemButton(itemId);

    // If the review modal is already open, keep it in sync — same as the old +/- buttons did
    const modal = document.getElementById('orderSummaryModal');
    if (modal && modal.style.display === 'flex') reviewOrder();
}

function confirmQtyEditor() {
    if (!_qtyEditorItemId) return;
    _commitQtyEditor();
    hideModalById('qtyEditorModal');
    _qtyEditorItemId = null;
}

// Saves the current item's quantity (same as Done), then opens the next
// item's editor in place so quantities can be filled in one continuous pass.
// Closes instead, on the last item.
function nextQtyEditor() {
    if (!_qtyEditorItemId) return;
    const items = getMenuItems();
    const idx = items.findIndex(i => i.id === _qtyEditorItemId);
    _commitQtyEditor();
    if (idx === -1 || idx >= items.length - 1) {
        hideModalById('qtyEditorModal');
        _qtyEditorItemId = null;
        return;
    }
    openQtyEditor(items[idx + 1].id);
}

// Updates one item button's visible quantity badge + highlighted border to
// match its hidden <input id="qty-*"> value. Called after the Qty Editor
// confirms a change, and also after anything that sets the hidden input
// directly — paste-message auto-fill and the Ratio allocator's fill button —
// so the button always reflects what's actually in the order.
function refreshMenuItemButton(itemId) {
    const hiddenInput = document.getElementById(`qty-${itemId}`);
    const qty   = hiddenInput ? (parseInt(hiddenInput.value) || 0) : 0;
    const btn   = document.getElementById(`menu-item-btn-${itemId}`);
    const badge = document.getElementById(`menu-item-qty-${itemId}`);
    if (badge) { badge.textContent = qty; badge.classList.toggle('show', qty > 0); }
    if (btn)   btn.classList.toggle('has-qty', qty > 0);
}

function getQuantitiesFromHome() {
    const q = {};
    getMenuItems().forEach(item => {
        const el = document.getElementById(`qty-${item.id}`);
        q[item.id] = el ? (parseInt(el.value)||0) : 0;
    });
    return q;
}

function calculateTotals(quantities) {
    const items = {};
    let totalCost=0, skewerQty=0, skewerWithKuah=0, scoops=0;
    const customUnits = {}; // { 'slice': 12, 'pcs': 5, ... } — for non-skewer custom-unit items
    getMenuItems().forEach(item => {
        const qty  = quantities[item.id] || 0;
        const cost = qty * item.price;
        items[item.id] = { name:item.name, category:item.category, price:item.price, qty, cost, unitLabel:item.unitLabel };
        totalCost += cost;
        if      (item.category === 'skewer')     { skewerQty += qty; skewerWithKuah += qty; }
        else if (item.category === 'no-kuah')    { skewerQty += qty; }
        else if (item.category === 'side')       { scoops += qty * 2; }
        else if (item.category === 'side-1kuah') { scoops += qty * 1; }
        else if (item.category === 'side-none')  { /* no kuah kacang needed */ }
        else if (item.category === 'kuah-only')  { scoops += qty * 1; }
        else if (item.category === 'custom-unit' && qty > 0) {
            const label = item.unitLabel || 'pcs';
            customUnits[label] = (customUnits[label] || 0) + qty;
        }
    });
    const _kuahRatio = parseInt(localStorage.getItem('shmKuahRatio')) || 10;
    if (skewerWithKuah > 0) scoops += Math.ceil(skewerWithKuah / _kuahRatio);
    return { items, totalCost, skewerQty, scoops, customUnits };
}

// ── Order Summary modal (New Order review) ─────────────────────────────────
// Pops up a summary — items, totals, contact, pick-up — just like the
// customer-facing order.html review step, so nothing needs scrolling to check
// before saving.
function reviewOrder() {
    const quantities = getQuantitiesFromHome();
    const hasAny = Object.values(quantities).some(q => q > 0);
    if (!hasAny) { alert('Please enter at least one item.'); return; }

    const totals = calculateTotals(quantities);
    renderOrderSummaryModal(totals);
    showModalById('orderSummaryModal');
}

function renderOrderSummaryModal(totals) {
    const box = document.getElementById('orderSummaryContent');
    if (!box) return;

    const customerName  = ((document.getElementById('customerNameInput')  || {}).value || '').trim();
    const customerPhone = ((document.getElementById('customerPhoneInput') || {}).value || '').trim();
    const pickupDate    = (document.getElementById('pickupDate') || {}).value || '';
    const pickupTime    = (document.getElementById('pickupTime') || {}).value || '';
    const description   = ((document.getElementById('orderDescription') || {}).value || '').trim();

    const labelStyle = 'font-size:11px;font-weight:700;color:#999;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;';

    let contactHtml = '';
    if (customerName || customerPhone) {
        contactHtml = `<div style="margin-bottom:12px;">
            <div style="${labelStyle}">Contact</div>
            ${customerName  ? `<div style="font-size:14px;">👤 ${escapeHtml(customerName)}</div>` : ''}
            ${customerPhone ? `<div style="font-size:14px;">📞 ${escapeHtml(customerPhone)}</div>` : ''}
        </div>`;
    }

    let pickupHtml = '';
    if (pickupDate || pickupTime) {
        const label = [pickupDate, pickupTime].filter(Boolean).join('  ');
        pickupHtml = `<div style="margin-bottom:12px;">
            <div style="${labelStyle}">Pick-up</div>
            <div style="font-size:13px;background:#e8f4fd;color:#1a6abf;border-radius:8px;padding:8px 10px;">📅 ${escapeHtml(label)}</div>
        </div>`;
    }

    let itemsHtml = '';
    Object.values(totals.items).forEach(it => {
        if (!it.qty) return;
        itemsHtml += `<div style="display:flex;justify-content:space-between;font-size:14px;padding:6px 0;border-bottom:1px solid #f0f0f0;">
            <span><b>×${it.qty}</b> ${escapeHtml(it.name)}</span><span>${formatRM(it.cost)}</span>
        </div>`;
    });

    let noteHtml = '';
    if (description) {
        noteHtml = `<div style="margin-top:12px;">
            <div style="${labelStyle}">Note</div>
            <div style="font-size:13px;color:#555;background:#f8f9fa;border-radius:8px;padding:8px 10px;white-space:pre-wrap;">${escapeHtml(description)}</div>
        </div>`;
    }

    // Skip the skewer-system lines entirely for shops whose menu doesn't use it (e.g. a bakery).
    const showSkewerLines = typeof menuUsesSkewerSystem === 'function' ? menuUsesSkewerSystem() : true;
    const skewerLinesHtml = showSkewerLines ? `
        <div style="display:flex;justify-content:space-between;font-size:13px;color:#555;padding-top:10px;">
            <span>Jumlah Cucuk</span><span>${totals.skewerQty}</span>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:13px;color:#555;">
            <span>Jumlah Kuah Kacang</span><span>${totals.scoops}</span>
        </div>` : '';

    const customUnitLinesHtml = Object.entries(totals.customUnits || {}).map(([label, qty]) => `
        <div style="display:flex;justify-content:space-between;font-size:13px;color:#555;padding-top:${showSkewerLines ? '0' : '10px'};">
            <span>${escapeHtml(label.charAt(0).toUpperCase() + label.slice(1))}</span><span>${qty}</span>
        </div>`).join('');

    box.innerHTML = `
        ${contactHtml}
        ${pickupHtml}
        <div>
            <div style="${labelStyle}">Items</div>
            ${itemsHtml || '<div style="font-size:13px;color:#999;">No items</div>'}
        </div>
        ${skewerLinesHtml}
        ${customUnitLinesHtml}
        ${noteHtml}
        <div style="display:flex;justify-content:space-between;font-size:17px;font-weight:700;padding-top:10px;margin-top:8px;border-top:2px solid #eee;">
            <span>Total</span><span>${formatRM(totals.totalCost)}</span>
        </div>
    `;
}

function closeOrderSummaryModal() {
    hideModalById('orderSummaryModal');
}

function clearForm() {
    getMenuItems().forEach(item => {
        const el = document.getElementById(`qty-${item.id}`);
        // Empty string, not 0 — leaves only the "0" placeholder hint showing,
        // so tapping straight into the field doesn't land a cursor in front
        // of a real "0" character (which turned "10" into "100").
        if (el) el.value = '';
        if (typeof checkStockInput === 'function') checkStockInput(item.id, '');
        if (typeof refreshMenuItemButton === 'function') refreshMenuItemButton(item.id);
    });
    document.getElementById('orderDescription').value = '';
    const custName  = document.getElementById('customerNameInput');
    const custPhone = document.getElementById('customerPhoneInput');
    if (custName)  custName.value  = '';
    if (custPhone) custPhone.value = '';
    const pDate = document.getElementById('pickupDate');
    const pTime = document.getElementById('pickupTime');
    if (pDate) pDate.value = '';
    if (pTime) pTime.value = '';
    syncAdminPickupTimeDisplay();
    closeOrderSummaryModal();
}

// Keeps the visible "2:30 PM"-style admin field in sync with the real,
// 24-hour #pickupTime value that saveOrder()/updatePreview() read.
// Keeps the visible "2:30 PM"-style admin field (and its clear-button
// visibility) in sync with the real, 24-hour #pickupTime value that
// saveOrder()/updatePreview() read.
function syncAdminPickupTimeDisplay() {
    const display = document.getElementById('pickupTimeDisplay');
    if (!display) return;
    const val = formatTime12hr(document.getElementById('pickupTime').value);
    display.value = val;
    const wrap = display.closest('.time-input-wrap');
    if (wrap) wrap.classList.toggle('has-value', !!val);
}

// Tapping the time field — suggests the current time as the opening
// position when empty, so admin doesn't have to scroll all the way up from
// the top of the wheel for the (very common) case of "pick-up is basically
// now" — but only as a suggestion passed to the picker, not written into
// pickupTime itself, so tapping in to look and then hitting Cancel doesn't
// silently set a real pickup time on an order that was never meant to have one.
function onAdminPickupTimeTriggerClick() {
    const timeEl = document.getElementById('pickupTime');
    let initialValue;
    if (!timeEl.value) {
        const now = new Date();
        initialValue = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
    }
    openScrollTimePicker(timeEl, { onConfirm: syncAdminPickupTimeDisplay, initialValue });
}

// Clears the pick-up time without opening the picker.
function clearAdminPickupTime(e) {
    e.stopPropagation();
    document.getElementById('pickupTime').value = '';
    syncAdminPickupTimeDisplay();
}

// Total qty still pending per item, across every order that hasn't been
// prepared or paid yet and is due today (excludes future-dated preorders —
// same population/exclusion rule as the Prepare tab and updateSateSummaryBar,
// and mirrored server-side in place_customer_order/edit_my_order — see
// box_stock_v2_unified.sql). Used by saveOrder()'s live availability check.
function computePendingDemandByItem(allOrders) {
    const today   = dayKey();
    const pending = {};
    allOrders.forEach(o => {
        if (o.prepared || o.paid) return;
        if (o.pickupTs && o.pickupMode !== 'time') {
            const pDay = dayKey(o.pickupTs);
            if (pDay > today) return; // future preorder — doesn't count today
        }
        Object.entries(o.items || {}).forEach(([id, item]) => {
            if (item.qty > 0) pending[id] = (pending[id] || 0) + item.qty;
        });
    });
    return pending;
}

async function saveOrder() {
    const btn = document.getElementById('modalSaveOrderBtn');
    if (btn && btn.disabled) return; // already processing — ignore repeat taps (e.g. laggy touchscreen double-taps)

    const quantities = getQuantitiesFromHome();
    const hasAny = Object.values(quantities).some(q => q > 0);
    if (!hasAny) { alert('Please enter at least one item.'); return; }

    const totals      = calculateTotals(quantities);
    const description = document.getElementById('orderDescription').value.trim() || '';
    const customerName  = (document.getElementById('customerNameInput')  || {}).value?.trim()  || '';
    const customerPhone = ((document.getElementById('customerPhoneInput') || {}).value || '').replace(/\D/g, '');

    // Pick-up date/time (optional)
    const pickupDateEl = document.getElementById('pickupDate');
    const pickupTimeEl = document.getElementById('pickupTime');
    const pickupDate   = pickupDateEl ? pickupDateEl.value : '';
    const pickupTime   = pickupTimeEl ? pickupTimeEl.value : '';
    let   pickupTs     = null;
    let   pickupMode   = null; // 'datetime' | 'date' | 'time'
    const todayStr     = dayKey();
    if (pickupDate && pickupTime) {
        pickupTs   = new Date(`${pickupDate}T${pickupTime}`).getTime();
        pickupMode = 'datetime';
    } else if (pickupDate) {
        pickupTs   = new Date(`${pickupDate}T00:00`).getTime();
        pickupMode = 'date';
    } else if (pickupTime) {
        // Time only — use today's date
        pickupTs   = new Date(`${todayStr}T${pickupTime}`).getTime();
        pickupMode = 'time';
    }

    const order = {
        items: totals.items,
        totalCost: totals.totalCost,
        skewerQty: totals.skewerQty,
        scoops: totals.scoops,
        prepared: false,
        paid: false,
        pickedUp: false,
        description,
        customerName,
        customerPhone,
        pickupTs:   pickupTs   || null,
        pickupMode: pickupMode || null,
        paymentMethod: null,
        paymentOnline: 0,
        paymentCash: 0,
        createdAt: Date.now()
    };

    // Lock the button now, before touching stock or creating the order — this
    // is the actual fix for duplicate orders from repeated taps. It also gives
    // an immediate, unmistakable visual signal the tap registered, even if the
    // device is briefly lagging.
    const origText = btn ? btn.textContent : '';
    if (btn) {
        btn.disabled = true;
        btn.textContent = '⏳ Saving...';
    }
    const unlockBtn = () => { if (btn) { btn.disabled = false; btn.textContent = origText; } };

    // ── Availability check (unified model v2 — see box.js header comment) ──
    // Nothing gets deducted here anymore — Stock only changes when cooking
    // happens (see box.js: cookIntoBox), Box only changes at the Ready
    // button / a pre-payment cancel (see markPrepared/deleteOrderConfirm).
    // Placing an order is purely a live check:
    //     available = (Stock + Box) − everything already pending in Prepare
    // "Pending" = every not-yet-prepared, not-yet-paid order due today —
    // see computePendingDemandByItem() below, same population used for the
    // summary bar and the customer-facing busy badge.
    const allOrdersForCheck = (await getAllOrders()).map(normalizeOrder);
    const pendingDemand     = computePendingDemandByItem(allOrdersForCheck);
    for (const [id, item] of Object.entries(totals.items)) {
        if (item.qty <= 0) continue;
        const stockQty = (typeof getStockFor === 'function') ? getStockFor(id) : null;
        if (stockQty === null || stockQty === undefined) continue; // unlimited — skip
        const boxQty = (typeof getBoxQty === 'function') ? getBoxQty(id) : 0;
        const avail  = stockQty + boxQty - (pendingDemand[id] || 0);
        if (item.qty > avail) {
            alert(`❌ Insufficient stock: ${item.name}\nAvailable: ${Math.max(0, avail)}`);
            unlockBtn();
            return;
        }
    }

    try {
        await addOrder(order);
        clearForm();
        const today = dayKey();
        // Only date or datetime with a FUTURE date go to preorder
        // Time-only always goes to prepare (today)
        const isPreorder = pickupTs && pickupMode !== 'time' &&
            dayKey(pickupTs) > today;
        if (isPreorder) {
            switchTab('preorder');
        } else {
            switchTab('orders');
            switchOrderSubTab('prepare');
            window.scrollTo({ top: 0, behavior: 'smooth' });
        }
    } catch (e) {
        alert('❌ Failed to save order: ' + e.message);
    } finally {
        unlockBtn();
    }
}


// ─── Preorder tab ─────────────────────────────────────────────────────────────
async function loadPreorders() {
    if (_editingIds.size > 0) return;
    try {
        const orders  = (await getAllOrders()).map(normalizeOrder);
        const today   = dayKey();
        const sortDir = document.getElementById('sortPreorders') ?
            document.getElementById('sortPreorders').value : 'asc';

        const preorders = orders.filter(o => {
            if (o.prepared || o.paid || o.pickedUp) return false;
            if (!o.pickupTs || o.pickupMode === 'time') return false;
            const pDay = dayKey(o.pickupTs);
            return pDay > today; // strictly future (covers 'date' and 'datetime' modes)
        });

        preorders.sort((a, b) => sortDir === 'asc'
            ? (a.pickupTs || 0) - (b.pickupTs || 0)
            : (b.pickupTs || 0) - (a.pickupTs || 0));

        const container = document.getElementById('preorderList');
        if (!container) return;
        container.innerHTML = '';

        if (preorders.length === 0) {
            container.innerHTML = '<p style="text-align:center;color:#999;">No preorders yet.</p>';
            _syncExpandAllBtn(container, 'togglePreorderExpandBtn');
            return;
        }

        preorders.forEach(order => {
            const card = document.createElement('div');
            card.className = 'order-card';
            card.id = `order-${order.id}`;
            card.dataset.stage = 'preorder';
            renderOrderCard(card, normalizeOrder(order), 'preorder');
            container.appendChild(card);
        });
        _syncExpandAllBtn(container, 'togglePreorderExpandBtn');
    } catch(e) {
        console.error('loadPreorders error:', e);
    }
}

// ---------- Urgent order sound alert ----------
// Plays a beep the moment an order crosses the same 15-minute threshold that
// pins its card to the top of Prepare, so staff get an audible heads-up even
// if they're not looking at the screen. Each order only alerts once; the
// memory of "already alerted" ids is cleared out at day-close.
const URGENT_WARN_MS = 15 * 60 * 1000; // keep in sync with all usages below
let _notifiedUrgentIds = new Set();

// Whether an order should be pinned/flagged urgent in the Prepare stage.
// - Orders with a requested pick-up time (or a today-dated pickup): urgent
//   once "now" is within (or past) the 15-minute window before that time.
// - Orders with NO requested date/time at all are never pinned/urgent —
//   there's no pick-up badge on these cards at all, so there's nothing to
//   flag as urgent either. They just sort normally by when they were placed.
function isOrderPinned(o, now) {
    if (o.pickupTs) return (now - o.pickupTs) >= -URGENT_WARN_MS;
    return false;
}

// Browsers only allow audio after a genuine user gesture, and can auto-suspend
// an AudioContext that's sat idle. Creating a brand-new context inside a
// background setInterval (no gesture) means it stays silently suspended
// forever. Instead we create ONE shared context, unlock it on the very first
// tap/click/keypress anywhere in the app (so it doesn't matter which tab the
// user happens to be on), and defensively resume it every time we're about
// to beep so an idle timeout can't mute it later.
let _urgentAudioCtx = null;

function _unlockUrgentAudioCtx() {
    if (!_urgentAudioCtx) {
        try { _urgentAudioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
        catch(e) { console.warn('AudioContext init failed:', e); return; }
    }
    if (_urgentAudioCtx.state === 'suspended') _urgentAudioCtx.resume();
}
['click', 'touchstart', 'keydown'].forEach(evt =>
    document.addEventListener(evt, _unlockUrgentAudioCtx, { passive: true })
);
document.addEventListener('visibilitychange', () => {
    if (!document.hidden) _unlockUrgentAudioCtx();
});

function playUrgentAlertSound() {
    try {
        if (!_urgentAudioCtx) _unlockUrgentAudioCtx(); // fallback if no gesture has fired yet
        const ctx = _urgentAudioCtx;
        if (!ctx) return;

        // Schedule relative to ctx.currentTime measured AFTER resume actually
        // completes — not before. resume() is async; scheduling immediately
        // after calling it (without waiting) anchors the beep times to a
        // still-suspended clock, so playback can start audibly late once the
        // context actually wakes up. This was the main cause of the sound
        // lagging a few seconds behind the card visually pinning.
        const schedule = () => {
            const now = ctx.currentTime;

            const beepLen   = 0.45; // each beep's duration, seconds
            const beepGap   = 0.6;  // gap between beeps within a set
            const setGap    = 1.1;  // gap between the 3-beep sets
            const beepsPerSet = 3;
            const sets         = 3;

            for (let s = 0; s < sets; s++) {
                for (let b = 0; b < beepsPerSet; b++) {
                    const offset = s * (beepsPerSet * beepGap + setGap) + b * beepGap;
                    const osc  = ctx.createOscillator();
                    const gain = ctx.createGain();
                    osc.type = 'sine';
                    osc.frequency.setValueAtTime(880, now + offset);
                    gain.gain.setValueAtTime(0.0001, now + offset);
                    gain.gain.exponentialRampToValueAtTime(0.35, now + offset + 0.01);
                    gain.gain.setValueAtTime(0.35, now + offset + beepLen - 0.08);
                    gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + beepLen);
                    osc.connect(gain).connect(ctx.destination);
                    osc.start(now + offset);
                    osc.stop(now + offset + beepLen + 0.02);
                }
            }
        };

        if (ctx.state === 'suspended') {
            ctx.resume().then(schedule).catch(e => console.warn('AudioContext resume failed:', e));
        } else {
            schedule();
        }
    } catch(e) { console.warn('Urgent alert sound failed:', e); }
}

// Look for orders that just crossed the 15-min-to-pickup line and haven't
// been alerted on yet. Accepts an already-fetched/normalized orders array
// when the caller has one handy (e.g. loadOrders() — see below) so this can
// run on EVERY re-render, not just the 60s fallback timer. That matters:
// the visual pin (isOrderPinned, recalculated fresh on every render) can
// flip the moment ANY re-render happens — a realtime update, a tab switch,
// anything — while the sound used to only get checked once every 60s on its
// own separate timer. Coupling the two to the same renders keeps them in
// lockstep instead of drifting apart by however long was left on that timer.
async function checkUrgentOrders(preloadedOrders) {
    try {
        const now    = Date.now();
        const today  = dayKey();
        const orders = preloadedOrders || (await getAllOrders()).map(normalizeOrder);
        let newlyUrgent = false;

        orders.forEach(o => {
            if (o.prepared || o.paid) return;
            if (o.pickupTs) {
                const pDay = dayKey(o.pickupTs);
                if (pDay > today) return; // still a future preorder, not urgent yet
            }
            const isUrgent = isOrderPinned(o, now);
            if (isUrgent && !_notifiedUrgentIds.has(o.id)) {
                _notifiedUrgentIds.add(o.id);
                newlyUrgent = true;
            }
        });

        if (newlyUrgent) playUrgentAlertSound();
    } catch(e) { console.error('checkUrgentOrders error:', e); }
}

// Check every minute if any preorder should move to Prepare
// Periodic fallback: moves due preorders into Prepare, and checks for newly-
// urgent orders regardless of which sub-tab is currently open (checkUrgentOrders
// inside loadOrders() only fires when loadOrders() actually runs, which the
// currentOrderSubTab guard below skips unless you're on Prepare — this call
// is what still catches it if you're sitting on Prepared/Paid/Done instead).
// Was every 60s — shortened to 10s so the worst-case gap between the card
// visually pinning and the sound playing is a lot smaller (the two fixes in
// checkUrgentOrders/playUrgentAlertSound close most of the gap directly;
// this tightens the remaining "nothing else happened to trigger a render"
// case for whenever this timer alone is what catches it).
function startPreorderTimer() {
    setInterval(async () => {
        const today   = dayKey();
        const orders  = (await getAllOrders()).map(normalizeOrder);
        const toMove  = orders.filter(o => {
            if (o.prepared || o.paid || o.pickedUp || !o.pickupTs) return false;
            const pDay = dayKey(o.pickupTs);
            return pDay <= today;
        });
        if (toMove.length > 0) {
            // No DB change needed — loadOrders re-filters by date automatically
            loadOrders();
            loadPreorders();
        }
        // Sound alert for any order that just became urgent (15min pin logic)
        // — reuses the orders array already fetched above.
        checkUrgentOrders(orders);
        // Also refresh prepare sort every tick (for 15min pin logic)
        if (currentOrderSubTab === 'prepare') loadOrders();
    }, 10 * 1000);
}

// ---------- Auto day-close ----------
// Runs on app start:
// 1. Paid but not picked up from previous days → silently moved to Done
// 2. Unpaid orders from previous days → prompt user to Keep or Cancel each one
async function autoClosePreviousDay() {
    const today  = dayKey();
    const orders = (await getAllOrders()).map(normalizeOrder);
    _notifiedUrgentIds.clear();
    // Box should be empty at the start of a new day (see box.js) — but this
    // function runs on EVERY app open/refresh, so guard with a "last reset
    // day" marker to avoid wiping real, still-warm box stock mid-day.
    const lastBoxResetDay = localStorage.getItem('shmBoxResetDay');
    if (lastBoxResetDay !== today) {
        if (typeof resetBoxStock === 'function') await resetBoxStock().catch(console.warn);
        localStorage.setItem('shmBoxResetDay', today);
    }

    const stale  = orders.filter(o => {
        const orderDay = dayKey(o.createdAt);
        return orderDay !== today && !o.pickedUp;
    });

    if (stale.length === 0) return;

    // 1. Paid but not picked up → silently push to Done
    const paidNotCollected = stale.filter(o => o.paid);
    for (const order of paidNotCollected) {
        order.pickedUp = true;
        await updateOrder(order);
    }

    // 2. Unpaid → ask user one by one
    // Exclude preorders whose pickup date is today — they legitimately just moved to Prepare
    const unpaid = stale.filter(o => {
        if (o.paid) return false;
        // If order has a pickup date for today, it's a scheduled preorder arriving — keep it silently
        if (o.pickupTs && (o.pickupMode === 'datetime' || o.pickupMode === 'date')) {
            const pickupDay = dayKey(o.pickupTs);
            if (pickupDay === today) return false; // exclude from prompt
        }
        return true;
    });
    if (unpaid.length === 0) return;

    // Show review modal
    _showDayCloseModal(unpaid);
}

// ── Day-close review modal ─────────────────────────────────────────────────
function _showDayCloseModal(unpaidOrders) {
    // Remove existing modal if any
    const existing = document.getElementById('dayCloseModal');
    if (existing) existing.remove();

    let currentIndex = 0;

    const modal = document.createElement('div');
    modal.id = 'dayCloseModal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.65);z-index:99999;display:flex;align-items:center;justify-content:center;';

    function renderModal() {
        const order = unpaidOrders[currentIndex];
        const total = currentIndex + 1;
        const day   = formatDay(order.createdAt);
        const time  = formatDate(order.createdAt);

        const itemRows = Object.values(order.items || {})
            .filter(r => r.qty > 0)
            .map(r => `<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid #f0f0f0;">
                <span>${escapeHtml(r.name)} × ${r.qty}</span>
                <span>${formatRM(r.cost)}</span>
            </div>`)
            .join('');

        const stage = !order.prepared ? 'Prepare' : 'Prepared';

        modal.innerHTML = `
            <div style="background:white;border-radius:18px;padding:24px;width:92%;max-width:400px;box-shadow:0 8px 32px rgba(0,0,0,0.3);color:#333;">
                <div style="background:#fff3cd;border-radius:10px;padding:10px 14px;margin-bottom:16px;font-size:13px;color:#856404;">
                    ⚠️ Leftover unpaid order from <strong>${day}</strong>
                </div>
                <div style="font-size:12px;color:#999;margin-bottom:4px;">${time} &nbsp;·&nbsp; Stage: ${stage} &nbsp;·&nbsp; #${order.id}</div>
                <div style="margin:10px 0;">${itemRows}</div>
                <div style="display:flex;justify-content:space-between;font-weight:bold;padding:8px 0;border-top:2px solid #eee;margin-bottom:6px;">
                    <span>Total</span><span>${formatRM((order.totalCost||0))}</span>
                </div>
                ${order.description ? `<div style="font-size:13px;color:#666;margin-bottom:12px;">📝 ${escapeHtml(order.description)}</div>` : ''}
                <div style="font-size:13px;color:#555;margin-bottom:14px;text-align:center;">
                    Order <strong>${currentIndex+1}</strong> of <strong>${unpaidOrders.length}</strong> — what would you like to do?
                </div>
                <div style="display:flex;gap:10px;">
                    <button id="dcKeepBtn" style="flex:1;background:#28a745;color:white;border:none;border-radius:12px;padding:14px;font-size:14px;font-weight:bold;cursor:pointer;">
                        ✅ Keep
                    </button>
                    <button id="dcCancelBtn" style="flex:1;background:#dc3545;color:white;border:none;border-radius:12px;padding:14px;font-size:14px;font-weight:bold;cursor:pointer;">
                        🗑️ Cancel
                    </button>
                </div>
            </div>`;

        // Keep — leave order as-is, just move to next
        document.getElementById('dcKeepBtn').onclick = async () => {
            currentIndex++;
            if (currentIndex < unpaidOrders.length) {
                renderModal();
            } else {
                modal.remove();
                loadOrders();
            }
        };

        // Cancel — delete the order, move to next
        document.getElementById('dcCancelBtn').onclick = async () => {
            await deleteOrder(order.id);
            unpaidOrders.splice(currentIndex, 1);
            if (unpaidOrders.length === 0 || currentIndex >= unpaidOrders.length) {
                if (unpaidOrders.length === 0) {
                    modal.remove();
                    loadOrders();
                } else {
                    currentIndex = 0;
                    renderModal();
                }
            } else {
                renderModal();
            }
        };
    }

    document.body.appendChild(modal);
    renderModal();
}


// ---------- Card expand/collapse ----------
const _expandedCards = new Set();

function toggleCardExpand(id) {
    if (_expandedCards.has(id)) {
        _expandedCards.delete(id);
    } else {
        _expandedCards.add(id);
    }
    const card = document.getElementById(`order-${id}`);
    if (!card) return;
    // Stage is stored as data-stage attribute on the card
    const stage = card.dataset.stage || 'prepare';
    getAllOrders().then(orders => {
        const order = orders.find(o => o.id === id);
        if (order) renderOrderCard(card, normalizeOrder(order), stage);
    });
}

// Maximize All / Minimize All — toggles every card currently visible in a list
function _cardIdsIn(listEl) {
    if (!listEl) return [];
    return Array.from(listEl.querySelectorAll('.order-card'))
        .map(c => parseInt(c.id.replace('order-', '')))
        .filter(id => !isNaN(id));
}

function _syncExpandAllBtn(listEl, btnId) {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    const ids = _cardIdsIn(listEl);
    const allExpanded = ids.length > 0 && ids.every(id => _expandedCards.has(id));
    btn.textContent = allExpanded ? '🔼 Minimize All' : '🔽 Maximize All';
}

function toggleAllOrderCards() {
    const listEl = document.querySelector('#ordersPanel .order-sublist.active');
    const ids = _cardIdsIn(listEl);
    if (ids.length === 0) return;
    const allExpanded = ids.every(id => _expandedCards.has(id));
    ids.forEach(id => allExpanded ? _expandedCards.delete(id) : _expandedCards.add(id));
    loadOrders();
}

function toggleAllPreorderCards() {
    const listEl = document.getElementById('preorderList');
    const ids = _cardIdsIn(listEl);
    if (ids.length === 0) return;
    const allExpanded = ids.every(id => _expandedCards.has(id));
    ids.forEach(id => allExpanded ? _expandedCards.delete(id) : _expandedCards.add(id));
    loadPreorders();
}

// ---------- Edit state tracking ----------
// Tracks which order IDs are currently in edit mode so _rerender doesn't wipe them
const _editingIds = new Set();

// ---------- Sub-tabs ----------
let currentOrderSubTab = 'prepare';

function switchOrderSubTab(subtab) {
    currentOrderSubTab = subtab;
    document.querySelectorAll('.sub-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.order-sublist').forEach(l => l.classList.remove('active'));
    document.getElementById(`subTab-${subtab}`).classList.add('active');
    document.getElementById(`${subtab}List`).classList.add('active');

    const filterBar = document.getElementById('doneFilterBar');
    if (filterBar) filterBar.style.display = subtab === 'done' ? 'flex' : 'none';

    // Only show sate summary bar / Box bar on Prepare tab
    const summaryBar = document.getElementById('sateSummaryBar');
    if (summaryBar) summaryBar.style.display = subtab === 'prepare' ? 'flex' : 'none';
    const boxBar = document.getElementById('boxSummaryBar');
    if (boxBar) boxBar.style.display = subtab === 'prepare' ? 'flex' : 'none';

    if (subtab === 'done') _populateDoneDateFilter().then(() => loadOrders());
    else loadOrders();
}

// Whether the "Count Custom-unit Items" toggle is on (Settings → Busy Status
// Thresholds). Used to decide whether custom-unit badges show on prepare
// cards/summary bar — mirrors how skewer badges are already gated on whether
// the shop's menu uses the skewer system at all (menuUsesSkewerSystem()).
function busyCustomToggleEnabled() {
    return localStorage.getItem('shmBusyCustomEnabled') === '1';
}

// The Prepare orders used for the most recent summary-bar render, so a Box
// change (add/remove stock) can re-render the bar immediately without a full
// reload — see loadBoxStock() in box.js.
let _lastPrepareOrdersForSate = [];

// Tallies qty of skewer-category items (unchanged, for shops using that
// system) plus custom-unit items (e.g. "12 Slice") across all Prepare-stage
// orders, so whoever's prepping orders can see totals at a glance.
//
// "Still need to cook" is a LIVE calculation (unified model v2 — see box.js
// header comment): remaining = (items needed across Prepare orders) −
// (current Box qty). This self-corrects automatically — it stays in sync
// because an order's items leave this tally at the exact same moment
// markPrepared() removes them from the Box (see box.js: deductBoxForPacking).
// Tapping a chip jumps straight to that item's Box popup, since that's where
// the kitchen actually records progress (put a cooked batch in the box).
function updateSateSummaryBar(prepareOrders) {
    _lastPrepareOrdersForSate = prepareOrders;
    const bar = document.getElementById('sateSummaryBar');
    if (!bar) return;

    const usesSkewerSystem = typeof menuUsesSkewerSystem === 'function' ? menuUsesSkewerSystem() : true;
    const showCustom = busyCustomToggleEnabled();
    // Keyed by item ID (not name) so we can look up its live Box qty — Box
    // data is stored by ID (see box.js), same ID space as `stock`.
    const totals = {}; // { id: { name, qty } }
    let hasCustomUnitItems = false;
    prepareOrders.forEach(order => {
        Object.entries(order.items || {}).forEach(([id, item]) => {
            if (item.qty <= 0) return;
            if (usesSkewerSystem && (item.category === 'skewer' || item.category === 'no-kuah')) {
                if (!totals[id]) totals[id] = { name: item.name, qty: 0 };
                totals[id].qty += item.qty;
            } else if (showCustom && item.category === 'custom-unit') {
                if (!totals[id]) totals[id] = { name: item.name, qty: 0 };
                totals[id].qty += item.qty;
                hasCustomUnitItems = true;
            }
        });
    });

    // Nothing relevant to this shop's setup to show — hide the whole bar
    // (but only touch visibility while actually on the Prepare sub-tab —
    // switchOrderSubTab() already hides it for every other sub-tab)
    if (currentOrderSubTab === 'prepare') {
        bar.style.display = (!usesSkewerSystem && !hasCustomUnitItems) ? 'none' : 'flex';
    }

    const entries = Object.entries(totals); // [id, {name, qty}]
    if (entries.length === 0) {
        bar.innerHTML = '<span style="color:#999;font-size:13px;">No items to prepare</span>';
    } else {
        bar.innerHTML = entries.map(([id, t]) => {
            const boxQty     = typeof getBoxQty === 'function' ? getBoxQty(id) : 0;
            const inBox      = Math.min(boxQty, t.qty);
            const remaining  = t.qty - inBox;
            const done       = remaining <= 0;
            const openBox    = typeof openBoxModal === 'function' ? `openBoxModal('${id}')` : '';
            return `<span class="sate-summary-chip ${done ? 'sate-chip-done' : ''}" onclick="${openBox}" role="button" tabindex="0">` +
                `<span class="sate-chip-main">${done ? '✅' : `<strong>${remaining}</strong> left`} ${escapeHtml(t.name)}</span>` +
                `<span class="sate-chip-sub">${inBox}/${t.qty} in box</span>` +
                `</span>`;
        }).join('');
    }
}

async function loadOrders() {
    // Don't re-render while any card is in edit mode — sync will catch up after save/cancel
    if (_editingIds.size > 0) return;
    try {
        const orders  = (await getAllOrders()).map(normalizeOrder);
        _allOrdersCache = orders; // used by getGroupMembers() for linked-order lookups
        // Same render, same moment the visual pin can change — see the
        // comment on checkUrgentOrders for why this needs to happen here
        // rather than only on its own separate timer.
        checkUrgentOrders(orders);
        const sortDir = document.getElementById('sortOrders').value;
        orders.sort((a,b) => sortDir==='asc' ? a.createdAt-b.createdAt : b.createdAt-a.createdAt);

        // Stage buckets
        const today    = dayKey();
        const now      = Date.now();

        // preorder = future pickupTs (not today)
        // prepare  = not prepared, not paid, and either no pickupTs or pickupTs is today/past
        const prepare  = orders.filter(o => {
            if (o.prepared || o.paid) return false;
            if (!o.pickupTs) return true;
            const pDay = dayKey(o.pickupTs);
            return pDay <= today;
        });
        const prepared = orders.filter(o =>  o.prepared && !o.paid);
        const paid     = orders.filter(o =>  o.paid     && !o.pickedUp);
        let   done     = orders.filter(o =>  o.paid     &&  o.pickedUp);

        // Sort prepare: orders within 15min of pick-up (or, for regular
        // no-time orders, sitting 15+ min unprepared) float to top.
        prepare.sort((a, b) => {
            const aPinned = isOrderPinned(a, now);
            const bPinned = isOrderPinned(b, now);
            if (aPinned && !bPinned) return -1;
            if (!aPinned && bPinned) return  1;
            if (aPinned && bPinned) {
                // Earliest reference time first — a requested pick-up time if
                // there is one, otherwise how long it's been sitting since placed.
                return (a.pickupTs || a.createdAt || 0) - (b.pickupTs || b.createdAt || 0);
            }
            // Normal sort
            return sortDir === 'asc' ? a.createdAt - b.createdAt : b.createdAt - a.createdAt;
        });

        const dateFilter = document.getElementById('doneDateFilter');
        if (dateFilter && dateFilter.value && dateFilter.value !== 'all') {
            const target = dateFilter.value === 'today'
                ? dayKey()
                : dateFilter.value;
            done = done.filter(o => dayKey(o.createdAt) === target);
        }

        updateSateSummaryBar(prepare);
        renderOrderList('prepareList',  clusterGroupedOrders(prepare),  'prepare');
        renderOrderList('preparedList', clusterGroupedOrders(prepared), 'prepared');
        renderOrderList('paidList',     clusterGroupedOrders(paid),     'paid');
        renderOrderList('doneList',     done,     'done');
        _syncExpandAllBtn(document.querySelector('#ordersPanel .order-sublist.active'), 'toggleOrdersExpandBtn');
    } catch (e) {
        alert('❌ Failed to load orders: ' + e.message);
    }
}

// Re-orders a list so linked orders (same groupId) sit right next to each
// other, without otherwise disturbing the existing sort — each group's
// cluster appears at the position of whichever member the sort placed
// first, and the other member(s) are pulled up to sit right after it.
function clusterGroupedOrders(list) {
    const result = [];
    const seen = new Set();
    list.forEach(o => {
        if (seen.has(o.id)) return;
        result.push(o);
        seen.add(o.id);
        if (o.groupId) {
            list.forEach(other => {
                if (other.id !== o.id && other.groupId === o.groupId && !seen.has(other.id)) {
                    result.push(other);
                    seen.add(other.id);
                }
            });
        }
    });
    return result;
}

function renderOrderList(containerId, orderList, stage) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = '';
    if (orderList.length === 0) {
        container.innerHTML = '<p style="text-align:center;color:#999;">No orders here.</p>';
        return;
    }
    const groups = {};
    orderList.forEach(o => {
        const day = formatDay(o.createdAt);
        if (!groups[day]) groups[day] = [];
        groups[day].push(o);
    });
    for (const [day, dayOrders] of Object.entries(groups)) {
        const dayDiv = document.createElement('div');
        dayDiv.className = 'day-group';
        dayDiv.innerHTML = `<div class="day-header">${day}</div>`;
        dayOrders.forEach(order => {
            // If this card is in edit mode, skip re-rendering it
            if (_editingIds.has(order.id)) {
                const existing = document.getElementById(`order-${order.id}`);
                if (existing) { dayDiv.appendChild(existing); return; }
            }
            const card = document.createElement('div');
            card.className = 'order-card';
            card.id = `order-${order.id}`;
            card.dataset.stage = stage;
            renderOrderCard(card, order, stage);
            dayDiv.appendChild(card);
        });
        container.appendChild(dayDiv);
    }
}

// ---------- Order linking (combined tracking/payment for one customer's multiple orders) ----------
let _allOrdersCache = [];   // refreshed on every loadOrders() — used to look up group members
let _linkSourceOrderId = null;

// All orders sharing this order's groupId (including itself), or just
// itself if it isn't linked to anything.
function getGroupMembers(order) {
    if (!order.groupId) return [order];
    return _allOrdersCache.filter(o => o.groupId === order.groupId);
}

function groupBadgeHTML(order) {
    if (!order.groupId) return '';
    const members = getGroupMembers(order).filter(m => !(m.paid && m.pickedUp));
    if (members.length <= 1) return ''; // group dissolved down to just this order
    const unpaid = members.filter(m => !m.paymentMethod);
    const combinedTotal = unpaid.reduce((s,m) => s+(m.totalCost||0), 0);
    const idsLine = members.map(m => '#' + m.id + (m.paymentMethod ? ' ✅' : '')).join(', ');

    let html = '<div class="payment-badge" style="background:#e7f0ff;color:#1a4d8f;">🔗 Linked: ' + idsLine + '</div>';
    if (unpaid.length > 0) {
        html += '<div style="display:flex;align-items:center;gap:8px;margin:6px 0;padding:8px 10px;background:#f8f9fa;border-radius:10px;color:#333;">' +
            '<span style="font-size:13px;font-weight:600;flex:1;">Combined (unpaid): RM' + combinedTotal.toFixed(2) + '</span>' +
            '<button type="button" class="pay-method-btn" style="width:auto;padding:6px 14px;margin:0;" onclick="openGroupPaymentModal(\'' + order.groupId + '\')">💳 Pay Together</button>' +
        '</div>';
    }
    return html;
}

function openLinkOrderModal(orderId) {
    _linkSourceOrderId = orderId;
    getAllOrders().then(all => {
        all = all.map(normalizeOrder);
        const self = all.find(o => o.id === orderId);
        if (!self) return;
        const label = document.getElementById('linkOrderSelfLabel');
        if (label) label.textContent = '#' + self.id;

        // Candidates: any other still-open order not already in this same group
        const candidates = all.filter(o =>
            o.id !== orderId &&
            !(o.paid && o.pickedUp) &&
            !(self.groupId && o.groupId === self.groupId)
        );
        const listEl = document.getElementById('linkOrderList');
        if (!listEl) return;
        if (candidates.length === 0) {
            listEl.innerHTML = '<p style="color:#999;font-size:13px;">No other open orders to link.</p>';
        } else {
            listEl.innerHTML = candidates.map(o => {
                const itemSummary = Object.values(o.items||{}).filter(r=>r.qty>0).map(r=>r.name+' x'+r.qty).join(', ');
                return '<label style="display:flex;align-items:flex-start;gap:10px;padding:10px;border:1px solid #e0e0e0;border-radius:10px;margin-bottom:8px;cursor:pointer;color:#333;">' +
                    '<input type="checkbox" value="' + o.id + '" style="width:18px;height:18px;flex-shrink:0;margin-top:2px;">' +
                    '<span style="flex:1;font-size:13px;"><strong>#' + o.id + '</strong> — ' + escapeHtml(itemSummary || 'No items') +
                    '<br><span style="color:#666;">RM' + (o.totalCost||0).toFixed(2) + (o.customerName ? ' · ' + escapeHtml(o.customerName) : '') + '</span></span>' +
                '</label>';
            }).join('');
        }
        showModalById('linkOrderModal');
    });
}

function closeLinkOrderModal() {
    const modal = document.getElementById('linkOrderModal');
    if (modal) modal.style.display = 'none';
    _linkSourceOrderId = null;
}

async function confirmLinkOrders() {
    const checked = [...document.querySelectorAll('#linkOrderList input[type="checkbox"]:checked')].map(el => parseInt(el.value));
    if (checked.length === 0) { alert('Please select at least one order to link.'); return; }

    const all  = await getAllOrders();
    const self = all.find(o => o.id === _linkSourceOrderId);
    if (!self) return;

    const groupId = self.groupId || ('grp' + self.id);
    self.groupId = groupId;
    await updateOrder(self);

    for (const id of checked) {
        const o = all.find(x => x.id === id);
        if (o) { o.groupId = groupId; await updateOrder(o); }
    }

    closeLinkOrderModal();
    loadOrders();
    if (typeof loadPreorders === 'function') loadPreorders();
}

async function unlinkOrder(orderId) {
    if (!confirm('Unlink this order from its group?')) return;
    const all   = await getAllOrders();
    const order = all.find(o => o.id === orderId);
    if (!order) return;
    const gid = order.groupId;
    order.groupId = null;
    await updateOrder(order);

    // If only one member remains, dissolve the group entirely rather than
    // leaving it "linked" to nobody.
    const remaining = all.filter(o => o.id !== orderId && o.groupId === gid);
    if (remaining.length === 1) {
        remaining[0].groupId = null;
        await updateOrder(remaining[0]);
    }
    loadOrders();
    if (typeof loadPreorders === 'function') loadPreorders();
}


const _ONLINE_METHODS_BADGE = ['online', 'card', 'boost', 'tng'];
const _METHOD_ICONS = { online:'💳', card:'💳', boost:'🚀', tng:'🛣️', cash:'💵', both:'🤝' };
const _METHOD_NAMES = { online:'Online', card:'Card', boost:'Boost', tng:'T&G', cash:'Cash', both:'Both' };

function paymentBadgeHTML(order) {
    const m       = order.paymentMethod;
    const total   = orderFinalTotal(order);
    const online  = order.paymentOnline || 0;
    const cash    = order.paymentCash   || 0;
    if (!m) return '';

    const icon = _METHOD_ICONS[m] || '💳';
    const name = _METHOD_NAMES[m] || m;

    const discountLine = order.discountAmount > 0
        ? '<div class="payment-badge badge-discount" style="background:#fff3cd;color:#856404;">🏷️ Discount: -RM' + order.discountAmount.toFixed(2) +
          (order.discountReason ? ' (' + escapeHtml(order.discountReason) + ')' : '') + '</div>'
        : '';

    if (_ONLINE_METHODS_BADGE.includes(m)) {
        if (order.isDeposit) {
            const balance = total - online;
            return discountLine + '<div class="payment-badge badge-deposit">' +
                icon + ' Deposit (' + name + ') — RM' + online.toFixed(2) +
                ' &nbsp;|&nbsp; Balance: <strong>RM' + balance.toFixed(2) + '</strong>' +
                '</div>';
        }
        return discountLine + '<div class="payment-badge badge-online">' + icon + ' ' + name + ' — RM' + online.toFixed(2) + '</div>';
    }

    if (m === 'cash') {
        if (order.isCashShort) {
            const short = total - cash;
            return discountLine + '<div class="payment-badge badge-short">' +
                '⚠️ Short by <strong>RM' + short.toFixed(2) + '</strong>' +
                ' &nbsp;|&nbsp; Paid: RM' + cash.toFixed(2) +
                '</div>';
        }
        const given  = order.cashGiven || cash;
        const change = order.cashChange || 0;
        let badge = discountLine + '<div class="payment-badge badge-cash">💵 Cash — RM' + cash.toFixed(2);
        if (given > cash + 0.005) {
            badge += ' &nbsp;|&nbsp; Given: RM' + given.toFixed(2) + ' &nbsp;|&nbsp; Change: RM' + change.toFixed(2);
        }
        badge += '</div>';
        return badge;
    }

    if (m === 'both') {
        const dm     = order._digitalMethod || 'online';
        const dIcon  = _METHOD_ICONS[dm] || '💳';
        const dName  = _METHOD_NAMES[dm] || 'Online';
        const given  = order.cashGiven  || cash;
        const change = order.cashChange || 0;
        let badge = discountLine + '<div class="payment-badge badge-both">' +
            dIcon + ' ' + dName + ': RM' + online.toFixed(2) +
            ' &nbsp;|&nbsp; 💵 Cash: RM' + cash.toFixed(2);
        if (given > cash + 0.005) {
            badge += ' &nbsp;|&nbsp; Given: RM' + given.toFixed(2) + ' &nbsp;|&nbsp; Change: RM' + change.toFixed(2);
        }
        badge += '</div>';
        return badge;
    }
    return '';
}

// ---------- Render card ----------
// Groups a saved order's custom-unit items by their unit label (e.g. {slice: 12, pcs: 5}),
// returning ready-to-insert badge HTML. Skewer/kuah items are handled separately.
function getCustomUnitBadges(items) {
    if (!busyCustomToggleEnabled()) return '';
    const totals = {};
    Object.values(items || {}).forEach(it => {
        if (it.category === 'custom-unit' && it.qty > 0) {
            const label = it.unitLabel || 'pcs';
            totals[label] = (totals[label] || 0) + it.qty;
        }
    });
    return Object.entries(totals)
        .map(([label, qty]) => `<div class="detail-badge">${qty} ${escapeHtml(label)}</div>`)
        .join('');
}

function renderOrderCard(card, rawOrder, stage) {
    const o = normalizeOrder(rawOrder);

    const now       = Date.now();
    // Only pin/urgent in prepare stage — once moved forward, show plain badge
    const isPinned  = isOrderPinned(o, now) && !o.prepared && !o.paid;
    let pickupStr = null;
    if (o.pickupTs) {
        const dt = new Date(o.pickupTs);
        if (o.pickupMode === 'time') {
            pickupStr = dt.toLocaleTimeString(undefined, { hour:'2-digit', minute:'2-digit' });
        } else if (o.pickupMode === 'date') {
            pickupStr = dt.toLocaleDateString(undefined, { weekday:'short', month:'short', day:'numeric' });
        } else {
            pickupStr = dt.toLocaleString(undefined, { weekday:'short', month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
        }
    }
    // Orders with no requested pick-up date/time get no badge at all — only
    // orders that actually have a pickupTs (time, or date/datetime that has
    // arrived and moved into Prepare) show the badge, pinned/flashing once
    // within 15 minutes of the requested time.
    let pickupBadge = '';
    if (pickupStr) {
        pickupBadge = `<div class="pickup-badge ${isPinned ? 'pickup-urgent' : ''}">📅 Pick-up: ${pickupStr}</div>`;
    }

    const isExpanded = _expandedCards.has(o.id);
    // Always stamp data-stage so toggleCardExpand can find the stage without DOM traversal
    card.dataset.stage = stage;

    // Mini summary line — item names + quantities
    const miniItems = Object.values(o.items)
        .filter(r => r.qty > 0)
        .map(r => `${r.name} x${r.qty}`)
        .join(' · ');

    const header = `
        <div class="order-header" onclick="toggleCardExpand(${o.id})" style="cursor:pointer;">
            <span class="order-id">#${o.id}</span>
            ${(!isExpanded && o.customerName) ? `<span class="name-badge">👤 ${escapeHtml(o.customerName)}</span>` : ''}
            ${pickupBadge}
            <span class="order-date">${formatDate(o.createdAt)}</span>
            <span class="card-chevron">${isExpanded ? '▲' : '▼'}</span>
        </div>`;

    // Minimized view — shown when collapsed
    const miniView = `
        <div class="card-mini" onclick="toggleCardExpand(${o.id})">
            <span class="card-mini-items">${miniItems}</span>
            <span class="card-mini-total">RM ${o.totalCost.toFixed(2)}</span>
        </div>`;

    const itemBadges = Object.values(o.items)
        .filter(r => r.qty > 0)
        .map(r => `<div class="detail-badge">${escapeHtml(r.name)} (${r.qty})<br>${formatRM(r.cost)}</div>`)
        .join('');

    const showSkewerBadges = typeof menuUsesSkewerSystem === 'function' ? menuUsesSkewerSystem() : true;
    const skewerBadgeStyle = showSkewerBadges ? '' : 'display:none;';

    const statsBadges = `
        <div class="detail-badge" style="${skewerBadgeStyle}">Cucuk: ${o.skewerQty}</div>
        <div class="detail-badge" style="${skewerBadgeStyle}">${o.scoops} Senduk</div>
        ${getCustomUnitBadges(o.items)}
        <div class="detail-badge ice-cream" style="grid-column:span 2;">RM ${o.totalCost.toFixed(2)}</div>`;

    const phoneLinkHtml = o.customerPhone
        ? `<a href="https://wa.me/${toWhatsAppNumber(o.customerPhone)}" target="_blank" rel="noopener"
             onclick="event.stopPropagation();" style="color:#155724;text-decoration:none;font-weight:700;">
             📞 ${escapeHtml(o.customerPhone)} 💬</a>`
        : '';

    const contactBadge = (o.customerName || o.customerPhone)
        ? `<div class="detail-badge" style="grid-column:span 2;display:flex;align-items:center;justify-content:space-between;gap:8px;">
             <span>${o.customerName ? `👤 ${escapeHtml(o.customerName)}` : ''}${o.customerName && o.customerPhone ? ' · ' : ''}${phoneLinkHtml}</span>
             <button onclick="event.stopPropagation(); openBlockModal(${o.id});" title="Block this customer"
                 style="background:none;border:none;color:#dc3545;font-size:15px;cursor:pointer;padding:2px 4px;flex-shrink:0;line-height:1;">🚫</button>
           </div>` : '';

    const editableDesc = `<div class="order-description" id="desc-${o.id}" contenteditable="true"
        onblur="updateDescription(${o.id}, this.innerText)">${escapeHtml(o.description)}</div>`;

    const readonlyDesc = o.description
        ? `<div class="order-description" style="cursor:default;">${escapeHtml(o.description)}</div>` : '';

    // ── Edit mode (shared between prepare & prepared) ─────────────────────
    if (stage === 'prepare-edit' || stage === 'prepared-edit' || stage === 'preorder-edit') {
        const returnStage = stage === 'prepare-edit' ? 'prepare' : stage === 'preorder-edit' ? 'preorder' : 'prepared';
        const editInputs  = getMenuItems().map(item => {
            const qty = (o.items[item.id] && o.items[item.id].qty) || 0;
            return `<div><label>${escapeHtml(item.name)}</label>
                <input type="number" id="edit-${item.id}-${o.id}" class="edit-input"
                    value="${qty === 0 ? '' : qty}" placeholder="0" min="0" step="1" oninput="updateEditTotals(${o.id})"></div>`;
        }).join('');
        card.innerHTML = `
            ${header}
            <div class="edit-inputs-grid" id="edit-inputs-${o.id}">
                ${editInputs}
            </div>
            <div class="order-details" id="edit-details-${o.id}">
                <div class="detail-badge" id="edit-skewerQty-${o.id}" style="${skewerBadgeStyle}">Cucuk: ${o.skewerQty}</div>
                <div class="detail-badge" id="edit-scoops-${o.id}" style="${skewerBadgeStyle}">${o.scoops} Senduk</div>
                ${getCustomUnitBadges(o.items)}
                <div class="detail-badge ice-cream" style="grid-column:span 2;" id="edit-totalCost-${o.id}">${formatRM(o.totalCost)}</div>
            </div>
            ${editableDesc}
            <div class="action-buttons">
                <button class="save-btn"   onclick="saveEdit(${o.id}, '${returnStage}')">💾 Save</button>
                <button class="cancel-btn" onclick="cancelEditTo(${o.id}, '${returnStage}')">✖ Cancel</button>
            </div>`;
        return;
    }

    // ── Preorder ──────────────────────────────────────────────────────────
    if (stage === 'preorder') {
        const hasPaymentPre  = !!o.paymentMethod;
        const payBadgePre    = hasPaymentPre ? `<div style="margin:8px 0;">${paymentBadgeHTML(o)}</div>` : '';
        card.dataset.stage   = 'preorder';
        card.innerHTML = isExpanded ? `
            ${header}
            <div class="item-badges-grid">${itemBadges}</div>
            <div class="order-details">${statsBadges}${contactBadge}</div>
            ${editableDesc}
            ${payBadgePre}
            <div class="action-buttons">
                <button class="delete-btn" onclick="deleteOrderConfirm(${o.id})">🗑️ Cancel</button>
                <button class="edit-btn"   onclick="startEditTo(${o.id}, 'preorder')">✏️ Edit</button>
                <button class="pay-method-btn" onclick="openPaymentModal(${o.id}, ${o.totalCost}, 'preorder')">💳 Payment</button>
            </div>` : `${header}${payBadgePre}${miniView}`;
        return;
    }

    // ── Prepare ───────────────────────────────────────────────────────────
    if (stage === 'prepare') {
        const hasPayment = !!o.paymentMethod;
        const payBadge   = hasPayment
            ? `<div style="margin:8px 0;">${paymentBadgeHTML(o)}</div>` : '';
        const markPaidBtn = hasPayment
            ? `<button class="status-btn paid" onclick="markPaidDirect(${o.id})">✅ Mark as Paid</button>` : '';

        const printReceiptBtnPrepare = hasPayment
            ? `<button class="print-btn" style="margin-top:8px;width:100%;" onclick="printOrderReceipt(${o.id})">🖨️ Print Receipt</button>` : '';

        const groupBadge = groupBadgeHTML(o);
        const linkBtn = o.groupId
            ? `<button class="edit-btn" onclick="unlinkOrder(${o.id})">✖ Unlink</button>`
            : `<button class="edit-btn" onclick="openLinkOrderModal(${o.id})">🔗 Link</button>`;

        card.innerHTML = isExpanded ? `
            ${header}
            <div class="item-badges-grid">${itemBadges}</div>
            <div class="order-details">${statsBadges}${contactBadge}</div>
            ${editableDesc}
            ${groupBadge}
            ${payBadge}
            <div class="action-buttons">
                <button class="delete-btn" onclick="deleteOrderConfirm(${o.id})">🗑️ Cancel</button>
                <button class="edit-btn"   onclick="startEditTo(${o.id}, 'prepare')">✏️ Edit</button>
                ${linkBtn}
                <button class="pay-method-btn" onclick="openPaymentModal(${o.id}, ${o.totalCost}, 'prepare')">💳 Payment</button>
            </div>
            ${markPaidBtn}
            ${printReceiptBtnPrepare}
            <button class="status-btn done-btn" onclick="markPrepared(${o.id})" style="margin-top:8px;">Ready</button>`
            : `${header}${groupBadge}${payBadge}${miniView}`;
        return;
    }

    // ── Prepared ──────────────────────────────────────────────────────────
    if (stage === 'prepared') {
        const hasPayment = !!o.paymentMethod;
        const payBadge   = hasPayment
            ? `<div style="margin:8px 0;">${paymentBadgeHTML(o)}</div>` : '';

        const printReceiptBtnPrepared = hasPayment
            ? `<button class="print-btn" style="margin-top:8px;width:100%;" onclick="printOrderReceipt(${o.id})">🖨️ Print Receipt</button>` : '';

        const groupBadge = groupBadgeHTML(o);
        const linkBtn = o.groupId
            ? `<button class="edit-btn" onclick="unlinkOrder(${o.id})">✖ Unlink</button>`
            : `<button class="edit-btn" onclick="openLinkOrderModal(${o.id})">🔗 Link</button>`;

        const readyBtn = !o.isReady
            ? `<button class="status-btn" onclick="markReady(${o.id})"
                style="margin-top:8px;background:#17a2b8;border-color:#17a2b8;">
                📢 Ready — Notify Customer</button>`
            : `<div class="status-mark mark-prepared" style="margin-top:8px;background:#17a2b8;color:white;display:inline-block;padding:6px 14px;border-radius:20px;font-size:13px;">
                📢 Customer Notified</div>`;

        card.innerHTML = isExpanded ? `
            ${header}
            <div class="item-badges-grid">${itemBadges}</div>
            <div class="order-details">${statsBadges}${contactBadge}</div>
            <div class="status-row"><span class="status-mark mark-prepared">✅ Prepared</span></div>
            ${editableDesc}
            ${groupBadge}
            ${payBadge}
            <div class="action-buttons">
                <button class="delete-btn" onclick="deleteOrderConfirm(${o.id})">🗑️ Cancel</button>
                <button class="edit-btn"   onclick="startEditTo(${o.id}, 'prepared')">✏️ Edit</button>
                ${linkBtn}
                <button class="pay-method-btn" onclick="openPaymentModal(${o.id}, ${o.totalCost}, 'prepared')">💳 Payment</button>
            </div>
            ${printReceiptBtnPrepared}
            ${readyBtn}
            <button class="status-btn paid" onclick="markPaid(${o.id})" style="margin-top:8px;">✅ Mark as Paid</button>`
            : `${header}${groupBadge}${payBadge}${miniView}`;
        return;
    }

    // ── Paid ──────────────────────────────────────────────────────────────
    if (stage === 'paid') {
        const groupBadgePaid = groupBadgeHTML(o);
        const linkBtnPaid = o.groupId
            ? `<button class="edit-btn" onclick="unlinkOrder(${o.id})">✖ Unlink</button>`
            : `<button class="edit-btn" onclick="openLinkOrderModal(${o.id})">🔗 Link</button>`;
        card.innerHTML = isExpanded ? `
            ${header}
            <div class="item-badges-grid">${itemBadges}</div>
            <div class="order-details">${statsBadges}${contactBadge}</div>
            <div class="status-row"><span class="status-mark mark-paid">✅ Paid</span></div>
            ${groupBadgePaid}
            <div style="margin:8px 0;">${paymentBadgeHTML(o)}</div>
            ${readonlyDesc}
            <div class="action-buttons">
                <button class="edit-btn"       onclick="undoToPrepared(${o.id})">↩️ Undo</button>
                ${linkBtnPaid}
                <button class="pay-method-btn" onclick="openPaymentModal(${o.id}, ${o.totalCost}, 'paid')">💳 Update Payment</button>
                <button class="status-btn picked" onclick="markPickedUp(${o.id})">📦 Picked Up</button>
            </div>`
            : `${header}${groupBadgePaid}${paymentBadgeHTML(o) ? `<div style="margin:4px 0;">${paymentBadgeHTML(o)}</div>` : ''}${miniView}`;
        return;
    }

    // ── Done ──────────────────────────────────────────────────────────────
    if (stage === 'done') {
        card.innerHTML = isExpanded ? `
            ${header}
            <div class="item-badges-grid">${itemBadges}</div>
            <div class="order-details">${statsBadges}${contactBadge}</div>
            <div class="status-row">
                <span class="status-mark mark-paid">✅ Paid</span>
                <span class="status-mark mark-picked">📦 Picked Up</span>
            </div>
            <div style="margin:8px 0;">${paymentBadgeHTML(o)}</div>
            ${readonlyDesc}
            <div class="action-buttons">
                <button class="delete-btn" onclick="deleteOrderConfirm(${o.id})">🗑️ Delete</button>
                <button class="print-btn"  onclick="printOrder(${o.id})">🖨️ Print</button>
            </div>`
            : `${header}${miniView}`;
        return;
    }
}

// ---------- Edit helpers ----------
function startEditTo(id, fromStage) {
    const card = document.getElementById(`order-${id}`);
    if (!card) return;
    getAllOrders().then(orders => {
        const o = orders.find(o => o.id === id);
        if (o) {
            _editingIds.add(id);
            card.dataset.stage = fromStage;
            renderOrderCard(card, normalizeOrder(o), fromStage + '-edit');
        }
    });
}
function cancelEditTo(id, returnStage) {
    _editingIds.delete(id);
    loadOrders();
    loadPreorders();
}
// Legacy shims
function startEdit(id)  { startEditTo(id, 'prepare'); }
function cancelEdit(id) { cancelEditTo(id, 'prepare'); }

function getEditQuantities(orderId) {
    const q = {};
    getMenuItems().forEach(item => {
        const el = document.getElementById(`edit-${item.id}-${orderId}`);
        q[item.id] = el ? (parseInt(el.value)||0) : 0;
    });
    return q;
}
function updateEditTotals(id) {
    const t = calculateTotals(getEditQuantities(id));
    document.getElementById(`edit-skewerQty-${id}`).innerText = `Cucuk: ${t.skewerQty}`;
    document.getElementById(`edit-totalCost-${id}`).innerText = formatRM(t.totalCost);
    document.getElementById(`edit-scoops-${id}`).innerText    = `${t.scoops} Senduk`;
}
async function saveEdit(id, returnStage = 'prepare') {
    const totals      = calculateTotals(getEditQuantities(id));
    const description = document.getElementById(`desc-${id}`).innerText.trim() || '';
    const all         = await getAllOrders();
    const existing    = all.find(o => o.id === id);
    if (!existing) return;

    // ── Availability check (unified model v2 — see box.js header comment) ──
    // Same live formula as saveOrder(), excluding THIS order's own current
    // pending demand from the baseline (we're replacing its items, not
    // adding a new order on top of them). Nothing is deducted/returned —
    // KNOWN LIMITATION: if this order was already Prepared (its items
    // already taken out of the Box at the Ready button), editing its
    // quantities here doesn't adjust the Box to match — low-frequency edge
    // case, flagged here rather than solved, same spirit as the note in
    // box_stock_v2_unified.sql.
    if (!existing.paid) {
        const pendingDemand = computePendingDemandByItem(all.filter(o => o.id !== id).map(normalizeOrder));
        for (const [itemId, item] of Object.entries(totals.items)) {
            if (item.qty <= 0) continue;
            const stockQty = (typeof getStockFor === 'function') ? getStockFor(itemId) : null;
            if (stockQty === null || stockQty === undefined) continue; // unlimited
            const boxQty = (typeof getBoxQty === 'function') ? getBoxQty(itemId) : 0;
            const avail  = stockQty + boxQty - (pendingDemand[itemId] || 0);
            if (item.qty > avail) {
                alert(`❌ Insufficient stock: ${item.name}\nAvailable: ${Math.max(0, avail)}`);
                return;
            }
        }
    }

    const updated = { ...existing, items:totals.items, totalCost:totals.totalCost,
        skewerQty:totals.skewerQty, scoops:totals.scoops, description };
    ['ayam','daging','lontong','shortong'].forEach(k => {
        delete updated[k]; delete updated[k+'Cost'];
    });
    delete updated.ayamDagingQty;

    await updateOrder(updated);
    _editingIds.delete(id);
    loadOrders();
    loadPreorders();
}
async function updateDescription(id, newText) {
    const all   = await getAllOrders();
    const order = all.find(o => o.id === id);
    if (order) { order.description = newText.trim() || ''; await updateOrder(order); }
}

// ---------- Stage transitions ----------

// Prepare → Prepared (no payment yet) — this is the "Ready" button, and the
// moment the Box actually gets debited (see box.js: deductBoxForPacking).
// Placing the order never touched the Box; packing it does.
async function markPrepared(id) {
    const all   = await getAllOrders();
    const order = all.find(o => o.id === id);
    if (order) {
        order.prepared = true;
        await updateOrder(order);
        if (typeof deductBoxForPacking === 'function') {
            await deductBoxForPacking(order.items || {});
        }
        loadOrders();
    }
}

// Prepare → Paid directly (payment already set) — also represents packing
// happening (prepared becomes true here too), so the Box gets debited the
// same way markPrepared() does.
async function markPaidDirect(id) {
    const all   = await getAllOrders();
    const order = all.find(o => o.id === id);
    if (!order || !order.paymentMethod) return;
    order.prepared = true;
    order.paid     = true;
    await updateOrder(order);
    if (typeof deductBoxForPacking === 'function') {
        await deductBoxForPacking(order.items || {});
    }
    loadOrders();
}

// Prepared → Paid (must have payment set)
async function markPaid(id) {
    const all   = await getAllOrders();
    const order = all.find(o => o.id === id);
    if (!order) return;
    if (!order.paymentMethod) {
        alert('⚠️ Please set the payment method first (tap 💳 Payment).');
        return;
    }
    order.paid = true;
    await updateOrder(order);
    loadOrders();
}

// Prepared → Ready (notify customer)
async function markReady(id) {
    const all   = await getAllOrders();
    const order = all.find(o => o.id === id);
    if (order) {
        order.isReady = true;
        await updateOrder(order);
        loadOrders();
    }
}

// Paid → Prepared (undo)
async function undoToPrepared(id) {
    if (!confirm('Move this order back to Prepared?')) return;
    const all   = await getAllOrders();
    const order = all.find(o => o.id === id);
    if (order) { order.paid = false; await updateOrder(order); loadOrders(); }
}

// Paid → Done
async function markPickedUp(id) {
    const all   = await getAllOrders();
    const order = all.find(o => o.id === id);
    if (order) { order.pickedUp = true; await updateOrder(order); loadOrders(); }
}

async function deleteOrderConfirm(id) {
    if (confirm('Delete this order?')) {
        const all   = await getAllOrders();
        const order = normalizeOrder(all.find(o => o.id === id) || {});
        // Unified model v2 (see box.js header comment): placing an order
        // never deducts Stock or Box, so cancelling one before it's ever
        // been packed needs no action — nothing was taken.
        //   - Prepared but not yet paid: it WAS packed (Box was debited at
        //     the Ready button — see markPrepared) — put those items back
        //     in the Box, still cooked and good for the next order.
        //   - Paid or Done: no action — the sale is already final and
        //     stays in the report regardless of pickup (see point 6).
        if (order && order.prepared && !order.paid && typeof returnItemsToBox === 'function') {
            await returnItemsToBox(order.items || {});
        }
        await deleteOrder(id);
        loadOrders();
        loadPreorders();
    }
}

// ---------- Payment Modal ----------
let _pmOrderId = null;
let _pmTotal   = 0;           // effective total to collect (after discount)
let _pmOriginalTotal = 0;     // order.totalCost before discount
let _pmReturnStage = 'prepare';
let _pmDiscount = { type: null, value: 0, amount: 0, reason: '' };
let _pmGroupOrderIds = null;  // set when paying multiple linked orders together
// True once the staff has typed directly into the OCBT amount field this
// session — once set, the cash-driven auto-sync below stops touching it, so
// a deliberately custom split (e.g. "give change" scenario) never gets
// silently overwritten by the next keystroke in the cash field.
let _ocbtManuallyEdited = false;

// Computes the discount RM amount from a type + raw value, clamped sensibly
// (percent 0-100, amount capped at the order's own total — never negative).
function _calcDiscountAmount(type, value, originalTotal) {
    const v = Math.max(0, value || 0);
    if (type === 'percent') return +(originalTotal * Math.min(100, v) / 100).toFixed(2);
    if (type === 'amount')  return +(Math.min(originalTotal, v)).toFixed(2);
    return 0;
}

// The amount actually owed/collected for an order — original total minus
// whatever discount was applied at payment time. Use this (not raw
// order.totalCost) anywhere the real amount owed/paid/printed matters.
function orderFinalTotal(order) {
    return Math.max(0, +((order.totalCost || 0) - (order.discountAmount || 0)).toFixed(2));
}

function openPaymentModal(orderId, total, returnStage) {
    _pmOrderId       = orderId;
    _pmOriginalTotal = total;
    _pmReturnStage   = returnStage;
    _pmGroupOrderIds = null;

    getAllOrders().then(all => {
        const order  = all.find(o => o.id === orderId);
        const method = (order && order.paymentMethod) || 'online';
        document.querySelectorAll('input[name="payMethod"]').forEach(r => r.checked = r.value === method);
        _pmDiscount = {
            type:   (order && order.discountType)   || null,
            value:  (order && order.discountValue)  || 0,
            amount: (order && order.discountAmount) || 0,
            reason: (order && order.discountReason) || ''
        };
        _recomputePmTotal();
        _renderDiscountBox();
        _renderPayInputs(method, order);
        showModalById('paymentModal');
    });
}

function openGroupPaymentModal(groupId) {
    getAllOrders().then(all => {
        all = all.map(normalizeOrder);
        const members = all.filter(o => o.groupId === groupId && !(o.paid && o.pickedUp) && !o.paymentMethod);
        if (members.length === 0) { alert('Nothing left to pay in this group.'); return; }

        _pmOrderId       = null;
        _pmGroupOrderIds = members.map(m => m.id);
        _pmOriginalTotal = members.reduce((s,m) => s+(m.totalCost||0), 0);
        _pmReturnStage   = null;
        _pmDiscount      = { type: null, value: 0, amount: 0, reason: '' };

        document.querySelectorAll('input[name="payMethod"]').forEach(r => r.checked = r.value === 'online');
        _recomputePmTotal();
        _renderDiscountBox();
        _renderPayInputs('online', null);
        showModalById('paymentModal');
    });
}

function _recomputePmTotal() {
    _pmTotal = Math.max(0, +((_pmOriginalTotal - (_pmDiscount.amount || 0)).toFixed(2)));
    const p = document.getElementById('payModalTotal');
    if (!p) return;
    const groupNote = (_pmGroupOrderIds && _pmGroupOrderIds.length > 1)
        ? ` <span style="color:#1a4d8f;">(${_pmGroupOrderIds.length} linked orders: ${_pmGroupOrderIds.map(id=>'#'+id).join(', ')})</span>`
        : '';
    p.innerHTML = (_pmDiscount.amount > 0
        ? `Subtotal: RM${_pmOriginalTotal.toFixed(2)} &nbsp;·&nbsp; Discount: <span style="color:#dc3545;">-RM${_pmDiscount.amount.toFixed(2)}</span> &nbsp;·&nbsp; <strong>To collect: RM${_pmTotal.toFixed(2)}</strong>`
        : `Total: RM${_pmOriginalTotal.toFixed(2)}`) + groupNote;
}

function _renderDiscountBox() {
    const box = document.getElementById('discountBox');
    if (!box) return;
    const isOn = !!_pmDiscount.type;
    box.innerHTML =
        '<div style="display:flex;align-items:center;gap:10px;margin-bottom:' + (isOn ? 10 : 16) + 'px;padding:10px;background:#f8f9fa;border-radius:10px;color:#333;">' +
            '<span style="font-size:13px;font-weight:600;flex:1;">🏷️ Apply discount?</span>' +
            '<button type="button" id="discountToggle" onclick="_toggleDiscountSection()" ' +
                'style="padding:6px 16px;border-radius:20px;border:2px solid ' + (isOn ? '#28a745' : '#6c757d') + ';background:' + (isOn ? '#28a745' : 'white') + ';font-size:13px;font-weight:600;cursor:pointer;color:' + (isOn ? 'white' : '#6c757d') + ';">' + (isOn ? 'ON' : 'OFF') + '</button>' +
        '</div>' +
        '<div id="discountFields" style="display:' + (isOn ? 'block' : 'none') + ';margin-bottom:16px;">' +
            '<div style="display:flex;gap:6px;margin-bottom:8px;">' +
                '<label class="pay-radio-label" style="flex:1;text-align:center;justify-content:center;">' +
                    '<input type="radio" name="discountType" value="percent" ' + (_pmDiscount.type === 'amount' ? '' : 'checked') + ' onchange="_onDiscountInputChange()"> % Percent' +
                '</label>' +
                '<label class="pay-radio-label" style="flex:1;text-align:center;justify-content:center;">' +
                    '<input type="radio" name="discountType" value="amount" ' + (_pmDiscount.type === 'amount' ? 'checked' : '') + ' onchange="_onDiscountInputChange()"> RM Amount' +
                '</label>' +
            '</div>' +
            '<input type="number" id="discountValueInput" step="0.01" min="0" class="pay-input" placeholder="Discount value" value="' + (_pmDiscount.value > 0 ? _pmDiscount.value : '') + '">' +
            '<input type="text" id="discountReasonInput" class="pay-input" style="margin-top:8px;" placeholder="Reason (optional) — e.g. regular customer" value="' + escapeHtml(_pmDiscount.reason || '') + '">' +
            '<div id="discountPreview" style="margin-top:8px;font-size:12.5px;color:#28a745;font-weight:600;"></div>' +
        '</div>';

    const valEl = document.getElementById('discountValueInput');
    const reasonEl = document.getElementById('discountReasonInput');
    if (valEl)    valEl.addEventListener('input', _onDiscountInputChange);
    if (reasonEl) reasonEl.addEventListener('input', _onDiscountInputChange);
    _updateDiscountPreview();
}

function _toggleDiscountSection() {
    if (_pmDiscount.type) {
        _pmDiscount = { type: null, value: 0, amount: 0, reason: _pmDiscount.reason };
    } else {
        _pmDiscount.type = 'percent';
    }
    _renderDiscountBox();
    _recomputePmTotal();
    _renderPayInputs(_currentPayMethod(), null);
}

function _currentPayMethod() {
    const sel = document.querySelector('input[name="payMethod"]:checked');
    return sel ? sel.value : 'online';
}

function _onDiscountInputChange() {
    const typeEl = document.querySelector('input[name="discountType"]:checked');
    _pmDiscount.type = typeEl ? typeEl.value : 'percent';
    const valEl = document.getElementById('discountValueInput');
    _pmDiscount.value = valEl ? (parseFloat(valEl.value) || 0) : 0;
    const reasonEl = document.getElementById('discountReasonInput');
    _pmDiscount.reason = reasonEl ? reasonEl.value.trim() : '';
    _pmDiscount.amount = _calcDiscountAmount(_pmDiscount.type, _pmDiscount.value, _pmOriginalTotal);

    _updateDiscountPreview();
    _recomputePmTotal();
    _renderPayInputs(_currentPayMethod(), null);
}

function _updateDiscountPreview() {
    const el = document.getElementById('discountPreview');
    if (!el) return;
    el.textContent = _pmDiscount.amount > 0
        ? '-RM' + _pmDiscount.amount.toFixed(2) + ' off → New total: RM' + Math.max(0, _pmOriginalTotal - _pmDiscount.amount).toFixed(2)
        : '';
}

function closePaymentModal() {
    hideModalById('paymentModal');
}

function onPayMethodChange(el) {
    _renderPayInputs(el.value, null);
}

function _renderPayInputs(method, existingOrder) {
    const box    = document.getElementById('paymentInputsBox');
    const total  = _pmTotal;
    const DIGITAL = ['online', 'card', 'boost', 'tng'];
    const LABELS  = { online:'Online', card:'Card', boost:'Boost', tng:'T&G' };

    if (method === 'cash') {
        const val = (existingOrder && existingOrder.paymentMethod === 'cash') ? existingOrder.paymentCash : 0;
        box.innerHTML =
            '<div class="pay-total-hint">Bill total: <strong>RM' + total.toFixed(2) + '</strong></div>' +
            '<label class="pay-label">Cash Given by Customer (RM)</label>' +
            '<input type="number" id="payCashInput" step="0.01" min="0" class="pay-input" placeholder="How much did they give?">' +
            '<div id="changeDisplay" class="change-display" style="display:none;"></div>';
        document.getElementById('payCashInput').value = val > 0 ? val.toFixed(2) : '';
        document.getElementById('payCashInput').addEventListener('input', function() {
            const given = parseFloat(this.value) || 0;
            const disp  = document.getElementById('changeDisplay');
            if (given <= 0) { disp.style.display = 'none'; return; }
            const diff = given - total;
            disp.style.display = 'block';
            if (diff < -0.005) {
                disp.className = 'change-display change-short';
                disp.innerHTML = '&#9888; Short by <strong>RM' + Math.abs(diff).toFixed(2) + '</strong>';
            } else {
                disp.className = 'change-display change-ok';
                disp.innerHTML = 'Change: <strong>RM' + diff.toFixed(2) + '</strong>';
            }
        });
        if (val > 0) document.getElementById('payCashInput').dispatchEvent(new Event('input'));
        return;
    }

    if (DIGITAL.includes(method)) {
        const label   = LABELS[method] || method;
        const exM     = existingOrder && existingOrder.paymentMethod;
        const exDig   = existingOrder && existingOrder._digitalMethod;
        const isBoth  = exM === 'both' && exDig === method;
        const dVal    = isBoth ? existingOrder.paymentOnline
                      : (existingOrder && DIGITAL.includes(exM)) ? existingOrder.paymentOnline : total;
        const cVal    = isBoth ? existingOrder.paymentCash : 0;

        // An existing split payment already has its own deliberate OCBT/cash
        // breakdown (possibly a "give change" split, not a plain total-minus-cash
        // one) — treat it as manually set from the start so re-opening this
        // order for editing doesn't let the auto-sync silently recompute it.
        _ocbtManuallyEdited = isBoth && cVal > 0;

        box.innerHTML =
            '<div class="pay-total-hint">Bill total: <strong>RM' + total.toFixed(2) + '</strong></div>' +
            '<label class="pay-label">' + label + ' Amount (RM)</label>' +
            '<input type="number" id="payOnlineInput" step="0.01" min="0" class="pay-input">' +
            '<div id="onlineDepositHint" class="change-display" style="display:none;"></div>' +
            '<div style="display:flex;align-items:center;gap:10px;margin-top:14px;padding:10px;background:#f8f9fa;border-radius:10px;color:#333;">' +
                '<span style="font-size:13px;font-weight:600;flex:1;">+ Cash as well?</span>' +
                '<button type="button" id="withCashToggle" onclick="_toggleCashSection()" ' +
                    'style="padding:6px 16px;border-radius:20px;border:2px solid #6c757d;background:white;font-size:13px;font-weight:600;cursor:pointer;color:#6c757d;"' +
                    '>OFF</button>' +
            '</div>' +
            '<div id="cashSection" style="display:none;margin-top:10px;">' +
                '<label class="pay-label">Cash Given by Customer (RM)</label>' +
                '<input type="number" id="payCashInput" step="0.01" min="0" class="pay-input" placeholder="How much did they give?">' +
                '<div id="changeDisplayBoth" class="change-display" style="display:none;"></div>' +
                '<div class="pay-total-hint" style="margin-top:6px;">The ' + label + ' amount above auto-adjusts to match — edit it directly if the customer wants change back from the cash instead.</div>' +
            '</div>';

        document.getElementById('payOnlineInput').value = dVal.toFixed(2);

        document.getElementById('payOnlineInput').addEventListener('input', function(e) {
            // Only a genuine keystroke should count as "the staff wants a custom
            // split" and stop the cash-driven auto-sync. e.isTrusted is false for
            // the programmatic dispatchEvent() calls used elsewhere just to
            // refresh this hint (e.g. right when the modal opens) — without this
            // check, that initial refresh alone was permanently blocking the
            // auto-sync before the staff had touched anything.
            if (e.isTrusted) _ocbtManuallyEdited = true;
            _updatePayHints();
        });

        if (isBoth && cVal > 0) {
            // Auto-enable cash section for existing both orders
            setTimeout(() => {
                const btn = document.getElementById('withCashToggle');
                if (btn && btn.textContent === 'OFF') _toggleCashSection(cVal);
            }, 50);
        }
        document.getElementById('payOnlineInput').dispatchEvent(new Event('input'));
    }
}

// Single source of truth for both payment hints, called after ANY change to
// either the OCBT amount or the cash-given amount — whichever field the
// staff just edited. Previously each field only refreshed its own hint, so
// editing OCBT after already typing a cash amount left the change/short
// display showing stale numbers computed from the old OCBT value.
function _updatePayHints() {
    const onlineEl   = document.getElementById('payOnlineInput');
    const onlineHint = document.getElementById('onlineDepositHint');
    const cashBtn    = document.getElementById('withCashToggle');
    const cashOn     = !!cashBtn && cashBtn.textContent === 'ON';
    const paid       = onlineEl ? (parseFloat(onlineEl.value) || 0) : 0;

    if (!cashOn) {
        // No cash portion — plain deposit/full-payment hint on the OCBT amount alone.
        if (!onlineHint) return;
        const balance = _pmTotal - paid;
        if (paid <= 0) { onlineHint.style.display = 'none'; return; }
        onlineHint.style.display = 'block';
        if (balance > 0.005) {
            onlineHint.className = 'change-display change-short';
            onlineHint.innerHTML = '&#9888; Deposit — Balance: <strong>RM' + balance.toFixed(2) + '</strong>';
        } else {
            onlineHint.className = 'change-display change-ok';
            onlineHint.innerHTML = '&#10003; Full payment — RM' + paid.toFixed(2);
        }
        return;
    }

    // Cash is active — the plain OCBT-only hint above doesn't know about the
    // cash portion, so it would show a misleading "still owing" message even
    // when cash covers the rest (or overpays it, needing change). Hide it and
    // show the combined change/short figure instead.
    if (onlineHint) onlineHint.style.display = 'none';

    const cashEl = document.getElementById('payCashInput');
    const disp   = document.getElementById('changeDisplayBoth');
    if (!cashEl || !disp) return;
    const cashGiven = parseFloat(cashEl.value) || 0;
    if (cashGiven <= 0) { disp.style.display = 'none'; return; }

    const cashOwed = Math.max(0, _pmTotal - paid);
    const change   = cashGiven - cashOwed;
    disp.style.display = 'block';
    if (change < -0.005) {
        disp.className = 'change-display change-short';
        disp.innerHTML = '&#9888; Short by <strong>RM' + Math.abs(change).toFixed(2) + '</strong>';
    } else {
        disp.className = 'change-display change-ok';
        disp.innerHTML = 'Change: <strong>RM' + change.toFixed(2) + '</strong>';
    }
}

function _toggleCashSection(prefillVal) {
    const btn     = document.getElementById('withCashToggle');
    const section = document.getElementById('cashSection');
    if (!btn || !section) return;
    const isOn = btn.textContent === 'OFF';
    btn.textContent      = isOn ? 'ON' : 'OFF';
    btn.style.background = isOn ? '#28a745' : 'white';
    btn.style.color      = isOn ? 'white'   : '#6c757d';
    btn.style.borderColor= isOn ? '#28a745' : '#6c757d';
    section.style.display = isOn ? 'block' : 'none';
    if (!isOn) {
        // Cash portion turned off — if the OCBT amount was only ever the
        // auto-computed "total minus cash" figure, put it back to the full
        // total. A deliberately hand-typed OCBT amount is left alone.
        if (!_ocbtManuallyEdited) {
            const onlineEl = document.getElementById('payOnlineInput');
            if (onlineEl) onlineEl.value = _pmTotal.toFixed(2);
        }
        _updatePayHints();
        return;
    }
    const cashEl = document.getElementById('payCashInput');
    if (cashEl && prefillVal !== undefined) cashEl.value = prefillVal.toFixed(2);
    if (cashEl && !cashEl._hasListener) {
        cashEl._hasListener = true;
        cashEl.addEventListener('input', function() {
            const cashGiven = parseFloat(this.value) || 0;
            // Convenience auto-sync: as long as the staff hasn't hand-edited the
            // OCBT field this session, keep it at "total − cash" so the two
            // always add up with no manual arithmetic. The moment OCBT is
            // edited directly, this stops — see the OCBT input's own listener.
            if (!_ocbtManuallyEdited) {
                const onlineEl = document.getElementById('payOnlineInput');
                if (onlineEl) onlineEl.value = Math.max(0, _pmTotal - cashGiven).toFixed(2);
            }
            _updatePayHints();
        });
    }
    _updatePayHints();
}

// Splits `amount` across `weights` proportionally, rounded to cents, with
// any rounding remainder folded into the last share so the parts always
// sum to exactly `amount`.
function _splitProportionally(amount, weights) {
    const totalWeight = weights.reduce((s,w) => s+w, 0);
    if (totalWeight <= 0) return weights.map(() => 0);
    const parts = weights.map(w => +(amount * w / totalWeight).toFixed(2));
    const sum   = parts.reduce((s,p) => s+p, 0);
    const diff  = +(amount - sum).toFixed(2);
    if (parts.length) parts[parts.length-1] = +(parts[parts.length-1] + diff).toFixed(2);
    return parts;
}

// Applies one order's share of a payment to it — same logic whether it's
// the only order being paid, or one of several linked orders being paid
// together (in which case `total`/`onlineAmt`/`cashAmt` are already this
// order's proportional slice, computed by the caller).
function _applyPaymentToOrder(order, method, hasCashSection, onlineAmt, cashAmt, total) {
    const _ONLINE_METHODS = ['online', 'card', 'boost', 'tng'];

    if (_ONLINE_METHODS.includes(method) && hasCashSection) {
        const cashOwed   = Math.max(0, total - onlineAmt);
        const cashChange = cashAmt - cashOwed;
        order.paymentMethod  = 'both';
        order._digitalMethod = method;
        order.paymentOnline  = onlineAmt;
        order.paymentCash    = cashChange > 0 ? cashOwed : cashAmt;
        order.cashGiven      = cashAmt;
        order.cashChange     = cashChange > 0 ? cashChange : 0;
        order.isDeposit      = false;
        order.isCashShort    = cashAmt < cashOwed - 0.005;
        return;
    }

    order.paymentMethod = method;
    order.paymentOnline = (method === 'cash')              ? 0 : onlineAmt;
    order.paymentCash   = _ONLINE_METHODS.includes(method) ? 0 : cashAmt;

    if (_ONLINE_METHODS.includes(method)) {
        order.isDeposit   = onlineAmt < (total - 0.005);
        order.isCashShort = false;
    } else if (method === 'cash') {
        const cashChange  = cashAmt - total;
        order.isCashShort = cashAmt < (total - 0.005);
        order.cashGiven   = cashAmt;
        order.cashChange  = cashChange > 0 ? cashChange : 0;
        order.paymentCash = order.isCashShort ? cashAmt : total;
        order.isDeposit   = false;
    } else {
        order.isDeposit   = false;
        order.isCashShort = false;
    }
}

async function confirmPayment() {
    const selected = document.querySelector('input[name="payMethod"]:checked');
    if (!selected) { alert('Please select a payment method.'); return; }
    const method   = selected.value;
    const onlineEl = document.getElementById('payOnlineInput');
    const cashEl   = document.getElementById('payCashInput');
    const onlineAmt = onlineEl ? (parseFloat(onlineEl.value)||0) : 0;
    const cashAmt   = cashEl   ? (parseFloat(cashEl.value)||0)   : 0;

    // Confirm before saving an unusually large discount (>50% off, or the
    // whole order) — easy to fat-finger a % vs RM amount by mistake.
    if (_pmDiscount.amount > 0 && _pmOriginalTotal > 0 && (_pmDiscount.amount / _pmOriginalTotal) > 0.5) {
        const pct = Math.round(_pmDiscount.amount / _pmOriginalTotal * 100);
        if (!confirm(`⚠️ This discount is ${pct}% off (RM${_pmDiscount.amount.toFixed(2)} of RM${_pmOriginalTotal.toFixed(2)}). Continue?`)) return;
    }

    if (method === 'both') {
        // "cashAmt" here is cash GIVEN, which can legitimately exceed what's
        // actually owed in cash when the customer wants change back (see
        // _applyPaymentToOrder's identical cashOwed logic) — only the portion
        // actually applied to the bill counts toward this total check, so a
        // deliberate change-due split doesn't trip a false "doesn't match" warning.
        const cashOwed    = Math.max(0, _pmTotal - onlineAmt);
        const appliedCash = cashAmt >= cashOwed ? cashOwed : cashAmt;
        const sum = onlineAmt + appliedCash;
        if (Math.abs(sum - _pmTotal) > 0.01) {
            if (!confirm(`⚠️ Total entered (${formatRM(sum)}) doesn't match order total (${formatRM(_pmTotal)}). Save anyway?`)) return;
        }
    }

    const all = await getAllOrders();

    // Single order, or several linked orders being paid together — the
    // rest of this function treats both the same way, splitting the
    // entered amounts proportionally across whichever orders are involved.
    let targetOrders;
    if (_pmGroupOrderIds && _pmGroupOrderIds.length > 0) {
        targetOrders = _pmGroupOrderIds.map(id => all.find(o => o.id === id)).filter(Boolean);
    } else {
        const single = all.find(o => o.id === _pmOrderId);
        targetOrders = single ? [single] : [];
    }
    if (targetOrders.length === 0) return;

    // Split the discount across orders by their own sticker price share
    const discountShares = _splitProportionally(_pmDiscount.amount || 0, targetOrders.map(o => o.totalCost || 0));
    targetOrders.forEach((o,i) => {
        o.discountType   = _pmDiscount.type   || null;
        o.discountValue  = _pmDiscount.value  || 0;
        o.discountAmount = discountShares[i];
        o.discountReason = _pmDiscount.reason || '';
    });

    // Then split what was actually entered (online/cash) by each order's
    // own post-discount total — so a bigger order gets a bigger slice.
    const finalTotals  = targetOrders.map(o => Math.max(0, +(((o.totalCost||0) - (o.discountAmount||0)).toFixed(2))));
    const onlineShares = _splitProportionally(onlineAmt, finalTotals);
    const cashShares    = _splitProportionally(cashAmt,   finalTotals);

    const withCashToggle = document.getElementById('withCashToggle');
    const hasCashSection = withCashToggle && withCashToggle.textContent === 'ON';

    targetOrders.forEach((o,i) => {
        _applyPaymentToOrder(o, method, hasCashSection, onlineShares[i], cashShares[i], finalTotals[i]);
    });

    for (const o of targetOrders) await updateOrder(o);

    closePaymentModal();
    loadOrders();
    if (typeof loadPreorders === 'function') loadPreorders();
}

// ─── Done tab date filter ─────────────────────────────────────────────────────
async function _populateDoneDateFilter() {
    const sel = document.getElementById('doneDateFilter');
    if (!sel) return;
    const orders = (await getAllOrders()).map(normalizeOrder);
    const done   = orders.filter(o => o.paid && o.pickedUp);
    const dateSet = new Set();
    done.forEach(o => dateSet.add(dayKey(o.createdAt)));
    const today = dayKey();
    const dates = Array.from(dateSet).sort().reverse();
    const current = sel.value;
    sel.innerHTML = `<option value="today">Today (${today})</option><option value="all">All dates</option>`;
    dates.forEach(d => {
        if (d !== today) {
            const label = new Date(d+'T00:00:00').toLocaleDateString(undefined, { weekday:'short', year:'numeric', month:'short', day:'numeric' });
            sel.innerHTML += `<option value="${d}">${label}</option>`;
        }
    });
    if (current && [...sel.options].some(o => o.value === current)) sel.value = current;
    else sel.value = 'today';
}

// ─── PDF Report ───────────────────────────────────────────────────────────────
function openReportModal() {
    if (!document.getElementById('reportModal')) return;
    document.getElementById('reportDate').value  = dayKey();
    document.getElementById('reportMonth').value = dayKey().substring(0,7);
    updateReportDateUI();
    showModalById('reportModal');
}
function closeReportModal() {
    hideModalById('reportModal');
}
function updateReportDateUI() {
    const type = document.getElementById('reportType').value;
    document.getElementById('reportDatePicker').style.display  = type==='day'    ? 'block' : 'none';
    document.getElementById('reportMonthPicker').style.display = type==='month'  ? 'block' : 'none';
    document.getElementById('reportYearPicker').style.display  = type==='yearly' ? 'block' : 'none';
}

async function generateReport() {
    const type      = document.getElementById('reportType').value;
    const allOrders = (await getAllOrders()).map(normalizeOrder);
    const done      = allOrders.filter(o => o.paid && o.pickedUp);
    let filtered, title, subtitle;

    if (type === 'day') {
        const date = document.getElementById('reportDate').value;
        if (!date) { alert('Please select a date.'); return; }
        filtered = done.filter(o => dayKey(o.createdAt) === date);
        subtitle = new Date(date+'T00:00:00').toLocaleDateString(undefined, { weekday:'long', year:'numeric', month:'long', day:'numeric' });
        title    = 'DAILY SALES REPORT';
    } else if (type === 'month') {
        const month = document.getElementById('reportMonth').value;
        if (!month) { alert('Please select a month.'); return; }
        filtered = done.filter(o => dayKey(o.createdAt).substring(0,7) === month);
        const [y,m] = month.split('-');
        subtitle = new Date(y, m-1, 1).toLocaleDateString(undefined, { year:'numeric', month:'long' });
        title    = 'MONTHLY SALES REPORT';
    } else {
        const year = document.getElementById('reportYear').value;
        if (!year) { alert('Please select a year.'); return; }
        filtered = done.filter(o => new Date(o.createdAt).getFullYear() === parseInt(year));
        subtitle = year;
        title    = 'YEARLY SALES REPORT';
    }

    if (filtered.length === 0) { alert('No completed orders found for the selected period.'); return; }
    _buildPDF(title, subtitle, filtered);
    closeReportModal();
}

function _buildPDF(title, subtitle, orders) {
    const { jsPDF } = window.jspdf;
    const doc    = new jsPDF({ unit:'mm', format:'a4' });
    const PAGE_W = 210, MARGIN = 16, COL_W = PAGE_W - MARGIN*2;
    let y = 20;
    const LINE_H = 6, HEAD_BG = [41,128,185], ROW_ALT = [245,248,252], BORDER = [200,210,220];

    function checkPage(n=10) { if (y+n > 275) { doc.addPage(); y=20; } }

    // Header
    doc.setFillColor(...HEAD_BG); doc.rect(0,0,PAGE_W,36,'F');
    doc.setTextColor(255,255,255);
    doc.setFontSize(18); doc.setFont('helvetica','bold');
    doc.text((localStorage.getItem('shmBusinessName')||APP_CONFIG.APP_NAME).toUpperCase(), PAGE_W/2, 13, {align:'center'});
    doc.setFontSize(13); doc.setFont('helvetica','normal');
    doc.text(title, PAGE_W/2, 21, {align:'center'});
    doc.setFontSize(10);
    doc.text(subtitle, PAGE_W/2, 28, {align:'center'});
    doc.text(`Generated: ${new Date().toLocaleString()}`, PAGE_W/2, 34, {align:'center'});
    y = 44; doc.setTextColor(0,0,0);

    // Totals
    // "Gross" = sticker total of items sold (before discount). "Discount" =
    // total given away. "Net Revenue" = what was actually collected — the
    // figure that should tie to the payment-method breakdown below.
    const grossSales    = orders.reduce((s,o) => s+(o.totalCost||0), 0);
    const totalDiscount = orders.reduce((s,o) => s+(o.discountAmount||0), 0);
    const netRevenue    = grossSales - totalDiscount;
    const totalOrders   = orders.length;
    const discountedOrderCount = orders.filter(o => (o.discountAmount||0) > 0).length;

    // Breakdown by each actual payment channel (online / card / boost / tng / cash).
    // IMPORTANT: split ('both') orders record WHICH digital rail was used for
    // their digital portion in order._digitalMethod (see confirmPayment()) —
    // this used to be ignored here and every split payment's digital portion
    // was hardcoded into 'online', silently folding Card/Boost/T&G split
    // payments into the Online total. Fixed below.
    const byMethod = { online: 0, card: 0, boost: 0, tng: 0, cash: 0 };
    orders.forEach(o => {
        const m = o.paymentMethod;
        if (m === 'both') {
            const dm = o._digitalMethod || 'online';
            if (byMethod.hasOwnProperty(dm)) byMethod[dm] += (o.paymentOnline || 0);
            byMethod.cash += (o.paymentCash || 0);
        } else if (m === 'cash') {
            byMethod.cash += (o.paymentCash || 0);
        } else if (byMethod.hasOwnProperty(m)) {
            byMethod[m] += (o.paymentOnline || 0);
        }
    });

    const itemTotals = {};
    orders.forEach(o => {
        Object.values(o.items||{}).forEach(r => {
            if (r.qty > 0) {
                if (!itemTotals[r.name]) itemTotals[r.name] = {qty:0, revenue:0, category:r.category};
                itemTotals[r.name].qty     += r.qty;
                itemTotals[r.name].revenue += r.cost;
            }
        });
    });

    // Summary cards, row 1: Orders | Gross Sales | Discounts | Net Revenue
    const topCards = [
        {label:'Total Orders',  value: String(totalOrders)},
        {label:'Gross Sales',   value:`RM ${grossSales.toFixed(2)}`},
        {label:'Discounts Given (' + discountedOrderCount + ')', value:`-RM ${totalDiscount.toFixed(2)}`},
        {label:'Net Revenue',   value:`RM ${netRevenue.toFixed(2)}`},
    ];
    const topCardW = COL_W/4;
    topCards.forEach((c,i) => {
        const cx = MARGIN + i*topCardW;
        doc.setFillColor(...ROW_ALT); doc.setDrawColor(...BORDER);
        doc.roundedRect(cx, y, topCardW-2, 18, 2, 2, 'FD');
        doc.setFont('helvetica','bold'); doc.setFontSize(10); doc.setTextColor(...HEAD_BG);
        doc.text(c.value, cx+(topCardW-2)/2, y+10, {align:'center'});
        doc.setFont('helvetica','normal'); doc.setFontSize(6.5); doc.setTextColor(100,100,100);
        doc.text(c.label, cx+(topCardW-2)/2, y+16, {align:'center'});
    });
    y += 22;

    // Summary cards, row 2: full payment-method breakdown — Online / Card /
    // Boost / T&G / Cash, each as its own card (this is the part that was
    // missing — Card/Boost/T&G previously had no dedicated total shown here).
    checkPage(20);
    const methodCards = [
        {label:'Online', value: byMethod.online},
        {label:'Card',   value: byMethod.card},
        {label:'Boost',  value: byMethod.boost},
        {label:'T&G',    value: byMethod.tng},
        {label:'Cash',   value: byMethod.cash},
    ];
    const methodCardW = COL_W/5;
    methodCards.forEach((c,i) => {
        const cx = MARGIN + i*methodCardW;
        doc.setFillColor(232,245,233); doc.setDrawColor(...BORDER);
        doc.roundedRect(cx, y, methodCardW-2, 16, 2, 2, 'FD');
        doc.setFont('helvetica','bold'); doc.setFontSize(8.5); doc.setTextColor(...HEAD_BG);
        doc.text(`RM ${c.value.toFixed(2)}`, cx+(methodCardW-2)/2, y+9, {align:'center'});
        doc.setFont('helvetica','normal'); doc.setFontSize(7); doc.setTextColor(100,100,100);
        doc.text(c.label, cx+(methodCardW-2)/2, y+14, {align:'center'});
    });
    y += 22;

    // Items sold table
    checkPage(20);
    doc.setFont('helvetica','bold'); doc.setFontSize(11); doc.setTextColor(0);
    doc.text('Items Sold Summary', MARGIN, y); y += 5;
    const iCols = [
        {label:'Item',     x:MARGIN,       w:70, align:'left'},
        {label:'Category', x:MARGIN+70,    w:40, align:'left'},
        {label:'Qty Sold', x:MARGIN+110,   w:30, align:'right'},
        {label:'Revenue',  x:MARGIN+140,   w:38, align:'right'},
    ];
    doc.setFillColor(...HEAD_BG); doc.rect(MARGIN,y,COL_W,LINE_H+1,'F');
    doc.setTextColor(255); doc.setFontSize(9); doc.setFont('helvetica','bold');
    iCols.forEach(c => { const tx=c.align==='right'?c.x+c.w-2:c.x+2; doc.text(c.label,tx,y+LINE_H-1,{align:c.align}); });
    y += LINE_H+1;

    Object.entries(itemTotals).sort((a,b)=>b[1].revenue-a[1].revenue).forEach(([name,data],idx) => {
        checkPage(LINE_H+1);
        if (idx%2===0) { doc.setFillColor(...ROW_ALT); doc.rect(MARGIN,y,COL_W,LINE_H,'F'); }
        doc.setTextColor(0); doc.setFontSize(9); doc.setFont('helvetica','normal');
        [name, data.category, String(data.qty), `RM ${data.revenue.toFixed(2)}`].forEach((v,ci) => {
            const c=iCols[ci]; const tx=c.align==='right'?c.x+c.w-2:c.x+2;
            doc.text(v,tx,y+LINE_H-1,{align:c.align});
        });
        y += LINE_H;
    });
    doc.setFillColor(220,230,240); doc.rect(MARGIN,y,COL_W,LINE_H,'F');
    doc.setFont('helvetica','bold'); doc.setFontSize(9); doc.setTextColor(0);
    doc.text('TOTAL', MARGIN+2, y+LINE_H-1);
    doc.text(`RM ${grossSales.toFixed(2)}`, MARGIN+COL_W-2, y+LINE_H-1, {align:'right'});
    y += LINE_H+8;

    // Per-order table
    checkPage(20);
    doc.setFont('helvetica','bold'); doc.setFontSize(11); doc.setTextColor(0);
    doc.text('Order Breakdown', MARGIN, y); y += 5;
    const oCols = [
        {label:'#',        x:MARGIN,       w:10, align:'left'},
        {label:'Time',     x:MARGIN+10,    w:22, align:'left'},
        {label:'Items',    x:MARGIN+32,    w:44, align:'left'},
        {label:'Payment',  x:MARGIN+76,    w:46, align:'left'},
        {label:'Discount', x:MARGIN+122,   w:26, align:'right'},
        {label:'Total',    x:MARGIN+148,   w:30, align:'right'},
    ];
    doc.setFillColor(...HEAD_BG); doc.rect(MARGIN,y,COL_W,LINE_H+1,'F');
    doc.setTextColor(255); doc.setFontSize(8); doc.setFont('helvetica','bold');
    oCols.forEach(c => { const tx=c.align==='right'?c.x+c.w-2:c.x+2; doc.text(c.label,tx,y+LINE_H-1,{align:c.align}); });
    y += LINE_H+1;

    orders.sort((a,b)=>a.createdAt-b.createdAt).forEach((order,idx) => {
        const itemSummary = Object.values(order.items||{}).filter(r=>r.qty>0).map(r=>r.name + ' x' + r.qty).join(', ');
        const timeStr     = new Date(order.createdAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
        const _PM = order.paymentMethod || '';
        const _MN = { online:'Online', card:'Card', boost:'Boost', tng:'T&G' };
        let payStr = '';
        if (['online','card','boost','tng'].includes(_PM)) payStr = (_MN[_PM]||_PM) + ' RM' + (order.paymentOnline||0).toFixed(2);
        else if (_PM==='cash') payStr = 'Cash RM' + (order.paymentCash||0).toFixed(2);
        else if (_PM==='both') {
            const dm = order._digitalMethod || 'online';
            payStr = (_MN[dm]||dm) + ':RM' + (order.paymentOnline||0).toFixed(2) + ' C:RM' + (order.paymentCash||0).toFixed(2);
        }
        const discAmt = order.discountAmount || 0;
        const discStr = discAmt > 0 ? '-RM' + discAmt.toFixed(2) : '-';

        const wrappedItems = doc.splitTextToSize(itemSummary, oCols[2].w - 2);
        const rowH = Math.max(LINE_H, wrappedItems.length*4+3);
        checkPage(rowH+1);
        if (idx%2===0) { doc.setFillColor(...ROW_ALT); doc.rect(MARGIN,y,COL_W,rowH,'F'); }
        doc.setTextColor(0); doc.setFontSize(8); doc.setFont('helvetica','normal');
        doc.text(`#${order.id}`,  oCols[0].x+2, y+5);
        doc.text(timeStr,         oCols[1].x+2, y+5);
        doc.text(wrappedItems,    oCols[2].x+2, y+5);
        doc.text(payStr,          oCols[3].x+2, y+5);
        if (discAmt > 0) doc.setTextColor(200,60,60);
        doc.text(discStr, oCols[4].x+oCols[4].w-2, y+5, {align:'right'});
        doc.setTextColor(0);
        doc.text(`RM ${orderFinalTotal(order).toFixed(2)}`, oCols[5].x+oCols[5].w-2, y+5, {align:'right'});
        y += rowH;
    });

    // Footer
    for (let i=1; i<=doc.getNumberOfPages(); i++) {
        doc.setPage(i); doc.setFontSize(8); doc.setTextColor(150);
        doc.text(`${localStorage.getItem('shmBusinessName')||APP_CONFIG.APP_NAME} - ${subtitle}`, MARGIN, 290);
        doc.text(`Page ${i} of ${doc.getNumberOfPages()}`, PAGE_W-MARGIN, 290, {align:'right'});
    }
    doc.save(`SHM_${subtitle.replace(/[^a-zA-Z0-9]/g,'_')}.pdf`);
}

// ─── Paste-to-parse ───────────────────────────────────────────────────────────
async function parseOrderMessage() {
    const input  = document.getElementById('pasteOrderInput');
    const status = document.getElementById('parseStatus');
    const msg    = input.value.trim();
    if (!msg) { status.textContent = '⚠️ Paste a message first.'; return; }
    status.textContent = '⏳ Parsing...';
    const descBox = document.getElementById('orderDescription');
    if (descBox) descBox.value = msg;
    const result = _parseMessageLocally(msg);
    const filled = _applyParsedOrder(result);
    if (filled > 0) {
        status.textContent = `✅ Filled ${filled} item${filled>1?'s':''}`;
        reviewOrder();
        // Highlight flash moved to the button (the field it used to live on is
        // now hidden), cleared after 3s the same as before.
        setTimeout(() => { getMenuItems().forEach(item => { const btn=document.getElementById(`menu-item-btn-${item.id}`); if(btn) btn.style.background=''; }); }, 3000);
    } else {
        status.textContent = '⚠️ No items recognised. Fill in manually.';
    }
}

function _parseMessageLocally(msg) {
    const result={}, lower=msg.toLowerCase();
    getMenuItems().forEach(item => {
        const variants = _getNameVariants(item);
        variants.forEach(variant => {
            if (result[item.id]) return;
            const esc = variant.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
            const pats = [new RegExp(`(\\d+)\\s*[x×]?\\s*${esc}`,'i'), new RegExp(`${esc}\\s*[x×]?\\s*(\\d+)`,'i')];
            for (const pat of pats) {
                const match = lower.match(pat);
                if (match) { const qty=parseInt(match[1]); if(qty>0){result[item.id]=qty;break;} }
            }
        });
    });
    return result;
}

function _getNameVariants(item) {
    const name=item.name.toLowerCase(), id=item.id.toLowerCase();
    const variants=new Set([name,id]);
    const aliases={'ayam':['ayam','chicken','ciken','chiken'],'daging':['daging','beef','lembu'],
        'kambing':['kambing','lamb','mutton'],'lontong':['lontong','nasi impit'],
        'shortong':['shortong','sotong','ketupat'],'kuah':['kuah','kuah kacang','sos kacang','peanut sauce','extra kuah']};
    if (aliases[id]) aliases[id].forEach(a=>variants.add(a));
    name.split(/\s+/).forEach(w=>{if(w.length>3)variants.add(w);});
    return [...variants];
}

function _applyParsedOrder(parsed) {
    let filled=0;
    getMenuItems().forEach(item => {
        const el=document.getElementById(`qty-${item.id}`); if(!el) return;
        const qty=parsed[item.id];
        if(qty&&qty>0){
            el.value=qty;
            if (typeof checkStockInput === 'function') checkStockInput(item.id, qty);
            if (typeof refreshMenuItemButton === 'function') refreshMenuItemButton(item.id);
            const btn=document.getElementById(`menu-item-btn-${item.id}`);
            if (btn) btn.style.background='#e8f5e9';
            filled++;
        }
    });
    return filled;
}

// ─── Block / unblock customers (abuse prevention) ──────────────────────────────
// place_customer_order() stamps orderIp + deviceId onto each customer-placed
// order (see supabase/migrations/customer_blocklist.sql). Blocking checks
// phone / device / IP against the blocked_customers table before an order
// is accepted — see that migration file for the tradeoffs of each signal.
async function adminRpc(fn, body) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
        method: 'POST',
        headers: {
            'apikey':        SUPABASE_ANON_KEY,
            'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
            'Content-Type':  'application/json'
        },
        body: JSON.stringify(body || {})
    });
    if (!res.ok) throw new Error(await res.text());
    const t = await res.text();
    return t ? JSON.parse(t) : null;
}

async function openBlockModal(orderId) {
    const all   = await getAllOrders();
    const order = all.find(o => o.id === orderId);
    if (!order) return;

    const options = [];
    if (order.customerPhone) options.push({ type: 'phone',  value: order.customerPhone, label: `📞 Phone — ${order.customerPhone}` });
    if (order.deviceId)      options.push({ type: 'device', value: order.deviceId,      label: `📱 This device (browser)` });
    if (order.orderIp)       options.push({ type: 'ip',     value: order.orderIp,       label: `🌐 IP address — ${order.orderIp}` });

    const box = document.getElementById('blockCustomerOptions');
    if (box) {
        box.innerHTML = options.length
            ? options.map((opt, i) => `
                <label style="display:flex;align-items:center;gap:8px;font-size:13px;">
                    <input type="checkbox" class="block-opt" data-type="${opt.type}" data-value="${escapeHtml(opt.value)}" ${i === 0 ? 'checked' : ''}>
                    ${opt.label}
                </label>`).join('')
            : '<p style="font-size:13px;color:#999;">This order has no phone, device, or IP info to block (older order, placed before this feature).</p>';
    }

    const status = document.getElementById('blockStatusMsg');
    if (status) status.textContent = '';
    const reasonInput = document.getElementById('blockReasonInput');
    if (reasonInput) reasonInput.value = '';

    showModalById('blockCustomerModal');
}

function closeBlockModal() {
    hideModalById('blockCustomerModal');
}

async function submitBlockCustomer() {
    const checked = Array.from(document.querySelectorAll('.block-opt:checked'));
    const status  = document.getElementById('blockStatusMsg');
    if (checked.length === 0) {
        if (status) { status.style.color = '#dc3545'; status.textContent = 'Select at least one thing to block.'; }
        return;
    }

    const reason = (document.getElementById('blockReasonInput') || {}).value || '';
    if (status) { status.style.color = '#6c757d'; status.textContent = '⏳ Blocking...'; }

    try {
        for (const el of checked) {
            await adminRpc('block_customer', { p_type: el.dataset.type, p_value: el.dataset.value, p_reason: reason.trim() || null });
        }
        if (status) { status.style.color = '#28a745'; status.textContent = '✅ Blocked.'; }
        setTimeout(closeBlockModal, 900);
        if (typeof loadBlockedList === 'function') loadBlockedList();
    } catch (e) {
        if (status) { status.style.color = '#dc3545'; status.textContent = '❌ Failed: ' + e.message; }
    }
}

async function loadBlockedList() {
    const box = document.getElementById('blockedListBox');
    if (box) box.innerHTML = '<p style="text-align:center;color:#999;font-size:13px;">Loading...</p>';
    try {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/blocked_customers?select=*&order=blocked_at.desc`, {
            headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY }
        });
        if (!res.ok) throw new Error(await res.text());
        renderBlockedList(await res.json());
    } catch (e) {
        if (box) box.innerHTML = `<p style="color:#dc3545;font-size:13px;">Couldn't load blocked list: ${escapeHtml(e.message)}</p>`;
    }
}

function renderBlockedList(rows) {
    const box = document.getElementById('blockedListBox');
    if (!box) return;
    if (!rows || rows.length === 0) {
        box.innerHTML = '<p style="text-align:center;color:#999;font-size:13px;">No one is blocked right now.</p>';
        return;
    }
    const typeIcon  = { phone: '📞', ip: '🌐', device: '📱' };
    const typeLabel = { phone: 'Phone', ip: 'IP address', device: 'Device' };
    box.innerHTML = rows.map(r => `
        <div class="menu-row" style="align-items:center;">
            <div style="flex:1;min-width:0;">
                <div style="font-size:13px;font-weight:600;">${typeIcon[r.type] || ''} ${typeLabel[r.type] || r.type} — ${escapeHtml(r.value)}</div>
                ${r.reason ? `<div style="font-size:12px;color:#888;">${escapeHtml(r.reason)}</div>` : ''}
                <div style="font-size:11px;color:#aaa;">Blocked ${new Date(r.blocked_at).toLocaleString()}</div>
            </div>
            <button class="small delete-btn" style="margin:0;flex-shrink:0;"
                onclick='unblockCustomer(${JSON.stringify(r.type)}, ${JSON.stringify(r.value)})'>Unblock</button>
        </div>
    `).join('');
}

async function unblockCustomer(type, value) {
    if (!confirm('Unblock this? They will be able to order again.')) return;
    try {
        await adminRpc('unblock_customer', { p_type: type, p_value: value });
        loadBlockedList();
    } catch (e) {
        alert('❌ Failed to unblock: ' + e.message);
    }
}

async function addManualBlock() {
    const typeSel     = document.getElementById('manualBlockType');
    const valueInput  = document.getElementById('manualBlockValue');
    const reasonInput = document.getElementById('manualBlockReason');
    const value = (valueInput.value || '').trim();
    if (!value) { alert('Enter a value to block.'); return; }

    try {
        await adminRpc('block_customer', { p_type: typeSel.value, p_value: value, p_reason: (reasonInput.value || '').trim() || null });
        valueInput.value  = '';
        reasonInput.value = '';
        loadBlockedList();
    } catch (e) {
        alert('❌ Failed to block: ' + e.message);
    }
}
