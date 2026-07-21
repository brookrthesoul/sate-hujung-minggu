// app.js — tab switching via native scroll-snap

const TABS = ['home', 'orders', 'preorder', 'ratio', 'settings'];
let currentTabIndex = 0;

function getVP() { return document.getElementById('panelsTrack'); }

// ── Slide to tab by index ─────────────────────────────────────────────────
function slideTo(index, smooth) {
    const vp = getVP();
    vp.scrollTo({ left: index * vp.offsetWidth, behavior: smooth ? 'smooth' : 'instant' });

    document.querySelectorAll('.tab').forEach((t, i) => t.classList.toggle('active', i === index));
    document.querySelectorAll('.panel').forEach((p, i) => p.classList.toggle('active', i === index));

    currentTabIndex = index;
}

// ── Named switchTab (called from HTML onclick) ────────────────────────────
function switchTab(tab) {
    const index = TABS.indexOf(tab);
    if (index === -1) return;
    slideTo(index, true);

    if (tab === 'orders') loadOrders();
    if (tab === 'preorder') loadPreorders();
    if (tab === 'settings') {
        switchSettingsTab('menu');
        // Restore sync bar toggle state
        const stored = localStorage.getItem(SYNC_BAR_KEY);
        const toggle = document.getElementById('syncBarToggle');
        if (toggle) toggle.checked = stored === null ? true : stored === '1';
    }
    if (tab === 'ratio') { updateSliderLabel(); calculateRatio(); }
    if (tab === 'settings') renderSettingsMenuList();
}

// ── Sync tab highlight when user swipes natively ──────────────────────────
(function setupScrollSync() {
    let scrollTimer;
    getVP().addEventListener('scroll', () => {
        clearTimeout(scrollTimer);
        scrollTimer = setTimeout(() => {
            const vp = getVP();
            const index = Math.round(vp.scrollLeft / vp.offsetWidth);
            if (index !== currentTabIndex) {
                currentTabIndex = index;
                document.querySelectorAll('.tab').forEach((t, i) => t.classList.toggle('active', i === index));
                document.querySelectorAll('.panel').forEach((p, i) => p.classList.toggle('active', i === index));
                const tab = TABS[index];
                if (tab === 'orders')   loadOrders();
                if (tab === 'preorder') loadPreorders();
                if (tab === 'ratio')    { if (typeof updateSliderLabel==='function') updateSliderLabel(); if (typeof calculateRatio==='function') calculateRatio(); }
                if (tab === 'settings') {
                    switchSettingsTab('menu');
                    if (typeof initBusyThresholds === 'function') initBusyThresholds();
                    if (typeof initBusinessName   === 'function') initBusinessName();
                    if (typeof initKuahRatio      === 'function') initKuahRatio();
                    if (typeof initPreorderToggle === 'function') initPreorderToggle();
                    const stored = localStorage.getItem(SYNC_BAR_KEY);
                    const toggle = document.getElementById('syncBarToggle');
                    if (toggle) toggle.checked = stored === null ? true : stored === '1';
                    const pStored = localStorage.getItem('shmPasteBoxEnabled');
                    const pToggle = document.getElementById('pasteBoxToggle');
                    if (pToggle) pToggle.checked = pStored === null ? true : pStored === '1';
                }
                if (tab === 'settings') renderSettingsMenuList();
            }
        }, 80);
    }, { passive: true });
})();

// ── Re-snap on resize / orientation change ────────────────────────────────
window.addEventListener('resize', () => slideTo(currentTabIndex, false));

