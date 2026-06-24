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
//
// Category kuah kacang rules:
//   skewer    → 1 kuah per 10 sticks, minimum 1 if any sticks ordered (ceiling)
//   side      → 2 kuah per item
//   no-kuah   → 0 kuah (e.g. Sate Kambing — uses different sauce)
//   kuah-only → 1 kuah per item (standalone kuah kacang purchase)
function calculateTotals(quantities) {
    const items = {};
    let totalCost  = 0;
    let skewerQty  = 0;
    let skewerWithKuah = 0; // only sticks that contribute to kuah kacang
    let scoops     = 0;

    getMenuItems().forEach(item => {
        const qty  = quantities[item.id] || 0;
        const cost = qty * item.price;
        items[item.id] = { name: item.name, category: item.category, price: item.price, qty, cost };
        totalCost += cost;

        if (item.category === 'skewer') {
            skewerQty       += qty;
            skewerWithKuah  += qty;
        } else if (item.category === 'no-kuah') {
            skewerQty += qty; // counts as sticks but no kuah
        } else if (item.category === 'side') {
            scoops += qty * 2;
        } else if (item.category === 'kuah-only') {
            scoops += qty * 1;
        }
        // no-kuah and unknown categories contribute 0 kuah
    });

    // Skewer kuah: 1 per 10 sticks, minimum 1 if any skewer-with-kuah ordered
    if (skewerWithKuah > 0) {
        scoops += Math.ceil(skewerWithKuah / 10);
    }

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

    // Show date filter bar only on Done tab
    const filterBar = document.getElementById('doneFilterBar');
    if (filterBar) filterBar.style.display = subtab === 'done' ? 'flex' : 'none';

    if (subtab === 'done') _populateDoneDateFilter().then(() => loadOrders());
    else loadOrders();
}

