// menu.js — dynamic menu synced via Supabase (stored in 'menu' table)
// Each item: { id, name, price, category }

const DEFAULT_MENU = [
    { id: 'ayam',     name: 'Ayam',         price: 1.30, category: 'skewer'    },
    { id: 'daging',   name: 'Daging',        price: 1.60, category: 'skewer'    },
    { id: 'kambing',  name: 'Kambing',       price: 2.00, category: 'no-kuah'  },
    { id: 'lontong',  name: 'Lontong',       price: 3.00, category: 'side'     },
    { id: 'shortong', name: 'Shortong',      price: 2.00, category: 'side'     },
    { id: 'kuah',     name: 'Kuah Kacang',   price: 1.00, category: 'kuah-only'},
];

let menuItems = [];

// ─── Supabase menu storage (reuses credentials from sync.js) ─────────────────

const MENU_TABLE = 'menu';

async function _menuFetch(path, opts = {}) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
        ...opts,
        headers: {
            'apikey':        SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
            'Content-Type':  'application/json',
            ...(opts.headers || {})
        }
    });
    if (!res.ok) throw new Error(`Menu API ${res.status}: ${await res.text()}`);
    const t = await res.text();
    return t ? JSON.parse(t) : null;
}

async function _loadMenuFromSupabase() {
    const rows = await _menuFetch(`${MENU_TABLE}?select=id,name,price,category&order=sort_order.asc`);
    return rows && rows.length ? rows : null;
}

async function _saveMenuToSupabase(items) {
    // Upsert all items with their sort order
    const rows = items.map((item, idx) => ({ ...item, sort_order: idx }));
    await _menuFetch(MENU_TABLE, {
        method:  'POST',
        headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
        body:    JSON.stringify(rows)
    });
    // Delete items that were removed (not in current list)
    const ids = items.map(i => `"${i.id}"`).join(',');
    if (ids) {
        await _menuFetch(`${MENU_TABLE}?id=not.in.(${ids})`, { method: 'DELETE' });
    }
}

// ─── Public API ───────────────────────────────────────────────────────────────

async function loadMenu() {
    try {
        const remote = await _loadMenuFromSupabase();
        if (remote) {
            menuItems = remote;
        } else {
            // First time — seed Supabase with defaults
            menuItems = DEFAULT_MENU.map(i => ({ ...i }));
            await _saveMenuToSupabase(menuItems);
        }
    } catch (e) {
        console.warn('Could not load menu from Supabase, using localStorage fallback:', e);
        const saved = localStorage.getItem('menuItems');
        if (saved) {
            try { menuItems = JSON.parse(saved); } catch (_) { menuItems = DEFAULT_MENU.map(i => ({ ...i })); }
        } else {
            menuItems = DEFAULT_MENU.map(i => ({ ...i }));
        }
    }
    renderHomeMenuInputs();
}

function saveMenu() {
    // Save locally immediately so UI is snappy
    localStorage.setItem('menuItems', JSON.stringify(menuItems));
    // Push to Supabase in background
    _saveMenuToSupabase(menuItems).catch(e => console.error('Menu sync error:', e));
}

function getMenuItems()      { return menuItems; }
function getMenuItem(id)     { return menuItems.find(i => i.id === id); }
function getItemPrice(id)    { const item = getMenuItem(id); return item ? item.price : 0; }

function slugify(name) {
    let base = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    if (!base) base = 'item';
    let id = base, n = 2;
    while (getMenuItem(id)) { id = `${base}_${n}`; n++; }
    return id;
}

function refreshAfterMenuChange() {
    if (typeof renderHomeMenuInputs === 'function') renderHomeMenuInputs();
    const resultsEl = document.getElementById('results');
    if (resultsEl && resultsEl.style.display === 'block' && typeof calculate === 'function') calculate();
    const ratioPanel = document.getElementById('ratioPanel');
    if (ratioPanel && ratioPanel.classList.contains('active') && typeof calculateRatio === 'function') calculateRatio();
}

