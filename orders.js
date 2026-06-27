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
    return order;
}

// ---------- Home: menu inputs ----------
function renderHomeMenuInputs() {
    const container = document.getElementById('menuInputs');
    if (!container) return;
    container.innerHTML = getMenuItems().map(item => `
        <label id="label-${item.id}">${escapeHtml(item.name)} (RM${item.price.toFixed(2)})</label>
        <input type="number" id="qty-${item.id}" min="0" step="1" placeholder="0">
    `).join('');
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
    getMenuItems().forEach(item => {
        const qty  = quantities[item.id] || 0;
        const cost = qty * item.price;
        items[item.id] = { name:item.name, category:item.category, price:item.price, qty, cost };
        totalCost += cost;
        if      (item.category === 'skewer')    { skewerQty += qty; skewerWithKuah += qty; }
        else if (item.category === 'no-kuah')   { skewerQty += qty; }
        else if (item.category === 'side')      { scoops += qty * 2; }
        else if (item.category === 'kuah-only') { scoops += qty * 1; }
    });
    if (skewerWithKuah > 0) scoops += Math.ceil(skewerWithKuah / 10);
    return { items, totalCost, skewerQty, scoops };
}

function renderResultsGrid(totals) {
    const grid = document.getElementById('resultsGrid');
    if (!grid) return;
    let html = '';
    Object.values(totals.items).forEach(r => {
        html += `<div class="result-item"><span class="label">${escapeHtml(r.name)}<br></span><span class="value">RM${r.cost.toFixed(2)}</span></div>`;
    });
    html += `<div class="result-item"><span class="label">Jumlah Cucuk<br></span><span class="value">${totals.skewerQty}</span></div>`;
    html += `<div class="result-item"><span class="label">Jumlah Kuah Kacang<br></span><span class="value">${totals.scoops}</span></div>`;
    html += `<div class="result-item ice-cream" style="grid-column:span 2;"><span class="label">Jumlah RM<br></span><span class="value">RM${totals.totalCost.toFixed(2)}</span></div>`;
    grid.innerHTML = html;
}

function clearForm() {
    getMenuItems().forEach(item => {
        const el = document.getElementById(`qty-${item.id}`);
        if (el) el.value = 0;
    });
    document.getElementById('orderDescription').value = '';
    document.getElementById('results').style.display = 'none';
}

function calculate() {
    const totals = calculateTotals(getQuantitiesFromHome());
    renderResultsGrid(totals);
    document.getElementById('results').style.display = 'block';
}

async function saveOrder() {
    const quantities = getQuantitiesFromHome();
    const hasAny = Object.values(quantities).some(q => q > 0);
    if (!hasAny) { alert('Please enter at least one item.'); return; }

    const totals      = calculateTotals(quantities);
    const description = document.getElementById('orderDescription').value.trim() || '';
    const order = {
        items: totals.items,
        totalCost: totals.totalCost,
        skewerQty: totals.skewerQty,
        scoops: totals.scoops,
        prepared: false,
        paid: false,
        pickedUp: false,
        description,
        paymentMethod: null,
        paymentOnline: 0,
        paymentCash: 0,
        createdAt: Date.now()
    };
    try {
        await addOrder(order);
        clearForm();
        switchTab('orders');
        switchOrderSubTab('prepare');
    } catch (e) {
        alert('❌ Failed to save order: ' + e.message);
    }
}

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

    if (subtab === 'done') _populateDoneDateFilter().then(() => loadOrders());
    else loadOrders();
}