// ---------- Load orders into all three sub-tabs ----------
async function loadOrders() {
    try {
        const orders = (await getAllOrders()).map(normalizeOrder);
        const sortDir = document.getElementById('sortOrders').value;
        orders.sort((a, b) => sortDir === 'asc' ? a.createdAt - b.createdAt : b.createdAt - a.createdAt);

        const prepare = orders.filter(o => !o.paid);
        const paid    = orders.filter(o => o.paid && !o.pickedUp);
        let   done    = orders.filter(o => o.paid && o.pickedUp);

        // Apply date filter to done tab
        const dateFilter = document.getElementById('doneDateFilter');
        if (dateFilter && dateFilter.value && dateFilter.value !== 'all') {
            const selectedDate = dateFilter.value; // 'today' or 'YYYY-MM-DD'
            const targetDate = selectedDate === 'today'
                ? new Date().toLocaleDateString('en-CA')  // YYYY-MM-DD local
                : selectedDate;
            done = done.filter(o => {
                const d = new Date(o.createdAt);
                return d.toLocaleDateString('en-CA') === targetDate;
            });
        }

        renderOrderList('prepareList', prepare, 'prepare');
        renderOrderList('paidList',    paid,    'paid');
        renderOrderList('doneList',    done,    'done');
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

// ─── Done tab date filter ─────────────────────────────────────────────────────

async function _populateDoneDateFilter() {
    const sel = document.getElementById('doneDateFilter');
    if (!sel) return;

    const orders = (await getAllOrders()).map(normalizeOrder);
    const done   = orders.filter(o => o.paid && o.pickedUp);

    // Collect unique dates (YYYY-MM-DD local)
    const dateSet = new Set();
    done.forEach(o => {
        dateSet.add(new Date(o.createdAt).toLocaleDateString('en-CA'));
    });

    const today = new Date().toLocaleDateString('en-CA');
    const dates = Array.from(dateSet).sort().reverse(); // newest first

    // Rebuild options
    const current = sel.value;
    sel.innerHTML = `<option value="today">Today (${today})</option><option value="all">All dates</option>`;
    dates.forEach(d => {
        if (d !== today) {
            const label = new Date(d + 'T00:00:00').toLocaleDateString(undefined, { weekday:'short', year:'numeric', month:'short', day:'numeric' });
            sel.innerHTML += `<option value="${d}">${label}</option>`;
        }
    });

    // Restore selection if still valid
    if (current && [...sel.options].some(o => o.value === current)) sel.value = current;
    else sel.value = 'today';
}

// ─── PDF Report ───────────────────────────────────────────────────────────────

function openReportModal() {
    const modal = document.getElementById('reportModal');
    if (!modal) return;
    // Set defaults
    document.getElementById('reportDate').value  = new Date().toLocaleDateString('en-CA');
    document.getElementById('reportMonth').value = new Date().toLocaleDateString('en-CA').substring(0, 7);
    updateReportDateUI();
    modal.style.display = 'flex';
}

function closeReportModal() {
    const modal = document.getElementById('reportModal');
    if (modal) modal.style.display = 'none';
}

function updateReportDateUI() {
    const type = document.getElementById('reportType').value;
    document.getElementById('reportDatePicker').style.display  = type === 'day'   ? 'block' : 'none';
    document.getElementById('reportMonthPicker').style.display = type === 'month' ? 'block' : 'none';
}

async function generateReport() {
    const type = document.getElementById('reportType').value;
    const allOrders = (await getAllOrders()).map(normalizeOrder);
    const done = allOrders.filter(o => o.paid && o.pickedUp);

    let filtered, title, subtitle;

    if (type === 'day') {
        const date = document.getElementById('reportDate').value;
        if (!date) { alert('Please select a date.'); return; }
        filtered = done.filter(o => new Date(o.createdAt).toLocaleDateString('en-CA') === date);
        const dateLabel = new Date(date + 'T00:00:00').toLocaleDateString(undefined, { weekday:'long', year:'numeric', month:'long', day:'numeric' });
        title    = 'DAILY SALES REPORT';
        subtitle = dateLabel;
    } else {
        const month = document.getElementById('reportMonth').value;
        if (!month) { alert('Please select a month.'); return; }
        filtered = done.filter(o => new Date(o.createdAt).toLocaleDateString('en-CA').substring(0, 7) === month);
        const [y, m] = month.split('-');
        subtitle = new Date(y, m - 1, 1).toLocaleDateString(undefined, { year:'numeric', month:'long' });
        title    = 'MONTHLY SALES REPORT';
    }

    if (filtered.length === 0) {
        alert('No completed orders found for the selected period.');
        return;
    }

    _buildPDF(title, subtitle, filtered);
    closeReportModal();
}

function _buildPDF(title, subtitle, orders) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });

    const PAGE_W  = 210;
    const MARGIN  = 16;
    const COL_W   = PAGE_W - MARGIN * 2;
    let   y       = 20;

    const LINE_H  = 6;
    const HEAD_BG = [41, 128, 185];
    const ROW_ALT = [245, 248, 252];
    const BORDER  = [200, 210, 220];

    function checkPage(needed = 10) {
        if (y + needed > 275) {
            doc.addPage();
            y = 20;
        }
    }

    // ── Header ────────────────────────────────────────────────────────────────
    doc.setFillColor(...HEAD_BG);
    doc.rect(0, 0, PAGE_W, 36, 'F');

    doc.setTextColor(255, 255, 255);
    doc.setFontSize(18); doc.setFont('helvetica', 'bold');
    doc.text('SATE HUJUNG MINGGU', PAGE_W / 2, 13, { align: 'center' });
    doc.setFontSize(13); doc.setFont('helvetica', 'normal');
    doc.text(title, PAGE_W / 2, 21, { align: 'center' });
    doc.setFontSize(10);
    doc.text(subtitle, PAGE_W / 2, 28, { align: 'center' });
    doc.text(`Generated: ${new Date().toLocaleString()}`, PAGE_W / 2, 34, { align: 'center' });

    y = 44;
    doc.setTextColor(0, 0, 0);

    // ── Summary totals ────────────────────────────────────────────────────────
    const totalRevenue = orders.reduce((s, o) => s + (o.totalCost || 0), 0);
    const totalOrders  = orders.length;

    // Aggregate items sold
    const itemTotals = {};
    orders.forEach(o => {
        Object.values(o.items || {}).forEach(r => {
            if (r.qty > 0) {
                if (!itemTotals[r.name]) itemTotals[r.name] = { qty: 0, revenue: 0, category: r.category };
                itemTotals[r.name].qty     += r.qty;
                itemTotals[r.name].revenue += r.cost;
            }
        });
    });

    // Summary cards row
    const cards = [
        { label: 'Total Orders', value: totalOrders },
        { label: 'Total Revenue', value: `RM ${totalRevenue.toFixed(2)}` },
        { label: 'Avg per Order', value: `RM ${(totalRevenue / totalOrders).toFixed(2)}` },
    ];
    const cardW = COL_W / 3;
    cards.forEach((c, i) => {
        const cx = MARGIN + i * cardW;
        doc.setFillColor(...ROW_ALT);
        doc.setDrawColor(...BORDER);
        doc.roundedRect(cx, y, cardW - 2, 18, 2, 2, 'FD');
        doc.setFont('helvetica', 'bold'); doc.setFontSize(14);
        doc.setTextColor(...HEAD_BG);
        doc.text(String(c.value), cx + (cardW - 2) / 2, y + 10, { align: 'center' });
        doc.setFont('helvetica', 'normal'); doc.setFontSize(8);
        doc.setTextColor(100, 100, 100);
        doc.text(c.label, cx + (cardW - 2) / 2, y + 16, { align: 'center' });
    });
    y += 24;

    // ── Items sold summary table ───────────────────────────────────────────────
    checkPage(20);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(0);
    doc.text('Items Sold Summary', MARGIN, y); y += 5;

    const itemCols = [
        { label: 'Item',     x: MARGIN,          w: 70, align: 'left'  },
        { label: 'Category', x: MARGIN + 70,     w: 40, align: 'left'  },
        { label: 'Qty Sold', x: MARGIN + 110,    w: 30, align: 'right' },
        { label: 'Revenue',  x: MARGIN + 140,    w: 38, align: 'right' },
    ];

    // Table header
    doc.setFillColor(...HEAD_BG);
    doc.rect(MARGIN, y, COL_W, LINE_H + 1, 'F');
    doc.setTextColor(255); doc.setFontSize(9); doc.setFont('helvetica', 'bold');
    itemCols.forEach(c => {
        const tx = c.align === 'right' ? c.x + c.w - 2 : c.x + 2;
        doc.text(c.label, tx, y + LINE_H - 1, { align: c.align });
    });
    y += LINE_H + 1;

    // Table rows
    const sortedItems = Object.entries(itemTotals).sort((a, b) => b[1].revenue - a[1].revenue);
    sortedItems.forEach(([name, data], idx) => {
        checkPage(LINE_H + 1);
        if (idx % 2 === 0) { doc.setFillColor(...ROW_ALT); doc.rect(MARGIN, y, COL_W, LINE_H, 'F'); }
        doc.setTextColor(0); doc.setFontSize(9); doc.setFont('helvetica', 'normal');
        const row = [name, data.category, String(data.qty), `RM ${data.revenue.toFixed(2)}`];
        itemCols.forEach((c, ci) => {
            const tx = c.align === 'right' ? c.x + c.w - 2 : c.x + 2;
            doc.text(row[ci], tx, y + LINE_H - 1, { align: c.align });
        });
        y += LINE_H;
    });

    // Totals row
    doc.setFillColor(220, 230, 240);
    doc.rect(MARGIN, y, COL_W, LINE_H, 'F');
    doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(0);
    doc.text('TOTAL', MARGIN + 2, y + LINE_H - 1);
    doc.text(`RM ${totalRevenue.toFixed(2)}`, MARGIN + COL_W - 2, y + LINE_H - 1, { align: 'right' });
    y += LINE_H + 8;

    // ── Per-order breakdown ───────────────────────────────────────────────────
    checkPage(20);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(0);
    doc.text('Order Breakdown', MARGIN, y); y += 5;

    const ordCols = [
        { label: '#',       x: MARGIN,       w: 12, align: 'left'  },
        { label: 'Time',    x: MARGIN + 12,  w: 40, align: 'left'  },
        { label: 'Items',   x: MARGIN + 52,  w: 80, align: 'left'  },
        { label: 'Total',   x: MARGIN + 132, w: 46, align: 'right' },
    ];

    doc.setFillColor(...HEAD_BG);
    doc.rect(MARGIN, y, COL_W, LINE_H + 1, 'F');
    doc.setTextColor(255); doc.setFontSize(8); doc.setFont('helvetica', 'bold');
    ordCols.forEach(c => {
        const tx = c.align === 'right' ? c.x + c.w - 2 : c.x + 2;
        doc.text(c.label, tx, y + LINE_H - 1, { align: c.align });
    });
    y += LINE_H + 1;

    orders.sort((a, b) => a.createdAt - b.createdAt).forEach((order, idx) => {
        const itemSummary = Object.values(order.items || {})
            .filter(r => r.qty > 0)
            .map(r => `${r.name}×${r.qty}`)
            .join(', ');
        const timeStr = new Date(order.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const row = [`#${order.id}`, timeStr, itemSummary, `RM ${(order.totalCost||0).toFixed(2)}`];

        // Estimate height needed (items text may wrap)
        const wrappedItems = doc.splitTextToSize(itemSummary, 78);
        const rowH = Math.max(LINE_H, wrappedItems.length * 4 + 3);
        checkPage(rowH + 1);

        if (idx % 2 === 0) { doc.setFillColor(...ROW_ALT); doc.rect(MARGIN, y, COL_W, rowH, 'F'); }
        doc.setTextColor(0); doc.setFontSize(8); doc.setFont('helvetica', 'normal');
        doc.text(row[0], MARGIN + 2, y + 5);
        doc.text(row[1], MARGIN + 14, y + 5);
        doc.text(wrappedItems, MARGIN + 54, y + 5);
        doc.text(row[3], MARGIN + COL_W - 2, y + 5, { align: 'right' });
        y += rowH;
    });

    // ── Footer ────────────────────────────────────────────────────────────────
    const pageCount = doc.getNumberOfPages();
    for (let i = 1; i <= pageCount; i++) {
        doc.setPage(i);
        doc.setFontSize(8); doc.setTextColor(150);
        doc.text(`Sate Hujung Minggu — ${subtitle}`, MARGIN, 290);
        doc.text(`Page ${i} of ${pageCount}`, PAGE_W - MARGIN, 290, { align: 'right' });
    }

    const filename = `SHM_${subtitle.replace(/[^a-zA-Z0-9]/g, '_')}.pdf`;
    doc.save(filename);
}