// ── Initial load ──────────────────────────────────────────────────────────
window.onload = () => {
    requestAnimationFrame(() => {
        slideTo(0, false);
        loadMenu();
        renderHomeMenuInputs();
        setupPrinter();
        // Restore dark mode toggle state (class already applied pre-paint by the <head> script)
        initDarkModeToggle();
        // Restore sync bar visibility preference
        initSyncBarToggle();
        // Restore shop open/close toggle
        initShopToggle();
        // Restore busy thresholds
        if (typeof initBusyThresholds === 'function') initBusyThresholds();
        // Restore business name
        if (typeof initBusinessName === 'function') initBusinessName();
        // Restore kuah ratio
        if (typeof initKuahRatio === 'function') initKuahRatio();
        // Restore preorder toggle
        if (typeof initPreorderToggle === 'function') initPreorderToggle();
        // Start preorder → prepare promotion timer
        if (typeof startPreorderTimer === 'function') startPreorderTimer();
        // Restore paste box collapse state
        initPasteBox();
        // Day-close runs after sync in sync.js DOMContentLoaded
    });
};

// ─── Reset all orders ─────────────────────────────────────────────────────────
async function handleResetAllOrders() {
    const input  = document.getElementById('resetConfirmInput');
    const status = document.getElementById('resetStatusMsg');
    if (!input || !status) return;

    if (input.value.trim() !== 'RESET') {
        status.style.color = '#dc3545';
        status.textContent = '⚠️ Please type RESET exactly to confirm.';
        return;
    }

    status.style.color = '#6c757d';
    status.textContent = '⏳ Resetting...';

    try {
        await window._resetAllOrders();
        input.value = '';
        status.style.color = '#28a745';
        status.textContent = '✅ All orders cleared. Order number will restart from #1 after the sequence reset.';
        switchTab('orders');
        switchOrderSubTab('prepare');
    } catch(e) {
        status.style.color = '#dc3545';
        status.textContent = '❌ Reset failed: ' + e.message;
        console.error(e);
    }
}

// ─── Settings sub-tabs ────────────────────────────────────────────────────────
function switchSettingsTab(tab) {
    ['menu','info','others','policies','danger'].forEach(t => {
        document.getElementById(`stab-${t}`).classList.toggle('active', t === tab);
        document.getElementById(`stab-${t}-content`).classList.toggle('active', t === tab);
    });
    if (tab === 'menu') {
        if (typeof renderSettingsMenuList === 'function') renderSettingsMenuList();
        if (typeof renderStockManager    === 'function') renderStockManager();
    }
    if (tab === 'info') {
        if (typeof loadCustomerInfo === 'function') loadCustomerInfo();
    }
    if (tab === 'policies') {
        if (typeof loadPolicies === 'function') loadPolicies();
    }
    if (tab === 'others') {
        if (typeof initBusinessName    === 'function') initBusinessName();
        if (typeof initBusyThresholds  === 'function') initBusyThresholds();
        if (typeof initPreorderToggle  === 'function') initPreorderToggle();
        if (typeof initKuahRatio       === 'function') initKuahRatio();
        // Restore sync bar and paste box toggles
        const stored = localStorage.getItem(SYNC_BAR_KEY);
        const toggle = document.getElementById('syncBarToggle');
        if (toggle) toggle.checked = stored === null ? true : stored === '1';
        const pStored = localStorage.getItem('shmPasteBoxEnabled');
        const pToggle = document.getElementById('pasteBoxToggle');
        if (pToggle) pToggle.checked = pStored === null ? true : pStored === '1';
        const preStored = localStorage.getItem('shmPreorderEnabled');
        const preToggle = document.getElementById('preorderEnabledToggle');
        if (preToggle) preToggle.checked = preStored === null ? true : preStored === '1';
    }
}

// ─── Dark mode toggle ─────────────────────────────────────────────────────────
const DARK_MODE_KEY = 'shmDarkMode';

function setDarkMode(enabled) {
    localStorage.setItem(DARK_MODE_KEY, enabled ? '1' : '0');
    document.documentElement.classList.toggle('dark-mode', enabled);
    const toggle = document.getElementById('darkModeToggle');
    if (toggle) toggle.checked = enabled;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', enabled ? '#1c1c1e' : '#007bff');
}

function initDarkModeToggle() {
    // The <head> script already applied the class before paint; this just syncs the checkbox/meta.
    const enabled = localStorage.getItem(DARK_MODE_KEY) === '1';
    setDarkMode(enabled);
}

// ─── Sync bar toggle ──────────────────────────────────────────────────────────
const SYNC_BAR_KEY = 'shmSyncBarVisible';

