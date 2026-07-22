// info.js — "Info" settings sub-tab: content shown on the customer page's "Menu" tab
// Stored in the `settings` table under key 'customerInfo' as a JSON string:
//   { header: string,
//     items: [{ id, imageUrl, description, layout, textColor,
//                fontSize, textAlign, bold, italic, textDirection }],
//     otherInfo: string,
//     backgroundType: 'color'|'image', backgroundColor: string, backgroundImage: string }
// item.layout: 'img-left' (picture left, description right) | 'img-right' (picture
//   right, description left) | 'text-only' | 'img-only' (full-width banner) |
//   'img-only-half' (full-width banner, half the height). Defaults to alternating
//   img-left/img-right by row position when not set (keeps older saved data looking
//   the same as before this field existed).
// Text styling fields (ignored for 'img-only'/'img-only-half', which have no text):
//   textColor: hex colour, default '#444444'.
//   fontSize: px as a number, default 14.
//   textAlign: 'left' | 'center' | 'right', default 'left'.
//   bold / italic: booleans, default false.
//   textDirection: 'ltr' | 'rtl' (right-to-left, for Arabic/Hebrew/Urdu etc), default 'ltr'.
// Pictures (item photos + background photo) are uploaded to the public Supabase
// Storage bucket 'customer-info'.

const INFO_STORAGE_BUCKET = 'customer-info';

let customerInfo = {
    header: '', items: [], otherInfo: '',
    backgroundType: 'color',      // 'color' | 'image'
    backgroundColor: '#f5f5f5',
    backgroundImage: ''
};

async function _infoFetch(path, opts = {}) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
        ...opts,
        headers: {
            'apikey':        SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
            'Content-Type':  'application/json',
            ...(opts.headers || {})
        }
    });
    if (!res.ok) throw new Error(`Info API ${res.status}: ${await res.text()}`);
    const t = await res.text();
    return t ? JSON.parse(t) : null;
}

