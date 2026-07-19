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
        const todayStr = new Date().toLocaleDateString('en-CA');
        order.pickupTs = new Date(`${todayStr}T${stored.toTimeString().substring(0,5)}`).getTime();
    }
    return order;
}

// ---------- Home: menu inputs ----------
function renderHomeMenuInputs() {
    const container = document.getElementById('menuInputs');
    if (!container) return;
    container.innerHTML = getMenuItems().map(item => {
        const isSate = item.category === 'skewer' || item.category === 'no-kuah';
        if (isSate) {
            return `<div style="display:flex;flex-direction:column;gap:4px;">
                <label id="label-${item.id}" style="font-size:13px;font-weight:600;line-height:1.3;">
                    ${escapeHtml(item.name)}<br><span style="font-weight:400;color:#666;">RM${item.price.toFixed(2)}</span>
                </label>
                <input type="number" id="qty-${item.id}" min="0" step="1" placeholder="0"
                    style="width:100%;box-sizing:border-box;"
                    oninput="checkStockInput('${item.id}', this.value)">
                <span id="stock-indicator-${item.id}" class="stock-indicator"></span>
            </div>`;
        } else {
            return `<div style="display:flex;flex-direction:column;gap:4px;">
                <label id="label-${item.id}" style="font-size:13px;font-weight:600;line-height:1.3;">
                    ${escapeHtml(item.name)}<br><span style="font-weight:400;color:#666;">RM${item.price.toFixed(2)}</span>
                </label>
                <div style="display:flex;align-items:center;gap:4px;">
                    <button type="button" onclick="adjustQty('${item.id}',-1)"
                        style="width:36px;height:36px;border-radius:8px;border:2px solid #6c757d;background:#e9ecef;font-size:18px;font-weight:900;cursor:pointer;flex-shrink:0;color:#343a40;line-height:1;padding:0;">−</button>
                    <input type="number" id="qty-${item.id}" min="0" step="1" placeholder="0"
                        style="flex:1;min-width:40px;width:100%;box-sizing:border-box;text-align:center;font-size:16px;font-weight:700;"
                        oninput="checkStockInput('${item.id}', this.value)">
                    <button type="button" onclick="adjustQty('${item.id}',+1)"
                        style="width:36px;height:36px;border-radius:8px;border:2px solid #6c757d;background:#e9ecef;font-size:18px;font-weight:900;cursor:pointer;flex-shrink:0;color:#343a40;line-height:1;padding:0;">+</button>
                </div>
                <span id="stock-indicator-${item.id}" class="stock-indicator"></span>
            </div>`;
        }
    }).join('');
    if (typeof updateStockIndicators === 'function') updateStockIndicators();
}

function adjustQty(id, delta) {
    const el  = document.getElementById('qty-' + id);
    if (!el) return;
    const val = Math.max(0, (parseInt(el.value) || 0) + delta);
    el.value  = val;
    if (typeof checkStockInput === 'function') checkStockInput(id, val);
    if (typeof calculate === 'function') calculate();
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
    const _kuahRatio = parseInt(localStorage.getItem('shmKuahRatio')) || 10;
    if (skewerWithKuah > 0) scoops += Math.ceil(skewerWithKuah / _kuahRatio);
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
    const custName  = document.getElementById('customerNameInput');
    const custPhone = document.getElementById('customerPhoneInput');
    if (custName)  custName.value  = '';
    if (custPhone) custPhone.value = '';
    const pDate = document.getElementById('pickupDate');
    const pTime = document.getElementById('pickupTime');
    if (pDate) pDate.value = '';
    if (pTime) pTime.value = '';
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
    const customerName  = (document.getElementById('customerNameInput')  || {}).value?.trim()  || '';
    const customerPhone = (document.getElementById('customerPhoneInput') || {}).value?.trim()  || '';

    // Pick-up date/time (optional)
    const pickupDateEl = document.getElementById('pickupDate');
    const pickupTimeEl = document.getElementById('pickupTime');
    const pickupDate   = pickupDateEl ? pickupDateEl.value : '';
    const pickupTime   = pickupTimeEl ? pickupTimeEl.value : '';
    let   pickupTs     = null;
    let   pickupMode   = null; // 'datetime' | 'date' | 'time'
    const todayStr     = new Date().toLocaleDateString('en-CA');
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
    // Check and deduct stock before saving
    if (typeof deductStock === 'function') {
        const stockResult = deductStock(totals.items);
        if (!stockResult.ok) {
            const avail = stockResult.available;
            if (avail === 0) {
                alert(`❌ Out of stock: ${stockResult.name}`);
            } else {
                alert(`❌ Insufficient stock: ${stockResult.name}\nRequested: ${stockResult.requested}, Available: ${avail}`);
            }
            return;
        }
    }

    try {
        await addOrder(order);
        clearForm();
        const today = new Date().toLocaleDateString('en-CA');
        // Only date or datetime with a FUTURE date go to preorder
        // Time-only always goes to prepare (today)
        const isPreorder = pickupTs && pickupMode !== 'time' &&
            new Date(pickupTs).toLocaleDateString('en-CA') > today;
        if (isPreorder) {
            switchTab('preorder');
        } else {
            switchTab('orders');
            switchOrderSubTab('prepare');
            window.scrollTo({ top: 0, behavior: 'smooth' });
        }
    } catch (e) {
        alert('❌ Failed to save order: ' + e.message);
    }
}