function setSyncBarVisible(visible) {
    localStorage.setItem(SYNC_BAR_KEY, visible ? '1' : '0');
    const bar = document.getElementById('syncBar');
    if (bar) bar.style.display = visible ? 'flex' : 'none';
    const toggle = document.getElementById('syncBarToggle');
    if (toggle) toggle.checked = visible;
}

function initSyncBarToggle() {
    const stored = localStorage.getItem(SYNC_BAR_KEY);
    // Default visible (null = not set yet)
    const visible = stored === null ? true : stored === '1';
    setSyncBarVisible(visible);
}

// ─── Paste box collapse/expand + show/hide ───────────────────────────────────
const PASTE_BOX_KEY     = 'shmPasteBoxOpen';
const PASTE_ENABLED_KEY = 'shmPasteBoxEnabled';

function togglePasteBox() {
    const body    = document.getElementById('pasteBoxBody');
    const chevron = document.getElementById('pasteBoxChevron');
    if (!body || !chevron) return;
    const isOpen  = body.style.display !== 'none';
    body.style.display      = isOpen ? 'none' : 'block';
    chevron.style.transform = isOpen ? 'rotate(-90deg)' : 'rotate(0deg)';
    localStorage.setItem(PASTE_BOX_KEY, isOpen ? '0' : '1');
}

function setPasteBoxEnabled(enabled) {
    localStorage.setItem(PASTE_ENABLED_KEY, enabled ? '1' : '0');
    const box = document.getElementById('pasteOrderBox');
    if (box) box.style.display = enabled ? 'block' : 'none';
    const toggle = document.getElementById('pasteBoxToggle');
    if (toggle) toggle.checked = enabled;
}

function initPasteBox() {
    const enabledStored = localStorage.getItem(PASTE_ENABLED_KEY);
    const enabled = enabledStored === null ? true : enabledStored === '1';
    const box = document.getElementById('pasteOrderBox');
    if (box) box.style.display = enabled ? 'block' : 'none';
    const stored  = localStorage.getItem(PASTE_BOX_KEY);
    const isOpen  = stored === null ? true : stored === '1';
    const body    = document.getElementById('pasteBoxBody');
    const chevron = document.getElementById('pasteBoxChevron');
    if (!body || !chevron) return;
    body.style.display      = isOpen ? 'block' : 'none';
    chevron.style.transform = isOpen ? 'rotate(0deg)' : 'rotate(-90deg)';
}

// ─── Shop open/close toggle ───────────────────────────────────────────────────
const SHOP_OPEN_KEY = 'shmShopOpen';

function setShopOpen(isOpen) {
    localStorage.setItem(SHOP_OPEN_KEY, isOpen ? '1' : '0');
    // Sync to Supabase so customer page sees it
    if (typeof window._writeShopStatus === 'function') window._writeShopStatus(isOpen);
    _updateShopUI(isOpen);
}

function _updateShopUI(isOpen) {
    const toggle  = document.getElementById('shopOpenToggle');
    const label   = document.getElementById('shopStatusLabel');
    const banner  = document.getElementById('shopStatusBanner');
    if (!toggle || !label || !banner) return;
    toggle.checked        = isOpen;
    label.textContent     = isOpen ? 'Open' : 'Closed';
    label.style.color     = isOpen ? '#28a745' : '#dc3545';
    banner.style.display  = 'block';
    banner.textContent    = isOpen ? '🟢 We are Open today' : '🔴 We are Closed today';
    banner.style.background = isOpen ? '#d4edda' : '#f8d7da';
    banner.style.color      = isOpen ? '#155724' : '#721c24';
}

function initShopToggle() {
    const stored = localStorage.getItem(SHOP_OPEN_KEY);
    const isOpen = stored === null ? true : stored === '1';
    _updateShopUI(isOpen);
}

// ─── Busy threshold settings ──────────────────────────────────────────────────
const BUSY_THRESHOLD_KEY = 'shmNotBusyMax';