async function loadOrders() {
    try {
        const orders  = (await getAllOrders()).map(normalizeOrder);
        const sortDir = document.getElementById('sortOrders').value;
        orders.sort((a,b) => sortDir==='asc' ? a.createdAt-b.createdAt : b.createdAt-a.createdAt);

        // Stage buckets
        // prepare  = not prepared, not paid
        // prepared = prepared but not paid
        // paid     = paid but not pickedUp
        // done     = paid + pickedUp
        const prepare  = orders.filter(o => !o.prepared && !o.paid);
        const prepared = orders.filter(o =>  o.prepared && !o.paid);
        const paid     = orders.filter(o =>  o.paid     && !o.pickedUp);
        let   done     = orders.filter(o =>  o.paid     &&  o.pickedUp);

        const dateFilter = document.getElementById('doneDateFilter');
        if (dateFilter && dateFilter.value && dateFilter.value !== 'all') {
            const target = dateFilter.value === 'today'
                ? new Date().toLocaleDateString('en-CA')
                : dateFilter.value;
            done = done.filter(o => new Date(o.createdAt).toLocaleDateString('en-CA') === target);
        }

        renderOrderList('prepareList',  prepare,  'prepare');
        renderOrderList('preparedList', prepared, 'prepared');
        renderOrderList('paidList',     paid,     'paid');
        renderOrderList('doneList',     done,     'done');
    } catch (e) {
        alert('❌ Failed to load orders: ' + e.message);
    }
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
            const card = document.createElement('div');
            card.className = 'order-card';
            card.id = `order-${order.id}`;
            renderOrderCard(card, order, stage);
            dayDiv.appendChild(card);
        });
        container.appendChild(dayDiv);
    }
}

// ---------- Payment display helper ----------
function paymentBadgeHTML(order) {
    const m = order.paymentMethod;
    if (!m) return '';
    if (m === 'online') return `<div class="payment-badge badge-online">💳 Online — RM${(order.paymentOnline||0).toFixed(2)}</div>`;
    if (m === 'cash')   return `<div class="payment-badge badge-cash">💵 Cash — RM${(order.paymentCash||0).toFixed(2)}</div>`;
    if (m === 'both')   return `
        <div class="payment-badge badge-both">
            💳 Online: RM${(order.paymentOnline||0).toFixed(2)} &nbsp;|&nbsp; 💵 Cash: RM${(order.paymentCash||0).toFixed(2)}
        </div>`;
    return '';
}