// ─── Preorder tab ─────────────────────────────────────────────────────────────
async function loadPreorders() {
    if (_editingIds.size > 0) return;
    try {
        const orders  = (await getAllOrders()).map(normalizeOrder);
        const today   = new Date().toLocaleDateString('en-CA');
        const sortDir = document.getElementById('sortPreorders') ?
            document.getElementById('sortPreorders').value : 'asc';

        const preorders = orders.filter(o => {
            if (o.prepared || o.paid || o.pickedUp) return false;
            if (!o.pickupTs || o.pickupMode === 'time') return false;
            const pDay = new Date(o.pickupTs).toLocaleDateString('en-CA');
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
    } catch(e) {
        console.error('loadPreorders error:', e);
    }
}

// Check every minute if any preorder should move to Prepare
function startPreorderTimer() {
    setInterval(async () => {
        const today   = new Date().toLocaleDateString('en-CA');
        const orders  = (await getAllOrders()).map(normalizeOrder);
        const toMove  = orders.filter(o => {
            if (o.prepared || o.paid || o.pickedUp || !o.pickupTs) return false;
            const pDay = new Date(o.pickupTs).toLocaleDateString('en-CA');
            return pDay <= today;
        });
        if (toMove.length > 0) {
            // No DB change needed — loadOrders re-filters by date automatically
            loadOrders();
            loadPreorders();
        }
        // Also refresh prepare sort every minute (for 15min pin logic)
        if (currentOrderSubTab === 'prepare') loadOrders();
    }, 60 * 1000); // every 60 seconds
}

// ---------- Auto day-close ----------
// Runs on app start:
// 1. Paid but not picked up from previous days → silently moved to Done
// 2. Unpaid orders from previous days → prompt user to Keep or Cancel each one
async function autoClosePreviousDay() {
    const today  = new Date().toLocaleDateString('en-CA');
    const orders = (await getAllOrders()).map(normalizeOrder);

    const stale  = orders.filter(o => {
        const orderDay = new Date(o.createdAt).toLocaleDateString('en-CA');
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
            const pickupDay = new Date(o.pickupTs).toLocaleDateString('en-CA');
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
                <span>RM${r.cost.toFixed(2)}</span>
            </div>`)
            .join('');

        const stage = !order.prepared ? 'Prepare' : 'Prepared';

        modal.innerHTML = `
            <div style="background:white;border-radius:18px;padding:24px;width:92%;max-width:400px;box-shadow:0 8px 32px rgba(0,0,0,0.3);">
                <div style="background:#fff3cd;border-radius:10px;padding:10px 14px;margin-bottom:16px;font-size:13px;color:#856404;">
                    ⚠️ Leftover unpaid order from <strong>${day}</strong>
                </div>
                <div style="font-size:12px;color:#999;margin-bottom:4px;">${time} &nbsp;·&nbsp; Stage: ${stage} &nbsp;·&nbsp; #${order.id}</div>
                <div style="margin:10px 0;">${itemRows}</div>
                <div style="display:flex;justify-content:space-between;font-weight:bold;padding:8px 0;border-top:2px solid #eee;margin-bottom:6px;">
                    <span>Total</span><span>RM${(order.totalCost||0).toFixed(2)}</span>
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

    // Only show sate summary bar on Prepare tab
    const summaryBar = document.getElementById('sateSummaryBar');
    if (summaryBar) summaryBar.style.display = subtab === 'prepare' ? 'flex' : 'none';

    if (subtab === 'done') _populateDoneDateFilter().then(() => loadOrders());
    else loadOrders();
}

// ── Sate summary bar (Prepare tab) ────────────────────────────────────────
// Tallies qty of skewer-category items across all Prepare-stage orders
function updateSateSummaryBar(prepareOrders) {
    const bar = document.getElementById('sateSummaryBar');
    if (!bar) return;

    const totals = {};
    prepareOrders.forEach(order => {
        Object.values(order.items || {}).forEach(item => {
            if (item.category === 'skewer' || item.category === 'no-kuah') {
                if (item.qty > 0) {
                    totals[item.name] = (totals[item.name] || 0) + item.qty;
                }
            }
        });
    });

    const entries = Object.entries(totals);
    if (entries.length === 0) {
        bar.innerHTML = '<span style="color:#999;font-size:13px;">No sate orders</span>';
    } else {
        bar.innerHTML = entries.map(([name, qty], i, arr) =>
            `<span class="sate-summary-chip"><strong>${qty}</strong> ${escapeHtml(name)}</span>` +
            (i < arr.length - 1 ? '<span class="sate-dot">·</span>' : '')
        ).join('');
    }
}

async function loadOrders() {
    // Don't re-render while any card is in edit mode — sync will catch up after save/cancel
    if (_editingIds.size > 0) return;
    try {
        const orders  = (await getAllOrders()).map(normalizeOrder);
        const sortDir = document.getElementById('sortOrders').value;
        orders.sort((a,b) => sortDir==='asc' ? a.createdAt-b.createdAt : b.createdAt-a.createdAt);

        // Stage buckets
        const today    = new Date().toLocaleDateString('en-CA');
        const now      = Date.now();
        const WARN_MS  = 15 * 60 * 1000; // 15 minutes

        // preorder = future pickupTs (not today)
        // prepare  = not prepared, not paid, and either no pickupTs or pickupTs is today/past
        const prepare  = orders.filter(o => {
            if (o.prepared || o.paid) return false;
            if (!o.pickupTs) return true;
            const pDay = new Date(o.pickupTs).toLocaleDateString('en-CA');
            return pDay <= today;
        });
        const prepared = orders.filter(o =>  o.prepared && !o.paid);
        const paid     = orders.filter(o =>  o.paid     && !o.pickedUp);
        let   done     = orders.filter(o =>  o.paid     &&  o.pickedUp);

        // Sort prepare: orders with pickupTs within 15min (or past) float to top
        prepare.sort((a, b) => {
            const aPinned = a.pickupTs && (now - a.pickupTs) >= -WARN_MS;
            const bPinned = b.pickupTs && (now - b.pickupTs) >= -WARN_MS;
            if (aPinned && !bPinned) return -1;
            if (!aPinned && bPinned) return  1;
            if (aPinned && bPinned) return (a.pickupTs || 0) - (b.pickupTs || 0); // earliest first
            // Normal sort
            return sortDir === 'asc' ? a.createdAt - b.createdAt : b.createdAt - a.createdAt;
        });

        const dateFilter = document.getElementById('doneDateFilter');
        if (dateFilter && dateFilter.value && dateFilter.value !== 'all') {
            const target = dateFilter.value === 'today'
                ? new Date().toLocaleDateString('en-CA')
                : dateFilter.value;
            done = done.filter(o => new Date(o.createdAt).toLocaleDateString('en-CA') === target);
        }

        updateSateSummaryBar(prepare);
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

// ---------- Payment display helper ----------
const _ONLINE_METHODS_BADGE = ['online', 'card', 'boost', 'tng'];
const _METHOD_ICONS = { online:'💳', card:'💳', boost:'🚀', tng:'🛣️', cash:'💵', both:'🤝' };
const _METHOD_NAMES = { online:'Online', card:'Card', boost:'Boost', tng:'T&G', cash:'Cash', both:'Both' };

function paymentBadgeHTML(order) {
    const m       = order.paymentMethod;
    const total   = order.totalCost || 0;
    const online  = order.paymentOnline || 0;
    const cash    = order.paymentCash   || 0;
    if (!m) return '';

    const icon = _METHOD_ICONS[m] || '💳';
    const name = _METHOD_NAMES[m] || m;

    if (_ONLINE_METHODS_BADGE.includes(m)) {
        if (order.isDeposit) {
            const balance = total - online;
            return '<div class="payment-badge badge-deposit">' +
                icon + ' Deposit (' + name + ') — RM' + online.toFixed(2) +
                ' &nbsp;|&nbsp; Balance: <strong>RM' + balance.toFixed(2) + '</strong>' +
                '</div>';
        }
        return '<div class="payment-badge badge-online">' + icon + ' ' + name + ' — RM' + online.toFixed(2) + '</div>';
    }

    if (m === 'cash') {
        if (order.isCashShort) {
            const short = total - cash;
            return '<div class="payment-badge badge-short">' +
                '⚠️ Short by <strong>RM' + short.toFixed(2) + '</strong>' +
                ' &nbsp;|&nbsp; Paid: RM' + cash.toFixed(2) +
                '</div>';
        }
        const given  = order.cashGiven || cash;
        const change = order.cashChange || 0;
        let badge = '<div class="payment-badge badge-cash">💵 Cash — RM' + cash.toFixed(2);
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
        let badge = '<div class="payment-badge badge-both">' +
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
function renderOrderCard(card, rawOrder, stage) {
    const o = normalizeOrder(rawOrder);

    const now       = Date.now();
    const WARN_MS   = 15 * 60 * 1000;
    // Only pin/urgent in prepare stage — once moved forward, show plain badge
    const isPinned  = o.pickupTs && (now - o.pickupTs) >= -WARN_MS && !o.prepared && !o.paid;
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
    const pickupBadge = pickupStr
        ? `<div class="pickup-badge ${isPinned ? 'pickup-urgent' : ''}">📅 Pick-up: ${pickupStr}</div>`
        : '';

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
        .map(r => `<div class="detail-badge">${escapeHtml(r.name)} (${r.qty})<br>RM${r.cost.toFixed(2)}</div>`)
        .join('');

    const statsBadges = `
        <div class="detail-badge">Cucuk: ${o.skewerQty}</div>
        <div class="detail-badge">${o.scoops} Senduk</div>
        <div class="detail-badge ice-cream" style="grid-column:span 2;">RM ${o.totalCost.toFixed(2)}</div>`;

    const contactBadge = (o.customerName || o.customerPhone)
        ? `<div class="detail-badge" style="grid-column:span 2;">
             ${o.customerName ? `👤 ${escapeHtml(o.customerName)}` : ''}${o.customerName && o.customerPhone ? ' · ' : ''}${o.customerPhone ? `📞 ${escapeHtml(o.customerPhone)}` : ''}
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

    // ── Preorder ──────────────────────────────────────────────────────────
    if (stage === 'preorder') {
        const hasPaymentPre  = !!o.paymentMethod;
        const payBadgePre    = hasPaymentPre ? `<div style="margin:8px 0;">${paymentBadgeHTML(o)}</div>` : '';
        card.dataset.stage   = 'preorder';
        card.innerHTML = isExpanded ? `
            ${header}
            <div class="order-details">${itemBadges}${statsBadges}${contactBadge}</div>
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

        card.innerHTML = isExpanded ? `
            ${header}
            <div class="order-details">${itemBadges}${statsBadges}${contactBadge}</div>
            ${editableDesc}
            ${payBadge}
            <div class="action-buttons">
                <button class="delete-btn" onclick="deleteOrderConfirm(${o.id})">🗑️ Cancel</button>
                <button class="edit-btn"   onclick="startEditTo(${o.id}, 'prepare')">✏️ Edit</button>
                <button class="pay-method-btn" onclick="openPaymentModal(${o.id}, ${o.totalCost}, 'prepare')">💳 Payment</button>
            </div>
            ${markPaidBtn}
            ${printReceiptBtnPrepare}
            <button class="status-btn done-btn" onclick="markPrepared(${o.id})" style="margin-top:8px;">Ready</button>`
            : `${header}${payBadge}${miniView}`;
        return;
    }

    // ── Prepared ──────────────────────────────────────────────────────────
    if (stage === 'prepared') {
        const hasPayment = !!o.paymentMethod;
        const payBadge   = hasPayment
            ? `<div style="margin:8px 0;">${paymentBadgeHTML(o)}</div>` : '';

        const printReceiptBtnPrepared = hasPayment
            ? `<button class="print-btn" style="margin-top:8px;width:100%;" onclick="printOrderReceipt(${o.id})">🖨️ Print Receipt</button>` : '';

        const readyBtn = !o.isReady
            ? `<button class="status-btn" onclick="markReady(${o.id})"
                style="margin-top:8px;background:#17a2b8;border-color:#17a2b8;">
                📢 Ready — Notify Customer</button>`
            : `<div class="status-mark mark-prepared" style="margin-top:8px;background:#17a2b8;color:white;display:inline-block;padding:6px 14px;border-radius:20px;font-size:13px;">
                📢 Customer Notified</div>`;

        card.innerHTML = isExpanded ? `
            ${header}
            <div class="order-details">${itemBadges}${statsBadges}${contactBadge}</div>
            <div class="status-row"><span class="status-mark mark-prepared">🍢 Prepared</span></div>
            ${editableDesc}
            ${payBadge}
            <div class="action-buttons">
                <button class="delete-btn" onclick="deleteOrderConfirm(${o.id})">🗑️ Cancel</button>
                <button class="edit-btn"   onclick="startEditTo(${o.id}, 'prepared')">✏️ Edit</button>
                <button class="pay-method-btn" onclick="openPaymentModal(${o.id}, ${o.totalCost}, 'prepared')">💳 Payment</button>
            </div>
            ${printReceiptBtnPrepared}
            ${readyBtn}
            <button class="status-btn paid" onclick="markPaid(${o.id})" style="margin-top:8px;">✅ Mark as Paid</button>`
            : `${header}${payBadge}${miniView}`;
        return;
    }

    // ── Paid ──────────────────────────────────────────────────────────────
    if (stage === 'paid') {
        card.innerHTML = isExpanded ? `
            ${header}
            <div class="order-details">${itemBadges}${statsBadges}${contactBadge}</div>
            <div class="status-row"><span class="status-mark mark-paid">✅ Paid</span></div>
            <div style="margin:8px 0;">${paymentBadgeHTML(o)}</div>
            ${readonlyDesc}
            <div class="action-buttons">
                <button class="edit-btn"       onclick="undoToPrepared(${o.id})">↩️ Undo</button>
                <button class="pay-method-btn" onclick="openPaymentModal(${o.id}, ${o.totalCost}, 'paid')">💳 Update Payment</button>
                <button class="status-btn picked" onclick="markPickedUp(${o.id})">📦 Picked Up</button>
            </div>`
            : `${header}${paymentBadgeHTML(o) ? `<div style="margin:4px 0;">${paymentBadgeHTML(o)}</div>` : ''}${miniView}`;
        return;
    }

    // ── Done ──────────────────────────────────────────────────────────────
    if (stage === 'done') {
        card.innerHTML = isExpanded ? `
            ${header}
            <div class="order-details">${itemBadges}${statsBadges}${contactBadge}</div>
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
    // Adjust stock for the difference between old and new quantities
    if (typeof adjustStock === 'function' && !existing.paid) {
        const stockResult = adjustStock(existing.items || {}, totals.items);
        if (!stockResult.ok) {
            const avail = stockResult.available;
            if (avail === 0) {
                alert(`❌ Out of stock: ${stockResult.name}`);
            } else {
                alert(`❌ Insufficient stock: ${stockResult.name}\nAdding: ${stockResult.requested} more, Available: ${avail}`);
            }
            return;
        }
    }

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
        // Return stock if order was not yet paid (still active)
        const all   = await getAllOrders();
        const order = normalizeOrder(all.find(o => o.id === id) || {});
        if (order && !order.paid && typeof returnStock === 'function') {
            returnStock(order.items || {});
        }
        await deleteOrder(id);
        loadOrders();
        loadPreorders();
    }
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

        box.innerHTML =
            '<div class="pay-total-hint">Bill total: <strong>RM' + total.toFixed(2) + '</strong></div>' +
            '<label class="pay-label">' + label + ' Amount (RM)</label>' +
            '<input type="number" id="payOnlineInput" step="0.01" min="0" class="pay-input">' +
            '<div id="onlineDepositHint" class="change-display" style="display:none;"></div>' +
            '<div style="display:flex;align-items:center;gap:10px;margin-top:14px;padding:10px;background:#f8f9fa;border-radius:10px;">' +
                '<span style="font-size:13px;font-weight:600;flex:1;">+ Cash as well?</span>' +
                '<button type="button" id="withCashToggle" onclick="_toggleCashSection()" ' +
                    'style="padding:6px 16px;border-radius:20px;border:2px solid #6c757d;background:white;font-size:13px;font-weight:600;cursor:pointer;color:#6c757d;"' +
                    '>OFF</button>' +
            '</div>' +
            '<div id="cashSection" style="display:none;margin-top:10px;">' +
                '<label class="pay-label">Cash Given by Customer (RM)</label>' +
                '<input type="number" id="payCashInput" step="0.01" min="0" class="pay-input" placeholder="How much did they give?">' +
                '<div id="changeDisplayBoth" class="change-display" style="display:none;"></div>' +
            '</div>';

        document.getElementById('payOnlineInput').value = dVal.toFixed(2);

        document.getElementById('payOnlineInput').addEventListener('input', function() {
            const paid  = parseFloat(this.value) || 0;
            const hint  = document.getElementById('onlineDepositHint');
            const balance = total - paid;
            if (paid <= 0) { hint.style.display = 'none'; return; }
            hint.style.display = 'block';
            if (balance > 0.005) {
                hint.className = 'change-display change-short';
                hint.innerHTML = '&#9888; Deposit — Balance: <strong>RM' + balance.toFixed(2) + '</strong>';
            } else {
                hint.className = 'change-display change-ok';
                hint.innerHTML = '&#10003; Full payment — RM' + paid.toFixed(2);
            }
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
    if (!isOn) return;
    const cashEl = document.getElementById('payCashInput');
    if (cashEl && prefillVal !== undefined) cashEl.value = prefillVal.toFixed(2);
    if (cashEl && !cashEl._hasListener) {
        cashEl._hasListener = true;
        cashEl.addEventListener('input', function() {
            const cashGiven = parseFloat(this.value) || 0;
            const disp      = document.getElementById('changeDisplayBoth');
            if (cashGiven <= 0) { disp.style.display = 'none'; return; }
            const totalPaid = (parseFloat(document.getElementById('payOnlineInput').value)||0) + cashGiven;
            const change    = totalPaid - _pmTotal;
            disp.style.display = 'block';
            if (change < -0.005) {
                disp.className = 'change-display change-short';
                disp.innerHTML = '&#9888; Short by <strong>RM' + Math.abs(change).toFixed(2) + '</strong>';
            } else {
                disp.className = 'change-display change-ok';
                disp.innerHTML = 'Change: <strong>RM' + change.toFixed(2) + '</strong>';
            }
        });
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

    const _ONLINE_METHODS = ['online', 'card', 'boost', 'tng'];
    const withCashToggle  = document.getElementById('withCashToggle');
    const hasCashSection  = withCashToggle && withCashToggle.textContent === 'ON';

    // If digital + cash toggle is on → treat as 'both' but store which digital method
    if (_ONLINE_METHODS.includes(method) && hasCashSection) {
        // cashAmt = what customer gave in cash for the cash portion
        // The cash portion they owe = total - onlineAmt
        const cashOwed   = Math.max(0, _pmTotal - onlineAmt);
        const cashChange = cashAmt - cashOwed;
        order.paymentMethod  = 'both';
        order._digitalMethod = method;
        order.paymentOnline  = onlineAmt;
        order.paymentCash    = cashChange > 0 ? cashOwed : cashAmt; // only keep what we're owed
        order.cashGiven      = cashAmt;
        order.cashChange     = cashChange > 0 ? cashChange : 0;
        order.isDeposit      = false;
        order.isCashShort    = cashAmt < cashOwed - 0.005;
        await updateOrder(order);
        closePaymentModal();
        loadOrders();
        if (typeof loadPreorders === 'function') loadPreorders();
        return;
    }

    order.paymentMethod = method;
    order.paymentOnline = (method === 'cash')              ? 0 : onlineAmt;
    order.paymentCash   = _ONLINE_METHODS.includes(method) ? 0 : cashAmt;

    // Deposit / short flags
    if (_ONLINE_METHODS.includes(method)) {
        order.isDeposit   = onlineAmt < (_pmTotal - 0.005);
        order.isCashShort = false;
    } else if (method === 'cash') {
        // cashAmt = what customer physically gave
        // paymentCash = actual amount we receive (capped at total if they overpay)
        const cashChange  = cashAmt - _pmTotal;
        order.isCashShort = cashAmt < (_pmTotal - 0.005);
        order.cashGiven   = cashAmt;
        order.cashChange  = cashChange > 0 ? cashChange : 0;
        // paymentCash stores only what we actually keep (not the change we give back)
        order.paymentCash = order.isCashShort ? cashAmt : _pmTotal;
        order.isDeposit   = false;
    } else {
        order.isDeposit   = false;
        order.isCashShort = false;
    }

    await updateOrder(order);
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
    doc.text((localStorage.getItem('shmBusinessName')||'Sate Hujung Minggu').toUpperCase(), PAGE_W/2, 13, {align:'center'});
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
    // Breakdown by each method
    const byMethod = {};
    orders.forEach(o => {
        const m = o.paymentMethod || 'unknown';
        if (!byMethod[m]) byMethod[m] = 0;
        if (['online','card','boost','tng'].includes(m)) byMethod[m] += (o.paymentOnline||0);
        else if (m === 'cash') byMethod[m] += (o.paymentCash||0);
        else if (m === 'both') {
            byMethod['online'] = (byMethod['online']||0) + (o.paymentOnline||0);
            byMethod['cash']   = (byMethod['cash']||0)   + (o.paymentCash||0);
            delete byMethod['both'];
        }
    });
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
    const methodNames = { online:'Online', card:'Card', boost:'Boost', tng:'T&G', cash:'Cash' };
    let bx = MARGIN + 52;
    Object.entries(byMethod).forEach(([mkey, amt]) => {
        const label = (methodNames[mkey] || mkey) + ': RM ' + amt.toFixed(2);
        doc.text(label, bx, y+8);
        bx += label.length * 2.2 + 8;
    });
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
        const _PM = order.paymentMethod || '';
        const _MN = { online:'Online', card:'Card', boost:'Boost', tng:'T&G' };
        let payStr = '';
        if (['online','card','boost','tng'].includes(_PM)) payStr = (_MN[_PM]||_PM) + ' RM' + (order.paymentOnline||0).toFixed(2);
        else if (_PM==='cash') payStr = 'Cash RM' + (order.paymentCash||0).toFixed(2);
        else if (_PM==='both') {
            const dm = order._digitalMethod || 'online';
            payStr = (_MN[dm]||dm) + ':RM' + (order.paymentOnline||0).toFixed(2) + ' C:RM' + (order.paymentCash||0).toFixed(2);
        }

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
        doc.text(`${localStorage.getItem('shmBusinessName')||'Sate Hujung Minggu'} - ${subtitle}`, MARGIN, 290);
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