function saveBusyThresholds() {
    const notBusyMax = parseInt(document.getElementById('notBusyMax').value) || 300;
    const busyFrom   = notBusyMax + 1;
    document.getElementById('busyFrom').value = busyFrom;
    localStorage.setItem(BUSY_THRESHOLD_KEY, String(notBusyMax));
    // Sync to Supabase via sync.js
    if (typeof window._writeSetting === 'function') {
        window._writeSetting('notBusyMax', String(notBusyMax));
    }
}

function initBusyThresholds() {
    const stored     = localStorage.getItem(BUSY_THRESHOLD_KEY);
    const notBusyMax = stored ? parseInt(stored) : 300;
    const el         = document.getElementById('notBusyMax');
    const el2        = document.getElementById('busyFrom');
    if (el)  el.value  = notBusyMax;
    if (el2) el2.value = notBusyMax + 1;
}

// ─── Business name setting ────────────────────────────────────────────────────
const BIZ_NAME_KEY = 'shmBusinessName';

function getBusinessName() {
    return localStorage.getItem(BIZ_NAME_KEY) || 'Sate Hujung Minggu';
}



function initBusinessName() {
    const name  = getBusinessName();
    const input = document.getElementById('businessNameInput');
    if (input) input.value = name;
    // Update password screen title
    const pwTitle = document.getElementById('pwScreenTitle');
    if (pwTitle) pwTitle.textContent = name;
    // Update page/document title
    document.title = name;
}

async function saveBusinessName() {
    const input  = document.getElementById('businessNameInput');
    const status = document.getElementById('businessNameStatus');
    const name   = input ? input.value.trim() : '';
    if (!name) { status.style.color = '#dc3545'; status.textContent = '⚠️ Name cannot be empty.'; return; }
    localStorage.setItem(BIZ_NAME_KEY, name);
    initBusinessName();
    // Sync to Supabase
    if (typeof window._writeSetting === 'function') {
        await window._writeSetting('businessName', name);
    }
    status.style.color = '#28a745';
    status.textContent = '✅ Saved!';
    setTimeout(() => { status.textContent = ''; }, 3000);
}

// ─── Kuah kacang ratio setting ────────────────────────────────────────────────
const KUAH_RATIO_KEY = 'shmKuahRatio';

function getKuahRatio() {
    return parseInt(localStorage.getItem(KUAH_RATIO_KEY)) || 10;
}

async function saveKuahRatio() {
    const input  = document.getElementById('kuahRatioInput');
    const status = document.getElementById('kuahRatioStatus');
    const ratio  = parseInt(input.value) || 10;
    if (ratio < 1) { status.style.color = '#dc3545'; status.textContent = '⚠️ Must be at least 1.'; return; }
    localStorage.setItem(KUAH_RATIO_KEY, String(ratio));
    if (typeof window._writeSetting === 'function') {
        await window._writeSetting('kuahRatio', String(ratio));
    }
    status.style.color = '#28a745';
    status.textContent = '✅ Saved!';
    setTimeout(() => { status.textContent = ''; }, 3000);
}

function initKuahRatio() {
    const el = document.getElementById('kuahRatioInput');
    if (el) el.value = getKuahRatio();
}

// ─── Preorder enabled toggle ──────────────────────────────────────────────────
const PREORDER_ENABLED_KEY = 'shmPreorderEnabled';

function setPreorderEnabled(enabled) {
    localStorage.setItem(PREORDER_ENABLED_KEY, enabled ? '1' : '0');
    if (typeof window._writeSetting === 'function') {
        window._writeSetting('preorderEnabled', enabled ? 'true' : 'false');
    }
    // Update toggle UI
    const toggle = document.getElementById('preorderEnabledToggle');
    if (toggle) toggle.checked = enabled;
    console.log('Preorder enabled:', enabled, '→ saved to localStorage and Supabase');
}

function initPreorderToggle() {
    const stored  = localStorage.getItem(PREORDER_ENABLED_KEY);
    const enabled = stored === null ? true : stored === '1';
    const toggle  = document.getElementById('preorderEnabledToggle');
    if (toggle) toggle.checked = enabled;
}