function addMenuItem() {
    const nameInput  = document.getElementById('newItemName');
    const priceInput = document.getElementById('newItemPrice');
    const typeInput  = document.getElementById('newItemType');

    const name     = nameInput.value.trim();
    const price    = parseFloat(priceInput.value);
    const category = ['skewer','no-kuah','side','side-1kuah','side-none','kuah-only'].includes(typeInput.value) ? typeInput.value : 'skewer';

    if (!name)                    { alert('Please enter a menu item name.'); return; }
    if (isNaN(price) || price < 0){ alert('Please enter a valid price.'); return; }
    if (menuItems.some(i => i.name.toLowerCase() === name.toLowerCase())) {
        alert('A menu item with that name already exists.'); return;
    }

    menuItems.push({ id: slugify(name), name, price, category });
    saveMenu();

    nameInput.value  = '';
    priceInput.value = '';
    typeInput.value  = 'skewer';

    renderSettingsMenuList();
    refreshAfterMenuChange();
    alert(`"${name}" added! 🎉`);
}

function saveMenuItemPrice(id) {
    const input = document.getElementById(`price-${id}`);
    if (!input) return;
    const price = parseFloat(input.value);
    if (isNaN(price) || price < 0) { alert('Please enter a valid price.'); return; }
    const item = getMenuItem(id);
    if (!item) return;
    item.price = price;
    saveMenu();
    refreshAfterMenuChange();
    alert(`Price for "${item.name}" updated!`);
}

function deleteMenuItem(id) {
    const item = getMenuItem(id);
    if (!item) return;
    let warning = `Delete "${item.name}" from the menu?`;
    if (id === 'ayam' || id === 'daging') {
        warning += '\n\nNote: deleting this item will affect the Ratio tab.';
    }
    if (!confirm(warning)) return;
    menuItems = menuItems.filter(i => i.id !== id);
    saveMenu();
    renderSettingsMenuList();
    refreshAfterMenuChange();
}

function resetToDefaultMenu() {
    if (!confirm('Reset menu to defaults? Custom items will be removed.')) return;
    menuItems = DEFAULT_MENU.map(i => ({ ...i }));
    saveMenu();
    renderSettingsMenuList();
    refreshAfterMenuChange();
    alert('Menu reset to default.');
}

function _categoryLabel(cat) {
    return {
        'skewer':      '🍢 Sate (+ kuah kacang)',
        'side':        '🍽️ Side dish (+ 2 kuah)',
        'side-1kuah':  '🍽️ Side dish (+ 1 kuah)',
        'side-none':   '🍽️ Side dish (no kuah)',
        'no-kuah':     '🍖 Sate (tiada kuah kacang)',
        'kuah-only':   '🥜 Kuah kacang sahaja',
    }[cat] || cat;
}

function renderSettingsMenuList() {
    const container = document.getElementById('menuList');
    if (!container) return;
    if (menuItems.length === 0) {
        container.innerHTML = '<p style="text-align:center; color:#999;">No menu items yet.</p>';
        return;
    }

    container.innerHTML = menuItems.map((item, idx) => `
        <div class="menu-row" data-id="${item.id}" data-idx="${idx}" draggable="true">
            <span class="drag-handle" title="Drag to reorder">⠿</span>
            <div class="menu-row-name">
                <span class="item-name">${escapeHtml(item.name)}</span>
                <span class="item-type">${_categoryLabel(item.category)}</span>
            </div>
            <input type="number" id="price-${item.id}" step="0.01" min="0" value="${item.price}">
            <div class="menu-row-actions">
                <button class="small save-btn" onclick="saveMenuItemPrice('${item.id}')" title="Save price">💾</button>
                <button class="small delete-btn" onclick="deleteMenuItem('${item.id}')" title="Delete item">🗑️</button>
            </div>
        </div>
    `).join('');

    _initMenuDragDrop(container);
}