// ---------- Render card ----------
function renderOrderCard(card, rawOrder, stage) {
    const o = normalizeOrder(rawOrder);

    const header = `
        <div class="order-header">
            <span class="order-id">#${o.id}</span>
            <span class="order-date">${formatDate(o.createdAt)}</span>
        </div>`;

    const itemBadges = Object.values(o.items)
        .filter(r => r.qty > 0)
        .map(r => `<div class="detail-badge">${escapeHtml(r.name)} (${r.qty})<br>RM${r.cost.toFixed(2)}</div>`)
        .join('');

    const statsBadges = `
        <div class="detail-badge">Cucuk: ${o.skewerQty}</div>
        <div class="detail-badge">${o.scoops} Senduk</div>
        <div class="detail-badge ice-cream" style="grid-column:span 2;">RM ${o.totalCost.toFixed(2)}</div>`;

    const editableDesc = `<div class="order-description" id="desc-${o.id}" contenteditable="true"
        onblur="updateDescription(${o.id}, this.innerText)">${escapeHtml(o.description)}</div>`;

    const readonlyDesc = o.description
        ? `<div class="order-description" style="cursor:default;">${escapeHtml(o.description)}</div>` : '';

    // ── Edit mode (shared between prepare & prepared) ─────────────────────
    if (stage === 'prepare-edit' || stage === 'prepared-edit') {
        const returnStage = stage === 'prepare-edit' ? 'prepare' : 'prepared';
        const editInputs  = getMenuItems().map(item => {
            const qty = (o.items[item.id] && o.items[item.id].qty) || 0;
            return `<div><label>${escapeHtml(item.name)}</label>
                <input type="number" id="edit-${item.id}-${o.id}" class="edit-input"
                    value="${qty}" min="0" step="1" oninput="updateEditTotals(${o.id})"></div>`;
        }).join('');
        card.innerHTML = `
            ${header}
            <div class="order-details" id="edit-details-${o.id}">
                ${editInputs}
                <div class="detail-badge" id="edit-skewerQty-${o.id}">Cucuk: ${o.skewerQty}</div>
                <div class="detail-badge" id="edit-scoops-${o.id}">${o.scoops} Senduk</div>
                <div class="detail-badge ice-cream" style="grid-column:span 2;" id="edit-totalCost-${o.id}">RM${o.totalCost.toFixed(2)}</div>
            </div>
            ${editableDesc}
            <div class="action-buttons">
                <button class="save-btn"   onclick="saveEdit(${o.id}, '${returnStage}')">💾 Save</button>
                <button class="cancel-btn" onclick="cancelEditTo(${o.id}, '${returnStage}')">✖ Cancel</button>
            </div>`;
        return;
    }

    // ── Prepare ───────────────────────────────────────────────────────────
    if (stage === 'prepare') {
        const hasPayment = !!o.paymentMethod;
        const payBadge   = hasPayment
            ? `<div style="margin:8px 0;">${paymentBadgeHTML(o)}</div>` : '';
        const markPaidBtn = hasPayment
            ? `<button class="status-btn paid" onclick="markPaidDirect(${o.id})">✅ Mark as Paid</button>` : '';

        card.innerHTML = `
            ${header}
            <div class="order-details">${itemBadges}${statsBadges}</div>
            ${editableDesc}
            ${payBadge}
            <div class="action-buttons">
                <button class="delete-btn" onclick="deleteOrderConfirm(${o.id})">🗑️ Cancel</button>
                <button class="edit-btn"   onclick="startEditTo(${o.id}, 'prepare')">✏️ Edit</button>
                <button class="pay-method-btn" onclick="openPaymentModal(${o.id}, ${o.totalCost}, 'prepare')">💳 Payment</button>
            </div>
            ${markPaidBtn}
            <button class="status-btn done-btn" onclick="markPrepared(${o.id})" style="margin-top:8px;">✅ Done</button>`;
        return;
    }

    // ── Prepared ──────────────────────────────────────────────────────────
    if (stage === 'prepared') {
        const hasPayment = !!o.paymentMethod;
        const payBadge   = hasPayment
            ? `<div style="margin:8px 0;">${paymentBadgeHTML(o)}</div>` : '';

        card.innerHTML = `
            ${header}
            <div class="order-details">${itemBadges}${statsBadges}</div>
            <div class="status-row"><span class="status-mark mark-prepared">🍢 Prepared</span></div>
            ${editableDesc}
            ${payBadge}
            <div class="action-buttons">
                <button class="delete-btn" onclick="deleteOrderConfirm(${o.id})">🗑️ Cancel</button>
                <button class="edit-btn"   onclick="startEditTo(${o.id}, 'prepared')">✏️ Edit</button>
                <button class="pay-method-btn" onclick="openPaymentModal(${o.id}, ${o.totalCost}, 'prepared')">💳 Payment</button>
            </div>
            <button class="status-btn paid" onclick="markPaid(${o.id})" style="margin-top:8px;">✅ Mark as Paid</button>`;
        return;
    }

    // ── Paid ──────────────────────────────────────────────────────────────
    if (stage === 'paid') {
        card.innerHTML = `
            ${header}
            <div class="order-details">${itemBadges}${statsBadges}</div>
            <div class="status-row"><span class="status-mark mark-paid">✅ Paid</span></div>
            <div style="margin:8px 0;">${paymentBadgeHTML(o)}</div>
            ${readonlyDesc}
            <div class="action-buttons">
                <button class="edit-btn"      onclick="undoToPrepared(${o.id})">↩️ Undo</button>
                <button class="status-btn picked" onclick="markPickedUp(${o.id})">📦 Picked Up</button>
            </div>`;
        return;
    }

    // ── Done ──────────────────────────────────────────────────────────────
    if (stage === 'done') {
        card.innerHTML = `
            ${header}
            <div class="order-details">${itemBadges}${statsBadges}</div>
            <div class="status-row">
                <span class="status-mark mark-paid">✅ Paid</span>
                <span class="status-mark mark-picked">📦 Picked Up</span>
            </div>
            <div style="margin:8px 0;">${paymentBadgeHTML(o)}</div>
            ${readonlyDesc}
            <div class="action-buttons">
                <button class="delete-btn" onclick="deleteOrderConfirm(${o.id})">🗑️ Delete</button>
                <button class="print-btn"  onclick="printOrder(${o.id})">🖨️ Print</button>
            </div>`;
        return;
    }
}