function _infoUid() {
    return 'i_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

// ─── Load / render ──────────────────────────────────────────────────────────
async function loadCustomerInfo() {
    try {
        const rows = await _infoFetch('settings?key=eq.customerInfo&select=value');
        if (rows && rows.length) {
            try { customerInfo = JSON.parse(rows[0].value); } catch (_) { customerInfo = { header: '', items: [], otherInfo: '' }; }
        }
    } catch (e) {
        console.warn('Could not load customer info from Supabase:', e);
    }
    customerInfo.items           = customerInfo.items || [];
    customerInfo.backgroundType  = customerInfo.backgroundType  || 'color';
    customerInfo.backgroundColor = customerInfo.backgroundColor || '#f5f5f5';
    customerInfo.backgroundImage = customerInfo.backgroundImage || '';
    renderInfoTab();
}

function renderInfoTab() {
    const headerInput = document.getElementById('infoHeaderInput');
    const otherInput  = document.getElementById('infoOtherInput');
    if (headerInput) headerInput.value = customerInfo.header || '';
    if (otherInput)  otherInput.value  = customerInfo.otherInfo || '';
    renderInfoItemList();
    renderInfoBackground();
}

// ─── Menu page background (colour or photo) ─────────────────────────────────
function renderInfoBackground() {
    const type = customerInfo.backgroundType || 'color';

    const colorRadio = document.getElementById('infoBgTypeColor');
    const imageRadio = document.getElementById('infoBgTypeImage');
    if (colorRadio) colorRadio.checked = type === 'color';
    if (imageRadio) imageRadio.checked = type === 'image';

    const colorInput = document.getElementById('infoBgColorInput');
    if (colorInput) colorInput.value = customerInfo.backgroundColor || '#f5f5f5';

    const preview  = document.getElementById('infoBgImagePreview');
    const emptyLbl = document.getElementById('infoBgImagePreviewEmpty');
    if (customerInfo.backgroundImage) {
        if (preview)  { preview.src = customerInfo.backgroundImage; preview.style.display = 'block'; }
        if (emptyLbl) emptyLbl.style.display = 'none';
    } else {
        if (preview)  { preview.src = ''; preview.style.display = 'none'; }
        if (emptyLbl) emptyLbl.style.display = 'block';
    }

    const colorBox = document.getElementById('infoBgColorBox');
    const imageBox = document.getElementById('infoBgImageBox');
    if (colorBox) colorBox.style.display = type === 'color' ? 'flex'  : 'none';
    if (imageBox) imageBox.style.display = type === 'image' ? 'block' : 'none';
}

function setInfoBgType(type) {
    customerInfo.backgroundType = type === 'image' ? 'image' : 'color';
    renderInfoBackground();
}

function updateInfoBgColor(value) {
    customerInfo.backgroundColor = value;
}

async function handleInfoBgImageUpload(fileInput) {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;

    const btn = document.getElementById('infoBgUploadBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Uploading...'; }

    try {
        const ext  = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
        const path = `bg_${Date.now()}.${ext}`;
        const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${INFO_STORAGE_BUCKET}/${path}`, {
            method: 'POST',
            headers: {
                'apikey':        SUPABASE_ANON_KEY,
                'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
                'Content-Type':  file.type || 'image/jpeg',
                'x-upsert':      'true'
            },
            body: file
        });
        if (!res.ok) throw new Error(await res.text());

        customerInfo.backgroundImage = `${SUPABASE_URL}/storage/v1/object/public/${INFO_STORAGE_BUCKET}/${path}`;
        renderInfoBackground();
    } catch (e) {
        alert('❌ Background photo upload failed: ' + e.message);
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '📤 Upload Photo'; }
        fileInput.value = '';
    }
}

function removeInfoBgImage() {
    customerInfo.backgroundImage = '';
    renderInfoBackground();
}

function renderInfoItemList() {
    const container = document.getElementById('infoItemList');
    if (!container) return;
    if (customerInfo.items.length === 0) {
        container.innerHTML = '<p style="text-align:center; color:#999;">No items yet. Tap "Add Item" below.</p>';
        return;
    }
    container.innerHTML = customerInfo.items.map((item, idx) => {
        const layout      = item.layout || (idx % 2 === 0 ? 'img-left' : 'img-right');
        const textColor   = item.textColor || '#444444';
        const fontSize    = item.fontSize || 14;
        const textAlign   = item.textAlign || 'left';
        const bold        = !!item.bold;
        const italic      = !!item.italic;
        const textDir     = item.textDirection || 'ltr';
        const isImgOnly   = layout === 'img-only' || layout === 'img-only-half';
        const showPhoto   = layout !== 'text-only';
        const showText    = !isImgOnly;

        // The preview box mirrors the real aspect ratio each layout renders at on the
        // customer page, so what you see here in Settings matches the real result —
        // square for picture-left/right, wide banners for the picture-only layouts.
        let photoBoxStyle, photoBoxWrapStyle;
        if (isImgOnly) {
            const ratio = layout === 'img-only-half' ? '16 / 5' : '16 / 10';
            photoBoxWrapStyle = 'width:100%;';
            photoBoxStyle = `width:100%;aspect-ratio:${ratio};border-radius:10px;overflow:hidden;background:#eee;display:flex;align-items:center;justify-content:center;`;
        } else {
            photoBoxWrapStyle = 'display:flex;flex-direction:column;align-items:center;gap:6px;flex-shrink:0;';
            photoBoxStyle = 'width:84px;height:84px;border-radius:10px;overflow:hidden;background:#eee;display:flex;align-items:center;justify-content:center;';
        }

        const photoBlock = showPhoto ? `
            <div style="${photoBoxWrapStyle}">
                <div style="${photoBoxStyle}">
                    ${item.imageUrl
                        ? `<img src="${item.imageUrl}" alt="" style="width:100%;height:100%;object-fit:cover;">`
                        : `<span style="font-size:11px;color:#999;">No photo</span>`}
                </div>
                <input type="file" accept="image/*" id="infoFile-${item.id}" style="display:none;"
                    onchange="handleInfoImageUpload('${item.id}', this)">
                <button class="small" id="infoUploadBtn-${item.id}" style="margin:${isImgOnly ? '6px 0 0' : '0'};padding:6px 10px;font-size:12px;"
                    onclick="document.getElementById('infoFile-${item.id}').click()">
                    ${item.imageUrl ? '🔄 Change' : '📤 Upload'}
                </button>
            </div>` : '';

        const textBlock = showText ? `
            <div style="flex:1;min-width:160px;">
                <textarea rows="3" placeholder="Description..." id="infoDesc-${item.id}"
                    style="width:100%;padding:8px;border:1px solid #ddd;border-radius:8px;font-size:13px;resize:vertical;font-family:inherit;"
                    oninput="updateInfoDescription('${item.id}', this.value)">${escapeHtml(item.description || '')}</textarea>

                <div style="display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-top:8px;">
                    <label style="font-size:11px;color:#999;">Colour:</label>
                    <input type="color" value="${textColor}" onchange="updateInfoTextColor('${item.id}', this.value)"
                        style="width:32px;height:24px;padding:1px;border-radius:6px;border:1px solid #ddd;cursor:pointer;">

                    <label style="font-size:11px;color:#999;margin-left:4px;">Size:</label>
                    <select onchange="updateInfoFontSize('${item.id}', this.value)" style="padding:4px 6px;border:1px solid #ddd;border-radius:6px;font-size:11px;">
                        <option value="12" ${fontSize == 12 ? 'selected' : ''}>Small</option>
                        <option value="14" ${fontSize == 14 ? 'selected' : ''}>Medium</option>
                        <option value="17" ${fontSize == 17 ? 'selected' : ''}>Large</option>
                        <option value="21" ${fontSize == 21 ? 'selected' : ''}>X-Large</option>
                    </select>

                    <label style="font-size:11px;color:#999;margin-left:4px;">Align:</label>
                    <select onchange="updateInfoTextAlign('${item.id}', this.value)" style="padding:4px 6px;border:1px solid #ddd;border-radius:6px;font-size:11px;">
                        <option value="left"   ${textAlign === 'left'   ? 'selected' : ''}>⬅ Left</option>
                        <option value="center" ${textAlign === 'center' ? 'selected' : ''}>↔ Center</option>
                        <option value="right"  ${textAlign === 'right'  ? 'selected' : ''}>➡ Right</option>
                    </select>

                    <label style="font-size:11px;color:#999;margin-left:4px;">Direction:</label>
                    <select onchange="updateInfoTextDirection('${item.id}', this.value)" style="padding:4px 6px;border:1px solid #ddd;border-radius:6px;font-size:11px;">
                        <option value="ltr" ${textDir === 'ltr' ? 'selected' : ''}>→ Left-to-right</option>
                        <option value="rtl" ${textDir === 'rtl' ? 'selected' : ''}>← Right-to-left</option>
                    </select>

                    <label style="display:flex;align-items:center;gap:3px;font-size:11px;color:#555;margin-left:4px;">
                        <input type="checkbox" ${bold ? 'checked' : ''} onchange="updateInfoBold('${item.id}', this.checked)"><b>Bold</b>
                    </label>
                    <label style="display:flex;align-items:center;gap:3px;font-size:11px;color:#555;">
                        <input type="checkbox" ${italic ? 'checked' : ''} onchange="updateInfoItalic('${item.id}', this.checked)"><i>Italic</i>
                    </label>
                </div>
            </div>` : '';

        return `
        <div class="menu-row" style="align-items:flex-start;flex-wrap:wrap;flex-direction:column;gap:10px;" data-info-id="${item.id}">
            <div style="display:flex;align-items:center;gap:8px;width:100%;">
                <label style="font-size:12px;font-weight:600;color:#555;flex-shrink:0;">Layout:</label>
                <select onchange="updateInfoItemLayout('${item.id}', this.value)" style="flex:1;padding:6px 8px;border:1px solid #ddd;border-radius:8px;font-size:12px;">
                    <option value="img-left"      ${layout === 'img-left'      ? 'selected' : ''}>🖼️➡️📝 Picture left, description right</option>
                    <option value="img-right"     ${layout === 'img-right'     ? 'selected' : ''}>📝➡️🖼️ Picture right, description left</option>
                    <option value="text-only"     ${layout === 'text-only'     ? 'selected' : ''}>📝 Text only</option>
                    <option value="img-only"      ${layout === 'img-only'      ? 'selected' : ''}>🖼️ Picture only (banner)</option>
                    <option value="img-only-half" ${layout === 'img-only-half' ? 'selected' : ''}>🖼️ Picture only (short banner)</option>
                </select>
                <button class="small delete-btn" style="margin:0;padding:6px 10px;flex-shrink:0;" title="Delete item"
                    onclick="deleteInfoItem('${item.id}')">🗑️</button>
            </div>
            <div style="display:flex;gap:12px;width:100%;flex-wrap:wrap;">
                ${photoBlock}
                ${textBlock}
            </div>
            <div style="font-size:11px;color:#999;">Row ${idx + 1}</div>
        </div>
    `;}).join('');
}

