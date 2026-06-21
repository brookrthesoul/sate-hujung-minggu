// menu.js — dynamic menu: storage, CRUD, and price lookups
//
// Each menu item: { id, name, price, category }
// category is 'skewer' (counted in "Jumlah Cucuk" and uses the /10 sauce-scoop
// formula) or 'side' (uses the *2 sauce-scoop formula). New items pick a
// category when added, so the math stays correct without code changes.

const DEFAULT_MENU = [
    { id: 'ayam',     name: 'Ayam',     price: 1.30, category: 'skewer' },
    { id: 'daging',   name: 'Daging',   price: 1.60, category: 'skewer' },
    { id: 'lontong',  name: 'Lontong',  price: 3.00, category: 'side'   },
    { id: 'shortong', name: 'Shortong', price: 2.00, category: 'side'   },
];

let menuItems = [];

function loadMenu() {
    const saved = localStorage.getItem('menuItems');
    if (saved) {
        try {
            const parsed = JSON.parse(saved);
            menuItems = (Array.isArray(parsed) && parsed.length) ? parsed : DEFAULT_MENU.map(i => ({ ...i }));
        } catch (e) {
            console.warn('Failed to parse saved menu, using defaults');
            menuItems = DEFAULT_MENU.map(i => ({ ...i }));
        }
    } else {
        menuItems = DEFAULT_MENU.map(i => ({ ...i }));
    }
    saveMenu();
}

function saveMenu() {
    localStorage.setItem('menuItems', JSON.stringify(menuItems));
}

function getMenuItems() {
    return menuItems;
}

function getMenuItem(id) {
    return menuItems.find(i => i.id === id);
}

function getItemPrice(id) {
    const item = getMenuItem(id);
    return item ? item.price : 0;
}

function slugify(name) {
    let base = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    if (!base) base = 'item';
    let id = base;
    let n = 2;
    while (getMenuItem(id)) {
        id = `${base}_${n}`;
        n++;
    }
    return id;
}

// Refresh whichever screens are currently showing menu-dependent data
function refreshAfterMenuChange() {
    if (typeof renderHomeMenuInputs === 'function') renderHomeMenuInputs();
    const resultsEl = document.getElementById('results');
    if (resultsEl && resultsEl.style.display === 'block' && typeof calculate === 'function') calculate();
    const ratioPanel = document.getElementById('ratioPanel');
    if (ratioPanel && ratioPanel.classList.contains('active') && typeof calculateRatio === 'function') calculateRatio();
}

function addMenuItem() {
    const nameInput = document.getElementById('newItemName');
    const priceInput = document.getElementById('newItemPrice');
    const typeInput = document.getElementById('newItemType');

    const name = nameInput.value.trim();
    const price = parseFloat(priceInput.value);
    const category = typeInput.value === 'side' ? 'side' : 'skewer';

    if (!name) {
        alert('Please enter a menu item name.');
        return;
    }
    if (isNaN(price) || price < 0) {
        alert('Please enter a valid price.');
        return;
    }
    if (menuItems.some(i => i.name.toLowerCase() === name.toLowerCase())) {
        alert('A menu item with that name already exists.');
        return;
    }

    const id = slugify(name);
    menuItems.push({ id, name, price, category });
    saveMenu();

    nameInput.value = '';
    priceInput.value = '';
    typeInput.value = 'skewer';

    renderSettingsMenuList();
    refreshAfterMenuChange();
    alert(`"${name}" added to the menu! 🎉`);
}

function saveMenuItemPrice(id) {
    const input = document.getElementById(`price-${id}`);
    if (!input) return;
    const price = parseFloat(input.value);
    if (isNaN(price) || price < 0) {
        alert('Please enter a valid price.');
        return;
    }
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
        warning += '\n\nNote: the Allocator (Ratio) tab compares Ayam vs Daging specifically — deleting this item will disable that tab.';
    }
    if (!confirm(warning)) return;

    menuItems = menuItems.filter(i => i.id !== id);
    saveMenu();

    renderSettingsMenuList();
    refreshAfterMenuChange();
}

function resetToDefaultMenu() {
    if (!confirm('Reset the menu to the default 4 items (Ayam, Daging, Lontong, Shortong) and their default prices? Any custom items you added will be removed.')) return;
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
        container.innerHTML = '<p style="text-align:center; color:#999;">No menu items yet. Add one below.</p>';
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

// Small shared HTML-escape helper (also used by orders.js)
function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str == null ? '' : String(str);
    return div.innerHTML;
}
