// menu.js — dynamic menu synced via Supabase (stored in 'menu' table)
// Each item: { id, name, price, category }

const DEFAULT_MENU = [
    { id: 'ayam',     name: 'Ayam',     price: 1.30, category: 'skewer' },
    { id: 'daging',   name: 'Daging',   price: 1.60, category: 'skewer' },
    { id: 'lontong',  name: 'Lontong',  price: 3.00, category: 'side'   },
    { id: 'shortong', name: 'Shortong', price: 2.00, category: 'side'   },
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
    const category = typeInput.value === 'side' ? 'side' : 'skewer';

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

function renderSettingsMenuList() {
    const container = document.getElementById('menuList');
    if (!container) return;
    if (menuItems.length === 0) {
        container.innerHTML = '<p style="text-align:center; color:#999;">No menu items yet.</p>';
        return;
    }
    container.innerHTML = menuItems.map(item => `
        <div class="menu-row">
            <div class="menu-row-name">
                <span class="item-name">${escapeHtml(item.name)}</span>
                <span class="item-type">${item.category === 'skewer' ? '🍢 Sate (skewer)' : '🍽️ Side dish'}</span>
            </div>
            <input type="number" id="price-${item.id}" step="0.01" min="0" value="${item.price}">
            <div class="menu-row-actions">
                <button class="small save-btn" onclick="saveMenuItemPrice('${item.id}')" title="Save price">💾</button>
                <button class="small delete-btn" onclick="deleteMenuItem('${item.id}')" title="Delete item">🗑️</button>
            </div>
        </div>
    `).join('');
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str == null ? '' : String(str);
    return div.innerHTML;
}