function updateInfoItemLayout(id, value) {
    const item = customerInfo.items.find(i => i.id === id);
    if (item) item.layout = value;
    renderInfoItemList();
}

function updateInfoTextColor(id, value) {
    const item = customerInfo.items.find(i => i.id === id);
    if (item) item.textColor = value;
}

function updateInfoFontSize(id, value) {
    const item = customerInfo.items.find(i => i.id === id);
    if (item) item.fontSize = parseInt(value) || 14;
}

function updateInfoTextAlign(id, value) {
    const item = customerInfo.items.find(i => i.id === id);
    if (item) item.textAlign = value;
}

function updateInfoBold(id, checked) {
    const item = customerInfo.items.find(i => i.id === id);
    if (item) item.bold = !!checked;
}

function updateInfoItalic(id, checked) {
    const item = customerInfo.items.find(i => i.id === id);
    if (item) item.italic = !!checked;
}

function updateInfoTextDirection(id, value) {
    const item = customerInfo.items.find(i => i.id === id);
    if (item) item.textDirection = value;
}

// ─── Item editing ────────────────────────────────────────────────────────────
function addInfoItem() {
    const layout = customerInfo.items.length % 2 === 0 ? 'img-left' : 'img-right';
    customerInfo.items.push({
        id: _infoUid(), imageUrl: '', description: '', layout,
        textColor: '#444444', fontSize: 14, textAlign: 'left',
        bold: false, italic: false, textDirection: 'ltr'
    });
    renderInfoItemList();
}