function _initMenuDragDrop(container) {
    let dragSrcIdx = null;
    let touchDragEl = null;
    let touchClone  = null;
    let touchOverIdx = null;

    const rows = () => [...container.querySelectorAll('.menu-row')];

    // ── Mouse drag (desktop) ──────────────────────────────────────────────────
    container.addEventListener('dragstart', e => {
        const row = e.target.closest('.menu-row');
        if (!row) return;
        dragSrcIdx = parseInt(row.dataset.idx);
        row.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
    });

    container.addEventListener('dragover', e => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const row = e.target.closest('.menu-row');
        rows().forEach(r => r.classList.remove('drag-over'));
        if (row) row.classList.add('drag-over');
    });

    container.addEventListener('dragleave', e => {
        const row = e.target.closest('.menu-row');
        if (row) row.classList.remove('drag-over');
    });

    container.addEventListener('dragend', e => {
        rows().forEach(r => { r.classList.remove('dragging'); r.classList.remove('drag-over'); });
    });

    container.addEventListener('drop', e => {
        e.preventDefault();
        const row = e.target.closest('.menu-row');
        if (!row) return;
        const destIdx = parseInt(row.dataset.idx);
        if (dragSrcIdx === null || dragSrcIdx === destIdx) return;
        _reorderMenu(dragSrcIdx, destIdx);
    });

    // ── Touch drag (mobile) ───────────────────────────────────────────────────
    container.addEventListener('touchstart', e => {
        const handle = e.target.closest('.drag-handle');
        if (!handle) return;
        const row = handle.closest('.menu-row');
        if (!row) return;

        dragSrcIdx  = parseInt(row.dataset.idx);
        touchDragEl = row;

        // Create a floating clone to follow the finger
        touchClone = row.cloneNode(true);
        touchClone.style.cssText = `
            position: fixed; z-index: 9999; opacity: 0.85; pointer-events: none;
            width: ${row.offsetWidth}px; box-shadow: 0 4px 16px rgba(0,0,0,0.25);
            border-radius: 14px; background: white;
        `;
        document.body.appendChild(touchClone);
        row.classList.add('dragging');

        const t = e.touches[0];
        touchClone.style.left = (t.clientX - row.offsetWidth / 2) + 'px';
        touchClone.style.top  = (t.clientY - row.offsetHeight / 2) + 'px';
        e.preventDefault();
    }, { passive: false });

    container.addEventListener('touchmove', e => {
        if (!touchClone) return;
        e.preventDefault();
        const t = e.touches[0];
        touchClone.style.left = (t.clientX - touchDragEl.offsetWidth / 2) + 'px';
        touchClone.style.top  = (t.clientY - touchDragEl.offsetHeight / 2) + 'px';

        // Find which row the finger is over
        touchClone.style.display = 'none';
        const elBelow = document.elementFromPoint(t.clientX, t.clientY);
        touchClone.style.display = '';
        const overRow = elBelow && elBelow.closest('.menu-row');
        rows().forEach(r => r.classList.remove('drag-over'));
        if (overRow && overRow !== touchDragEl) {
            overRow.classList.add('drag-over');
            touchOverIdx = parseInt(overRow.dataset.idx);
        } else {
            touchOverIdx = null;
        }
    }, { passive: false });

    container.addEventListener('touchend', e => {
        if (!touchClone) return;
        touchClone.remove();
        touchClone = null;
        rows().forEach(r => { r.classList.remove('dragging'); r.classList.remove('drag-over'); });
        if (touchOverIdx !== null && touchOverIdx !== dragSrcIdx) {
            _reorderMenu(dragSrcIdx, touchOverIdx);
        }
        dragSrcIdx   = null;
        touchOverIdx = null;
    });
}

function _reorderMenu(fromIdx, toIdx) {
    const moved = menuItems.splice(fromIdx, 1)[0];
    menuItems.splice(toIdx, 0, moved);
    saveMenu();
    renderSettingsMenuList();
    if (typeof renderHomeMenuInputs === 'function') renderHomeMenuInputs();
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str == null ? '' : String(str);
    return div.innerHTML;
}