// ─── Paste-to-parse: auto-fill order from customer message ───────────────────

async function parseOrderMessage() {
    const input  = document.getElementById('pasteOrderInput');
    const status = document.getElementById('parseStatus');
    const msg    = input.value.trim();
    if (!msg) { status.textContent = '⚠️ Paste a message first.'; return; }

    status.textContent = '⏳ Parsing...';

    const menuList = getMenuItems().map(i => `${i.id} (${i.name})`).join(', ');
    const prompt = `You are a helpful assistant for a Malaysian satay stall order system.

The customer sent this message:
"${msg}"

The available menu item IDs are: ${menuList}

Extract the quantities ordered for each menu item. Return ONLY a valid JSON object like:
{"ayam": 50, "daging": 20, "lontong": 1}

Rules:
- Only include items that were actually ordered (qty > 0)
- Match item names flexibly — "ayam", "chicken", "ayam bakar" all map to "ayam"
- Ignore pickup time, greetings, and other non-order text
- If an item is not mentioned, do not include it
- Return ONLY the JSON object, nothing else`;

    try {
        const res = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'claude-sonnet-4-6',
                max_tokens: 256,
                messages: [{ role: 'user', content: prompt }]
            })
        });

        const data = await res.json();
        const text = (data.content || []).map(b => b.text || '').join('').trim();

        // Parse JSON — strip any accidental markdown fences
        const clean = text.replace(/```json|```/g, '').trim();
        const parsed = JSON.parse(clean);

        // Fill description box with original message so pickup time / notes are visible
        const descBox = document.getElementById('orderDescription');
        if (descBox && msg) descBox.value = msg;

        // Fill in the form
        let filled = 0;
        getMenuItems().forEach(item => {
            const el = document.getElementById(`qty-${item.id}`);
            if (!el) return;
            const qty = parsed[item.id];
            if (qty && qty > 0) {
                el.value = qty;
                el.style.background = '#e8f5e9'; // green tint to show auto-filled
                filled++;
            }
        });

        if (filled > 0) {
            status.textContent = `✅ Filled ${filled} item${filled > 1 ? 's' : ''}`;
            // Auto-calculate
            calculate();
            // Reset highlights after 3s
            setTimeout(() => {
                getMenuItems().forEach(item => {
                    const el = document.getElementById(`qty-${item.id}`);
                    if (el) el.style.background = '';
                });
            }, 3000);
        } else {
            status.textContent = '⚠️ No items recognised.';
        }

    } catch (e) {
        console.error('Parse error:', e);
        status.textContent = '❌ Failed to parse. Try again.';
    }
}
