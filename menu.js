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
    const rows = await _menuFetch(`${MENU_TABLE}?select=id,name,price,category,unitLabel:unit_label,bgImage:bg_image,bgColor:bg_color,textColor:text_color&order=sort_order.asc`);
    return rows && rows.length ? rows : null;
}

async function _saveMenuToSupabase(items) {
    // Upsert all items with their sort order. Map camelCase JS fields to the
    // actual snake_case DB column names (PostgREST needs exact column names
    // on write — aliases only work for reads).
    const rows = items.map((item, idx) => ({
        id:         item.id,
        name:       item.name,
        price:      item.price,
        category:   item.category,
        unit_label: item.unitLabel || null,
        bg_image:   item.bgImage   || null,
        bg_color:   item.bgColor   || null,
        text_color: item.textColor || null,
        sort_order: idx
    }));
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
    updateSkewerSystemVisibility();
}

// Hides the Ratio tab and the Kuah Kacang Ratio setting for shops whose menu
// doesn't use the skewer/kuah system at all (e.g. a bakery selling only
// custom-unit items) — no point showing controls for a system they don't use.
function updateSkewerSystemVisibility() {
    const usesSkewerSystem = menuUsesSkewerSystem();

    const ratioTabBtn = document.getElementById('tabRatioBtn');
    if (ratioTabBtn) ratioTabBtn.style.display = usesSkewerSystem ? '' : 'none';

    const kuahRatioGroup = document.getElementById('kuahRatioSettingGroup');
    if (kuahRatioGroup) kuahRatioGroup.style.display = usesSkewerSystem ? '' : 'none';

    // If the Ratio tab is currently open but just got hidden, send them back to Home
    if (!usesSkewerSystem && ratioTabBtn && ratioTabBtn.classList.contains('active')) {
        if (typeof switchTab === 'function') switchTab('home');
    }
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

// Categories that participate in the skewer / kuah-kacang scoop system.
const SKEWER_SYSTEM_CATEGORIES = ['skewer', 'no-kuah', 'side', 'side-1kuah', 'kuah-only'];

// True if the menu has at least one item using the skewer/kuah system.
// Used to hide the Ratio tab, the Kuah Ratio setting, and the "Jumlah Cucuk" /
// "Jumlah Kuah Kacang" lines for shops whose menu is entirely custom-unit
// items (e.g. a bakery) — so those shops aren't shown irrelevant "0" lines
// everywhere.
function menuUsesSkewerSystem() {
    return menuItems.some(i => SKEWER_SYSTEM_CATEGORIES.includes(i.category));
}

function slugify(name) {
    let base = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    if (!base) base = 'item';
    let id = base, n = 2;
    while (getMenuItem(id)) { id = `${base}_${n}`; n++; }
    return id;
}

function refreshAfterMenuChange() {
    if (typeof renderHomeMenuInputs === 'function') renderHomeMenuInputs();
    updateSkewerSystemVisibility();
    const summaryModal = document.getElementById('orderSummaryModal');
    if (summaryModal && summaryModal.style.display === 'flex' && typeof reviewOrder === 'function') reviewOrder();
    const ratioPanel = document.getElementById('ratioPanel');
    if (ratioPanel && ratioPanel.classList.contains('active') && typeof calculateRatio === 'function') calculateRatio();
}

function toggleNewItemUnitLabel() {
    const typeInput = document.getElementById('newItemType');
    const group     = document.getElementById('newItemUnitLabelGroup');
    if (!typeInput || !group) return;
    group.style.display = typeInput.value === 'custom-unit' ? 'block' : 'none';
}

function addMenuItem() {
    const nameInput     = document.getElementById('newItemName');
    const priceInput    = document.getElementById('newItemPrice');
    const typeInput     = document.getElementById('newItemType');
    const unitInput     = document.getElementById('newItemUnitLabel');

    const name     = nameInput.value.trim();
    const price    = parseFloat(priceInput.value);
    const category = ['skewer','no-kuah','side','side-1kuah','side-none','kuah-only','custom-unit'].includes(typeInput.value) ? typeInput.value : 'skewer';

    if (!name)                    { alert('Please enter a menu item name.'); return; }
    if (isNaN(price) || price < 0){ alert('Please enter a valid price.'); return; }
    if (menuItems.some(i => i.name.toLowerCase() === name.toLowerCase())) {
        alert('A menu item with that name already exists.'); return;
    }

    const newItem = { id: slugify(name), name, price, category };
    if (category === 'custom-unit') {
        newItem.unitLabel = (unitInput && unitInput.value.trim()) || 'pcs';
    }
    menuItems.push(newItem);
    saveMenu();

    nameInput.value  = '';
    priceInput.value = '';
    typeInput.value  = 'skewer';
    if (unitInput) unitInput.value = '';
    if (typeof toggleNewItemUnitLabel === 'function') toggleNewItemUnitLabel();

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

    if (item.category === 'custom-unit') {
        const unitInput = document.getElementById(`unit-${id}`);
        const unit = unitInput ? unitInput.value.trim() : '';
        item.unitLabel = unit || 'pcs';
    }

    saveMenu();
    refreshAfterMenuChange();
    alert(`"${item.name}" updated!`);
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
        'custom-unit': '📦 Custom unit',
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
            ${item.category === 'custom-unit' ? `
                <input type="text" id="unit-${item.id}" value="${escapeHtml(item.unitLabel || 'pcs')}" placeholder="unit"
                    style="width:64px;flex-shrink:0;" title="Unit label shown on orders/receipts, e.g. slice, pcs, whole">
            ` : ''}
            <input type="number" id="price-${item.id}" step="0.01" min="0" value="${item.price}">
            <div class="menu-row-actions">
                <button class="small save-btn" onclick="saveMenuItemPrice('${item.id}')" title="Save price${item.category === 'custom-unit' ? ' & unit' : ''}">💾</button>
                <button class="small style-btn" onclick="openItemStyleEditor('${item.id}')" title="Customize button background & text colour">🎨</button>
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

// ── Item button style editor (Settings → Menu → 🎨) ─────────────────────────
// Lets each menu item's New Order button carry its own background (an
// uploaded image or a solid colour) and its own text colour, so branding
// stays readable no matter what's behind the text. Edits are held in draft
// variables until Save — Cancel just discards them, same pattern as the
// Qty Editor popup.
let _styleEditorItemId          = null;
let _styleEditorBgImage         = null; // data URL or null
let _styleEditorBgColor         = null; // hex or null
let _styleEditorTextColor       = null; // hex or null
let _styleEditorImageLuminance  = null; // 0–1, cached from the freshest upload this session

const ITEM_STYLE_MAX_W = 320; // uploaded images are downscaled to roughly button-sized
const ITEM_STYLE_MAX_H = 200; // before being stored, so the DB never holds full-res photos

function openItemStyleEditor(id) {
    const item = getMenuItem(id);
    if (!item) return;
    _styleEditorItemId         = id;
    _styleEditorBgImage        = item.bgImage   || null;
    _styleEditorBgColor        = item.bgColor   || null;
    _styleEditorTextColor      = item.textColor || null;
    _styleEditorImageLuminance = null;

    document.getElementById('styleEditorItemName').textContent   = item.name;
    document.getElementById('styleBgColorInput').value   = _styleEditorBgColor   || '#f8f9fa';
    document.getElementById('styleTextColorInput').value = _styleEditorTextColor || '#222222';
    const fileInput = document.getElementById('styleImageInput');
    if (fileInput) fileInput.value = '';

    _refreshStyleEditorPreview();
    if (typeof showModalById === 'function') showModalById('itemStyleModal');
}

function handleStyleImageUpload(fileInput) {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) { alert('Please choose an image file.'); return; }

    const reader = new FileReader();
    reader.onload = e => {
        const img = new Image();
        img.onload = () => {
            // Cover-fit resize down to roughly button size, so every stored image
            // is small and consistent regardless of what was originally uploaded.
            let { width, height } = img;
            const scale = Math.min(ITEM_STYLE_MAX_W / width, ITEM_STYLE_MAX_H / height, 1);
            width  = Math.max(1, Math.round(width  * scale));
            height = Math.max(1, Math.round(height * scale));
            const canvas = document.createElement('canvas');
            canvas.width = width; canvas.height = height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, width, height);

            _styleEditorBgImage        = canvas.toDataURL('image/jpeg', 0.78);
            _styleEditorImageLuminance = _computeCanvasLuminance(ctx, width, height);
            _refreshStyleEditorPreview();
        };
        img.onerror = () => alert('Could not read that image — please try a different file.');
        img.src = e.target.result;
    };
    reader.readAsDataURL(file);
}