function deleteInfoItem(id) {
    if (!confirm('Remove this item?')) return;
    customerInfo.items = customerInfo.items.filter(i => i.id !== id);
    renderInfoItemList();
}

function updateInfoDescription(id, value) {
    const item = customerInfo.items.find(i => i.id === id);
    if (item) item.description = value;
}

async function handleInfoImageUpload(id, fileInput) {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    const item = customerInfo.items.find(i => i.id === id);
    if (!item) return;

    const btn = document.getElementById(`infoUploadBtn-${id}`);
    if (btn) { btn.disabled = true; btn.textContent = 'Uploading...'; }

    try {
        const ext  = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
        const path = `${id}_${Date.now()}.${ext}`;
        const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${INFO_STORAGE_BUCKET}/${path}`, {
            method: 'POST',
            headers: {
                'apikey':        SUPABASE_ANON_KEY,
                'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
                'Content-Type':  file.type || 'image/jpeg',
                'x-upsert':      'true'
            },
            body: file
        });
        if (!res.ok) throw new Error(await res.text());

        item.imageUrl = `${SUPABASE_URL}/storage/v1/object/public/${INFO_STORAGE_BUCKET}/${path}`;
        renderInfoItemList();
    } catch (e) {
        alert('❌ Photo upload failed: ' + e.message);
        if (btn) { btn.disabled = false; btn.textContent = item.imageUrl ? '🔄 Change' : '📤 Upload'; }
    }
}

// ─── Save ────────────────────────────────────────────────────────────────────
async function saveCustomerInfo() {
    const headerInput = document.getElementById('infoHeaderInput');
    const otherInput  = document.getElementById('infoOtherInput');
    const status      = document.getElementById('infoSaveStatus');

    customerInfo.header    = headerInput ? headerInput.value.trim() : '';
    customerInfo.otherInfo = otherInput  ? otherInput.value.trim()  : '';
    // Descriptions are kept in sync live via updateInfoDescription(), items already up to date.

    if (status) { status.style.color = '#6c757d'; status.textContent = '⏳ Saving...'; }

    try {
        await _infoFetch('settings', {
            method:  'POST',
            headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
            body:    JSON.stringify({ key: 'customerInfo', value: JSON.stringify(customerInfo) })
        });
        if (status) { status.style.color = '#28a745'; status.textContent = '✅ Saved! Customers will see this on the Menu tab.'; }
    } catch (e) {
        if (status) { status.style.color = '#dc3545'; status.textContent = '❌ Save failed: ' + e.message; }
    }
}