// ---------- Edit helpers ----------
function startEditTo(id, fromStage) {
    const card = document.getElementById(`order-${id}`);
    if (!card) return;
    getAllOrders().then(orders => {
        const o = orders.find(o => o.id === id);
        if (o) renderOrderCard(card, o, fromStage + '-edit');
    });
}
function cancelEditTo(id, returnStage) {
    const card = document.getElementById(`order-${id}`);
    if (!card) return;
    getAllOrders().then(orders => {
        const o = orders.find(o => o.id === id);
        if (o) renderOrderCard(card, o, returnStage);
    });
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
    document.getElementById(`edit-totalCost-${id}`).innerText = `RM${t.totalCost.toFixed(2)}`;
    document.getElementById(`edit-scoops-${id}`).innerText    = `${t.scoops} Senduk`;
}
async function saveEdit(id, returnStage = 'prepare') {
    const totals      = calculateTotals(getEditQuantities(id));
    const description = document.getElementById(`desc-${id}`).innerText.trim() || '';
    const all         = await getAllOrders();
    const existing    = all.find(o => o.id === id);
    if (!existing) return;
    const updated = { ...existing, items:totals.items, totalCost:totals.totalCost,
        skewerQty:totals.skewerQty, scoops:totals.scoops, description };
    ['ayam','daging','lontong','shortong'].forEach(k => {
        delete updated[k]; delete updated[k+'Cost'];
    });
    delete updated.ayamDagingQty;
    await updateOrder(updated);
    const card = document.getElementById(`order-${id}`);
    renderOrderCard(card, updated, returnStage);
}
async function updateDescription(id, newText) {
    const all   = await getAllOrders();
    const order = all.find(o => o.id === id);
    if (order) { order.description = newText.trim() || ''; await updateOrder(order); }
}

// ---------- Stage transitions ----------

// Prepare → Prepared (no payment yet)
async function markPrepared(id) {
    const all   = await getAllOrders();
    const order = all.find(o => o.id === id);
    if (order) { order.prepared = true; await updateOrder(order); loadOrders(); }
}

// Prepare → Paid directly (payment already set)
async function markPaidDirect(id) {
    const all   = await getAllOrders();
    const order = all.find(o => o.id === id);
    if (!order || !order.paymentMethod) return;
    order.prepared = true;
    order.paid     = true;
    await updateOrder(order);
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
    if (confirm('Delete this order?')) { await deleteOrder(id); loadOrders(); }
}

// ---------- Payment Modal ----------
let _pmOrderId = null;
let _pmTotal   = 0;
let _pmReturnStage = 'prepare';

function openPaymentModal(orderId, total, returnStage) {
    _pmOrderId     = orderId;
    _pmTotal       = total;
    _pmReturnStage = returnStage;

    getAllOrders().then(all => {
        const order  = all.find(o => o.id === orderId);
        const method = (order && order.paymentMethod) || 'online';
        document.querySelectorAll('input[name="payMethod"]').forEach(r => r.checked = r.value === method);
        _renderPayInputs(method, order);
        document.getElementById('paymentModal').style.display = 'flex';
    });
}

function closePaymentModal() {
    document.getElementById('paymentModal').style.display = 'none';
}

function onPayMethodChange(el) {
    _renderPayInputs(el.value, null);
}