function clearStyleImage() {
    _styleEditorBgImage        = null;
    _styleEditorImageLuminance = null;
    const fileInput = document.getElementById('styleImageInput');
    if (fileInput) fileInput.value = '';
    _refreshStyleEditorPreview();
}

function onStyleBgColorChange() {
    _styleEditorBgColor = document.getElementById('styleBgColorInput').value;
    _refreshStyleEditorPreview();
}
function clearStyleBgColor() {
    _styleEditorBgColor = null;
    _refreshStyleEditorPreview();
}
function onStyleTextColorChange() {
    _styleEditorTextColor = document.getElementById('styleTextColorInput').value;
    _refreshStyleEditorPreview();
}
function clearStyleTextColor() {
    _styleEditorTextColor = null;
    _refreshStyleEditorPreview();
}

// Suggests black or white text based on how bright the current background is
// — a starting point, not a guarantee; the live preview above it is the real
// check for whether it's actually readable.
function autoPickStyleTextColor() {
    let luminance = 0.5; // neutral guess when we have no better signal
    if (_styleEditorBgImage && _styleEditorImageLuminance != null) {
        luminance = _styleEditorImageLuminance;
    } else if (_styleEditorBgColor) {
        luminance = _hexLuminance(_styleEditorBgColor);
    }
    const suggested = luminance > 0.55 ? '#1a1a1a' : '#ffffff';
    _styleEditorTextColor = suggested;
    document.getElementById('styleTextColorInput').value = suggested;
    _refreshStyleEditorPreview();
}

