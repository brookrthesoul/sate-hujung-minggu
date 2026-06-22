// orders.js — order calculation, rendering, and CRUD (home + orders tabs)
// Works against whatever items currently exist in menu.js — no fixed fields.

// ---------- Helper functions ----------
function formatDate(ts) {
    const d = new Date(ts);
    return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatDay(ts) {
    const d = new Date(ts);
    return d.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

// Convert an older order (saved before the dynamic menu existed, with flat
// ayam/daging/lontong/shortong fields directly on the order) into the
// current { items: { id: {name, category, price, qty, cost} } } shape, so
// orders you already saved keep displaying correctly.
function normalizeOrder(order) {
    if (order.items) return order;

    const legacyIds = ['ayam', 'daging', 'lontong', 'shortong'];
    const items = {};
    legacyIds.forEach(id => {
        const qty = order[id] || 0;
        const cost = order[`${id}Cost`] || 0;
        if (qty === 0 && cost === 0) return;
        const item = getMenuItem(id);
        items[id] = {
            name: item ? item.name : id.charAt(0).toUpperCase() + id.slice(1),
            category: item ? item.category : ((id === 'ayam' || id === 'daging') ? 'skewer' : 'side'),
            price: item ? item.price : (qty ? cost / qty : 0),
            qty,
            cost
        };
    });

    return {
        ...order,
        items,
        totalCost: order.totalCost || 0,
        skewerQty: order.ayamDagingQty || 0,
        scoops: order.scoops || 0
    };
}

// ---------- Home: dynamic menu inputs ----------
function renderHomeMenuInputs() {
    const container = document.getElementById('menuInputs');
    if (!container) return;
    container.innerHTML = getMenuItems().map(item => `
        <label id="label-${item.id}">${escapeHtml(item.name)} (RM${item.price.toFixed(2)})</label>
        <input type="number" id="qty-${item.id}" min="0" step="1" placeholder="0">
    `).join('');
}

function getQuantitiesFromHome() {
    const quantities = {};
    getMenuItems().forEach(item => {
        const el = document.getElementById(`qty-${item.id}`);
        quantities[item.id] = el ? (parseInt(el.value) || 0) : 0;
    });
    return quantities;
}

// ---------- Totals (generalized for any number of menu items) ----------
// quantities: { itemId: qty }
function calculateTotals(quantities) {
    const items = {};
    let totalCost = 0;
    let skewerQty = 0;
    let scoops = 0;

    getMenuItems().forEach(item => {
        const qty = quantities[item.id] || 0;
        const cost = qty * item.price;
        items[item.id] = { name: item.name, category: item.category, price: item.price, qty, cost };
        totalCost += cost;
        if (item.category === 'skewer') {
            skewerQty += qty;
            scoops += qty / 10;
        } else {
            scoops += qty * 2;
        }
    });

    return { items, totalCost, skewerQty, scoops };
}

// ---------- Home: calculate / clear / save ----------
function renderResultsGrid(totals) {
    const grid = document.getElementById('resultsGrid');
    if (!grid) return;
    let html = '';
    Object.values(totals.items).forEach(r => {
        html += `<div class="result-item"><span class="label">${escapeHtml(r.name)} <br></span><span class="value">RM${r.cost.toFixed(2)}</span></div>`;
    });
    html += `<div class="result-item"><span class="label">Jumlah Cucuk <br></span><span class="value">${totals.skewerQty}</span></div>`;
    html += `<div class="result-item"><span class="label">Jumlah Kuah Kacang <br></span><span class="value">${totals.scoops}</span></div>`;
    html += `<div class="result-item ice-cream" style="grid-column: span 2;"><span class="label">Jumlah RM <br></span><span class="value">RM${totals.totalCost.toFixed(2)}</span></div>`;
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

// ---------- Save order from home with error handling ----------
async function saveOrder() {
    const quantities = getQuantitiesFromHome();
    const hasAny = Object.values(quantities).some(q => q > 0);
    if (!hasAny) {
        alert('Please enter at least one item.');
        return;
    }

    const totals = calculateTotals(quantities);
    const description = document.getElementById('orderDescription').value.trim() || '';

    const order = {
        items: totals.items,
        totalCost: totals.totalCost,
        skewerQty: totals.skewerQty,
        scoops: totals.scoops,
        paid: false,
        pickedUp: false,
        description: description,
        createdAt: Date.now()
    };

    try {
        const id = await addOrder(order);
        console.log('✅ Order saved with id:', id);
        clearForm();
        switchTab('orders');
        switchOrderSubTab('prepare');
    } catch (error) {
        alert('❌ Failed to save order: ' + error.message);
        console.error(error);
    }
}

// ---------- Orders sub-tabs (Prepare / Paid / Done) ----------
let currentOrderSubTab = 'prepare';

function switchOrderSubTab(subtab) {
    currentOrderSubTab = subtab;
    document.querySelectorAll('.sub-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.order-sublist').forEach(l => l.classList.remove('active'));
    document.getElementById(`subTab-${subtab}`).classList.add('active');
    document.getElementById(`${subtab}List`).classList.add('active');
}

// ---------- Load orders into all three sub-tabs ----------
async function loadOrders() {
    try {
        const orders = (await getAllOrders()).map(normalizeOrder);
        const sortDir = document.getElementById('sortOrders').value;
        orders.sort((a, b) => sortDir === 'asc' ? a.createdAt - b.createdAt : b.createdAt - a.createdAt);

        const prepare = orders.filter(o => !o.paid);
        const paid = orders.filter(o => o.paid && !o.pickedUp);
        const done = orders.filter(o => o.paid && o.pickedUp);

        renderOrderList('prepareList', prepare, 'prepare');
        renderOrderList('paidList', paid, 'paid');
        renderOrderList('doneList', done, 'done');
    } catch (error) {
        alert('❌ Failed to load orders: ' + error.message);
        console.error(error);
    }
}

function renderOrderList(containerId, orderList, stage) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = '';

    if (orderList.length === 0) {
        container.innerHTML = '<p style="text-align:center; color:#999;">No orders here.</p>';
        return;
    }

    const groups = {};
    orderList.forEach(order => {
        const day = formatDay(order.createdAt);
        if (!groups[day]) groups[day] = [];
        groups[day].push(order);
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

// ---------- Render order card ----------
// stage: 'prepare' | 'prepare-edit' | 'paid' | 'done'
function renderOrderCard(card, rawOrder, stage = 'prepare') {
    const order = normalizeOrder(rawOrder);
    const safeOrder = {
        items: order.items || {},
        totalCost: order.totalCost || 0,
        skewerQty: order.skewerQty || 0,
        scoops: order.scoops || 0,
        paid: !!order.paid,
        pickedUp: !!order.pickedUp,
        description: order.description || '',
        id: order.id,
        createdAt: order.createdAt || Date.now()
    };

    const header = `
        <div class="order-header">
            <span class="order-id">#${safeOrder.id}</span>
            <span class="order-date">${formatDate(safeOrder.createdAt)}</span>
        </div>
    `;

    const itemBadges = Object.values(safeOrder.items)
        .filter(r => r.qty > 0)
        .map(r => `<div class="detail-badge">${escapeHtml(r.name)} (${r.qty}) <br> RM${r.cost.toFixed(2)}</div>`)
        .join('');

    const statsBadges = `
        <div class="detail-badge">Cucuk: ${safeOrder.skewerQty}</div>
        <div class="detail-badge"> ${safeOrder.scoops} Senduk</div>
        <div class="detail-badge ice-cream" style="grid-column: span 2;">RM ${safeOrder.totalCost.toFixed(2)}</div>
    `;

    const editableDescription = `<div class="order-description" id="desc-${safeOrder.id}" contenteditable="true" onblur="updateDescription(${safeOrder.id}, this.innerText)">${escapeHtml(safeOrder.description)}</div>`;

    if (stage === 'prepare-edit') {
        const editInputs = getMenuItems().map(item => {
            const existing = safeOrder.items[item.id];
            const qty = existing ? existing.qty : 0;
            return `<div><label>${escapeHtml(item.name)}</label><input type="number" id="edit-${item.id}-${safeOrder.id}" class="edit-input" value="${qty}" min="0" step="1" oninput="updateEditTotals(${safeOrder.id})"></div>`;
        }).join('');

        card.innerHTML = `
            ${header}
            <div class="order-details" id="edit-details-${safeOrder.id}">
                ${editInputs}
                <div class="detail-badge" id="edit-skewerQty-${safeOrder.id}">Cucuk: ${safeOrder.skewerQty}</div>
                <div class="detail-badge" id="edit-scoops-${safeOrder.id}">${safeOrder.scoops} Senduk</div>
                <div class="detail-badge ice-cream" style="grid-column: span 2;" id="edit-totalCost-${safeOrder.id}">RM${safeOrder.totalCost.toFixed(2)} </div>
            </div>
            ${editableDescription}
            <div class="action-buttons">
                <button class="save-btn" onclick="saveEdit(${safeOrder.id})">💾 Save</button>
                <button class="cancel-btn" onclick="cancelEdit(${safeOrder.id})">✖ Cancel</button>
            </div>
        `;
        return;
    }

    if (stage === 'paid') {
        card.innerHTML = `
            ${header}
            <div class="order-details">${itemBadges}${statsBadges}</div>
            <div class="status-row"><span class="status-mark mark-paid">✅ Paid</span></div>
            ${editableDescription}
            <div class="action-buttons">
                <button class="status-btn picked" onclick="markPickedUp(${safeOrder.id})">📦 Picked Up</button>
            </div>
        `;
        return;
    }

    if (stage === 'done') {
        card.innerHTML = `
            ${header}
            <div class="order-details">${itemBadges}${statsBadges}</div>
            <div class="status-row">
                <span class="status-mark mark-paid">✅ Paid</span>
                <span class="status-mark mark-picked">📦 Picked Up</span>
            </div>
            <div class="order-description">${escapeHtml(safeOrder.description)}</div>
            <div class="action-buttons">
                <button class="delete-btn" onclick="deleteOrderConfirm(${safeOrder.id})">🗑️ Delete</button>
                <button class="print-btn" onclick="printOrder(${safeOrder.id})">🖨️ Print</button>
            </div>
        `;
        return;
    }

    // default: 'prepare'
    card.innerHTML = `
        ${header}
        <div class="order-details">${itemBadges}${statsBadges}</div>
        ${editableDescription}
        <div class="action-buttons">
            <button class="delete-btn" onclick="deleteOrderConfirm(${safeOrder.id})">🗑️ Cancel</button>
            <button class="edit-btn" onclick="startEdit(${safeOrder.id})">✏️ Edit</button>
            <button class="status-btn paid" onclick="markPaid(${safeOrder.id})">✅ Mark as Paid</button>
        </div>
    `;
}

// ---------- Edit functions (Prepare stage only) ----------
function startEdit(id) {
    const card = document.getElementById(`order-${id}`);
    if (!card) return;
    getAllOrders().then(orders => {
        const order = orders.find(o => o.id === id);
        if (order) renderOrderCard(card, order, 'prepare-edit');
    });
}

function cancelEdit(id) {
    const card = document.getElementById(`order-${id}`);
    if (!card) return;
    getAllOrders().then(orders => {
        const order = orders.find(o => o.id === id);
        if (order) renderOrderCard(card, order, 'prepare');
    });
}

function getEditQuantities(orderId) {
    const quantities = {};
    getMenuItems().forEach(item => {
        const el = document.getElementById(`edit-${item.id}-${orderId}`);
        quantities[item.id] = el ? (parseInt(el.value) || 0) : 0;
    });
    return quantities;
}

function updateEditTotals(id) {
    const totals = calculateTotals(getEditQuantities(id));
    document.getElementById(`edit-skewerQty-${id}`).innerText = `Cucuk: ${totals.skewerQty}`;
    document.getElementById(`edit-totalCost-${id}`).innerText = `RM${totals.totalCost.toFixed(2)}`;
    document.getElementById(`edit-scoops-${id}`).innerHTML = `${totals.scoops} Senduk`;
}

async function saveEdit(id) {
    const totals = calculateTotals(getEditQuantities(id));
    const description = document.getElementById(`desc-${id}`).innerText.trim() || '';

    const all = await getAllOrders();
    const existing = all.find(o => o.id === id);
    if (!existing) return;

    const updatedOrder = {
        ...existing,
        items: totals.items,
        totalCost: totals.totalCost,
        skewerQty: totals.skewerQty,
        scoops: totals.scoops,
        description: description,
    };
    // Drop any legacy flat fields now that this order has been re-saved in the new shape
    delete updatedOrder.ayam; delete updatedOrder.daging; delete updatedOrder.lontong; delete updatedOrder.shortong;
    delete updatedOrder.ayamCost; delete updatedOrder.dagingCost; delete updatedOrder.lontongCost; delete updatedOrder.shortongCost;
    delete updatedOrder.ayamDagingQty;

    await updateOrder(updatedOrder);

    const card = document.getElementById(`order-${id}`);
    renderOrderCard(card, updatedOrder, 'prepare');
}

async function updateDescription(id, newText) {
    const all = await getAllOrders();
    const order = all.find(o => o.id === id);
    if (order) {
        order.description = newText.trim() || '';
        await updateOrder(order);
    }
}

// ---------- Stage transitions ----------
async function markPaid(id) {
    const all = await getAllOrders();
    const order = all.find(o => o.id === id);
    if (order) {
        order.paid = true;
        await updateOrder(order);
        loadOrders();
    }
}

async function markPickedUp(id) {
    const all = await getAllOrders();
    const order = all.find(o => o.id === id);
    if (order) {
        order.pickedUp = true;
        await updateOrder(order);
        loadOrders();
    }
}

async function deleteOrderConfirm(id) {
    if (confirm('Delete this order?')) {
        await deleteOrder(id);
        loadOrders();
    }
}