function _renderPayInputs(method, existingOrder) {
    const box   = document.getElementById('paymentInputsBox');
    const total = _pmTotal;

    if (method === 'online') {
        const val = (existingOrder && existingOrder.paymentMethod === 'online')
            ? existingOrder.paymentOnline : total;
        box.innerHTML =
            '<label class="pay-label">💳 Online Amount (RM)</label>' +
            '<input type="number" id="payOnlineInput" step="0.01" min="0" class="pay-input">';
        document.getElementById('payOnlineInput').value = val.toFixed(2);

    } else if (method === 'cash') {
        const val = (existingOrder && existingOrder.paymentMethod === 'cash')
            ? existingOrder.paymentCash : total;
        box.innerHTML =
            '<div class="pay-total-hint">Bill total: <strong>RM' + total.toFixed(2) + '</strong></div>' +
            '<label class="pay-label">💵 Cash Amount (RM)</label>' +
            '<input type="number" id="payCashInput" step="0.01" min="0" class="pay-input">' +
            '<label class="pay-label" style="margin-top:12px;">💴 Cash Given by Customer (RM)</label>' +
            '<input type="number" id="cashGivenInput" step="0.01" min="0" class="pay-input" placeholder="e.g. 20.00">' +
            '<div id="changeDisplay" class="change-display" style="display:none;"></div>';
        document.getElementById('payCashInput').value = val.toFixed(2);

        // Attach change calculator listeners
        function calcChange() {
            const bill    = parseFloat(document.getElementById('payCashInput').value)  || 0;
            const given   = parseFloat(document.getElementById('cashGivenInput').value) || 0;
            const display = document.getElementById('changeDisplay');
            if (given <= 0) { display.style.display = 'none'; return; }
            const change  = given - bill;
            display.style.display = 'block';
            if (change < 0) {
                display.className = 'change-display change-short';
                display.innerHTML = '&#9888; Short by <strong>RM' + Math.abs(change).toFixed(2) + '</strong> — not enough!';
            } else {
                display.className = 'change-display change-ok';
                display.innerHTML = 'Change: <strong>RM' + change.toFixed(2) + '</strong>';
            }
        }
        document.getElementById('payCashInput').addEventListener('input', calcChange);
        document.getElementById('cashGivenInput').addEventListener('input', calcChange);

    } else { // both
        const oVal = (existingOrder && existingOrder.paymentMethod === 'both') ? existingOrder.paymentOnline : 0;
        const cVal = (existingOrder && existingOrder.paymentMethod === 'both') ? existingOrder.paymentCash   : 0;
        box.innerHTML =
            '<div class="pay-total-hint">Total: <strong>RM' + total.toFixed(2) + '</strong> — type one amount, the other fills automatically.</div>' +
            '<label class="pay-label">💳 Online Amount (RM)</label>' +
            '<input type="number" id="payOnlineInput" step="0.01" min="0" class="pay-input">' +
            '<label class="pay-label" style="margin-top:12px;">💵 Cash Amount (RM)</label>' +
            '<input type="number" id="payCashInput" step="0.01" min="0" class="pay-input">' +
            '<label class="pay-label" style="margin-top:12px;">💴 Cash Given by Customer (RM)</label>' +
            '<input type="number" id="cashGivenBothInput" step="0.01" min="0" class="pay-input" placeholder="e.g. 20.00">' +
            '<div id="changeDisplayBoth" class="change-display" style="display:none;"></div>';
        document.getElementById('payOnlineInput').value = oVal.toFixed(2);
        document.getElementById('payCashInput').value   = cVal.toFixed(2);
        // Attach autofill listeners after elements exist in DOM
        document.getElementById('payOnlineInput').addEventListener('input', function() {
            const online = parseFloat(this.value) || 0;
            document.getElementById('payCashInput').value = Math.max(0, _pmTotal - online).toFixed(2);
            calcChangeBoth();
        });
        document.getElementById('payCashInput').addEventListener('input', function() {
            const cash = parseFloat(this.value) || 0;
            document.getElementById('payOnlineInput').value = Math.max(0, _pmTotal - cash).toFixed(2);
            calcChangeBoth();
        });
        document.getElementById('cashGivenBothInput').addEventListener('input', calcChangeBoth);

        function calcChangeBoth() {
            const cashPart = parseFloat(document.getElementById('payCashInput').value)       || 0;
            const given    = parseFloat(document.getElementById('cashGivenBothInput').value) || 0;
            const display  = document.getElementById('changeDisplayBoth');
            if (given <= 0) { display.style.display = 'none'; return; }
            const change   = given - cashPart;
            display.style.display = 'block';
            if (change < 0) {
                display.className = 'change-display change-short';
                display.innerHTML = '&#9888; Short by <strong>RM' + Math.abs(change).toFixed(2) + '</strong> — not enough!';
            } else {
                display.className = 'change-display change-ok';
                display.innerHTML = 'Change: <strong>RM' + change.toFixed(2) + '</strong>';
            }
        }
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

    if (method === 'both') {
        const sum = onlineAmt + cashAmt;
        if (Math.abs(sum - _pmTotal) > 0.01) {
            if (!confirm(`⚠️ Total entered (RM${sum.toFixed(2)}) doesn't match order total (RM${_pmTotal.toFixed(2)}). Save anyway?`)) return;
        }
    }

    const all   = await getAllOrders();
    const order = all.find(o => o.id === _pmOrderId);
    if (!order) return;

    order.paymentMethod = method;
    order.paymentOnline = (method === 'cash')   ? 0 : onlineAmt;
    order.paymentCash   = (method === 'online') ? 0 : cashAmt;

    await updateOrder(order);
    closePaymentModal();
    loadOrders();
}

// ─── Done tab date filter ─────────────────────────────────────────────────────
async function _populateDoneDateFilter() {
    const sel = document.getElementById('doneDateFilter');
    if (!sel) return;
    const orders = (await getAllOrders()).map(normalizeOrder);
    const done   = orders.filter(o => o.paid && o.pickedUp);
    const dateSet = new Set();
    done.forEach(o => dateSet.add(new Date(o.createdAt).toLocaleDateString('en-CA')));
    const today = new Date().toLocaleDateString('en-CA');
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
    const modal = document.getElementById('reportModal');
    if (!modal) return;
    document.getElementById('reportDate').value  = new Date().toLocaleDateString('en-CA');
    document.getElementById('reportMonth').value = new Date().toLocaleDateString('en-CA').substring(0,7);
    updateReportDateUI();
    modal.style.display = 'flex';
}
function closeReportModal() {
    const modal = document.getElementById('reportModal');
    if (modal) modal.style.display = 'none';
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
        filtered = done.filter(o => new Date(o.createdAt).toLocaleDateString('en-CA') === date);
        subtitle = new Date(date+'T00:00:00').toLocaleDateString(undefined, { weekday:'long', year:'numeric', month:'long', day:'numeric' });
        title    = 'DAILY SALES REPORT';
    } else if (type === 'month') {
        const month = document.getElementById('reportMonth').value;
        if (!month) { alert('Please select a month.'); return; }
        filtered = done.filter(o => new Date(o.createdAt).toLocaleDateString('en-CA').substring(0,7) === month);
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
    doc.text('SATE HUJUNG MINGGU', PAGE_W/2, 13, {align:'center'});
    doc.setFontSize(13); doc.setFont('helvetica','normal');
    doc.text(title, PAGE_W/2, 21, {align:'center'});
    doc.setFontSize(10);
    doc.text(subtitle, PAGE_W/2, 28, {align:'center'});
    doc.text(`Generated: ${new Date().toLocaleString()}`, PAGE_W/2, 34, {align:'center'});
    y = 44; doc.setTextColor(0,0,0);

    // Totals
    const totalRevenue = orders.reduce((s,o) => s+(o.totalCost||0), 0);
    const totalOnline  = orders.reduce((s,o) => s+(o.paymentOnline||0), 0);
    const totalCash    = orders.reduce((s,o) => s+(o.paymentCash||0), 0);
    const totalOrders  = orders.length;

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

    // Summary cards (4): Orders | Revenue | Online | Cash
    const cards = [
        {label:'Total Orders',  value: String(totalOrders)},
        {label:'Total Revenue', value:`RM ${totalRevenue.toFixed(2)}`},
        {label:'Online Total',  value:`RM ${totalOnline.toFixed(2)}`},
        {label:'Cash Total',    value:`RM ${totalCash.toFixed(2)}`},
    ];
    const cardW = COL_W/4;
    cards.forEach((c,i) => {
        const cx = MARGIN + i*cardW;
        doc.setFillColor(...ROW_ALT); doc.setDrawColor(...BORDER);
        doc.roundedRect(cx, y, cardW-2, 18, 2, 2, 'FD');
        doc.setFont('helvetica','bold'); doc.setFontSize(10); doc.setTextColor(...HEAD_BG);
        doc.text(c.value, cx+(cardW-2)/2, y+10, {align:'center'});
        doc.setFont('helvetica','normal'); doc.setFontSize(7); doc.setTextColor(100,100,100);
        doc.text(c.label, cx+(cardW-2)/2, y+16, {align:'center'});
    });
    y += 24;

    // Payment breakdown bar
    checkPage(14);
    doc.setFillColor(232,245,233); doc.setDrawColor(...BORDER);
    doc.roundedRect(MARGIN, y, COL_W, 12, 2, 2, 'FD');
    doc.setFont('helvetica','bold'); doc.setFontSize(9); doc.setTextColor(0);
    doc.text('Payment Breakdown:', MARGIN+2, y+8);
    doc.setFont('helvetica','normal');
    doc.text(`Online: RM ${totalOnline.toFixed(2)}`, MARGIN+52, y+8);
    doc.text(`Cash: RM ${totalCash.toFixed(2)}`, MARGIN+115, y+8);
    y += 18;

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
    doc.text(`RM ${totalRevenue.toFixed(2)}`, MARGIN+COL_W-2, y+LINE_H-1, {align:'right'});
    y += LINE_H+8;

    // Per-order table
    checkPage(20);
    doc.setFont('helvetica','bold'); doc.setFontSize(11); doc.setTextColor(0);
    doc.text('Order Breakdown', MARGIN, y); y += 5;
    const oCols = [
        {label:'#',       x:MARGIN,       w:12, align:'left'},
        {label:'Time',    x:MARGIN+12,    w:28, align:'left'},
        {label:'Items',   x:MARGIN+40,    w:60, align:'left'},
        {label:'Payment', x:MARGIN+100,   w:58, align:'left'},
        {label:'Total',   x:MARGIN+158,   w:20, align:'right'},
    ];
    doc.setFillColor(...HEAD_BG); doc.rect(MARGIN,y,COL_W,LINE_H+1,'F');
    doc.setTextColor(255); doc.setFontSize(8); doc.setFont('helvetica','bold');
    oCols.forEach(c => { const tx=c.align==='right'?c.x+c.w-2:c.x+2; doc.text(c.label,tx,y+LINE_H-1,{align:c.align}); });
    y += LINE_H+1;

    orders.sort((a,b)=>a.createdAt-b.createdAt).forEach((order,idx) => {
        const itemSummary = Object.values(order.items||{}).filter(r=>r.qty>0).map(r=>r.name + ' x' + r.qty).join(', ');
        const timeStr     = new Date(order.createdAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
        let payStr = '';
        if (order.paymentMethod==='online') payStr = `Online RM${(order.paymentOnline||0).toFixed(2)}`;
        else if (order.paymentMethod==='cash') payStr = `Cash RM${(order.paymentCash||0).toFixed(2)}`;
        else if (order.paymentMethod==='both') payStr = `O:RM${(order.paymentOnline||0).toFixed(2)} + C:RM${(order.paymentCash||0).toFixed(2)}`;

        const wrappedItems = doc.splitTextToSize(itemSummary, 58);
        const rowH = Math.max(LINE_H, wrappedItems.length*4+3);
        checkPage(rowH+1);
        if (idx%2===0) { doc.setFillColor(...ROW_ALT); doc.rect(MARGIN,y,COL_W,rowH,'F'); }
        doc.setTextColor(0); doc.setFontSize(8); doc.setFont('helvetica','normal');
        doc.text(`#${order.id}`,  MARGIN+2, y+5);
        doc.text(timeStr,         MARGIN+14, y+5);
        doc.text(wrappedItems,    MARGIN+42, y+5);
        doc.text(payStr,          MARGIN+102, y+5);
        doc.text(`RM ${(order.totalCost||0).toFixed(2)}`, MARGIN+COL_W-2, y+5, {align:'right'});
        y += rowH;
    });

    // Footer
    for (let i=1; i<=doc.getNumberOfPages(); i++) {
        doc.setPage(i); doc.setFontSize(8); doc.setTextColor(150);
        doc.text(`Sate Hujung Minggu - ${subtitle}`, MARGIN, 290);
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
        calculate();
        setTimeout(() => { getMenuItems().forEach(item => { const el=document.getElementById(`qty-${item.id}`); if(el) el.style.background=''; }); }, 3000);
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
        if(qty&&qty>0){el.value=qty;el.style.background='#e8f5e9';filled++;}
    });
    return filled;
}