function _hexLuminance(hex) {
    const c = (hex || '').replace('#', '');
    if (c.length !== 6) return 0.5;
    const r = parseInt(c.substr(0, 2), 16) / 255;
    const g = parseInt(c.substr(2, 2), 16) / 255;
    const b = parseInt(c.substr(4, 2), 16) / 255;
    return 0.299 * r + 0.587 * g + 0.114 * b;
}

function _computeCanvasLuminance(ctx, w, h) {
    try {
        const data = ctx.getImageData(0, 0, w, h).data;
        let total = 0, count = 0;
        // Sample every ~10th pixel — plenty accurate for a rough estimate, much faster than every pixel.
        for (let i = 0; i < data.length; i += 40) {
            total += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
            count++;
        }
        return count ? (total / count) / 255 : 0.5;
    } catch (e) {
        return 0.5; // shouldn't happen for a local file, but don't let it break the picker
    }
}

function _refreshStyleEditorPreview() {
    const item = getMenuItem(_styleEditorItemId);
    if (!item) return;
    const preview = document.getElementById('styleEditorPreview');
    if (!preview) return;

    preview.style.backgroundImage    = _styleEditorBgImage ? `url('${_styleEditorBgImage}')` : '';
    preview.style.backgroundSize     = 'cover';
    preview.style.backgroundPosition = 'center';
    preview.style.backgroundColor    = _styleEditorBgImage ? 'transparent' : (_styleEditorBgColor || '#f8f9fa');

    const nameEl  = document.getElementById('styleEditorPreviewName');
    const priceEl = document.getElementById('styleEditorPreviewPrice');
    if (nameEl)  { nameEl.textContent  = item.name;               nameEl.style.color  = _styleEditorTextColor || ''; }
    if (priceEl) { priceEl.textContent = formatRM(item.price);    priceEl.style.color = _styleEditorTextColor || ''; }

    const imgWrap = document.getElementById('styleImagePreviewWrap');
    const imgThumb = document.getElementById('styleImagePreviewThumb');
    if (imgWrap)  imgWrap.style.display = _styleEditorBgImage ? 'flex' : 'none';
    if (imgThumb) imgThumb.src = _styleEditorBgImage || '';
}

function cancelItemStyle() {
    if (typeof hideModalById === 'function') hideModalById('itemStyleModal');
    _styleEditorItemId = null;
    _styleEditorImageLuminance = null;
}

function saveItemStyle() {
    const item = getMenuItem(_styleEditorItemId);
    if (!item) return;
    if (_styleEditorBgImage)   item.bgImage   = _styleEditorBgImage;   else delete item.bgImage;
    if (_styleEditorBgColor)   item.bgColor   = _styleEditorBgColor;   else delete item.bgColor;
    if (_styleEditorTextColor) item.textColor = _styleEditorTextColor; else delete item.textColor;

    saveMenu();
    if (typeof hideModalById === 'function') hideModalById('itemStyleModal');
    refreshAfterMenuChange();
    _styleEditorItemId = null;
    _styleEditorImageLuminance = null;
}

// Builds the inline style for one item's New Order button from its saved
// bgImage/bgColor/textColor — shared shape used by both the admin grid
// (orders.js) and the customer grid (order.html).
function menuItemButtonInlineStyle(item) {
    let css = '';
    if (item.bgImage)      css += `background-image:url('${item.bgImage}');background-size:cover;background-position:center;`;
    else if (item.bgColor) css += `background-color:${item.bgColor};`;
    if (item.textColor)    css += `--item-text-color:${item.textColor};`;
    return css;
}
