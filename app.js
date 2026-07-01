// app.js — tab switching via native scroll-snap

const TABS = ['home', 'orders', 'ratio', 'settings'];
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
                if (tab === 'orders') loadOrders();
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
        // Restore sync bar visibility preference
        initSyncBarToggle();
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
    ['menu','others','danger'].forEach(t => {
        document.getElementById(`stab-${t}`).classList.toggle('active', t === tab);
        document.getElementById(`stab-${t}-content`).classList.toggle('active', t === tab);
    });
    if (tab === 'menu') {
        if (typeof renderSettingsMenuList === 'function') renderSettingsMenuList();
        if (typeof renderStockManager    === 'function') renderStockManager();
    }
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

// ─── Paste box collapse/expand ────────────────────────────────────────────────
const PASTE_BOX_KEY = 'shmPasteBoxOpen';

function togglePasteBox() {
    const body    = document.getElementById('pasteBoxBody');
    const chevron = document.getElementById('pasteBoxChevron');
    const isOpen  = body.style.display !== 'none';
    body.style.display    = isOpen ? 'none' : 'block';
    chevron.style.transform = isOpen ? 'rotate(-90deg)' : 'rotate(0deg)';
    localStorage.setItem(PASTE_BOX_KEY, isOpen ? '0' : '1');
}

function initPasteBox() {
    const stored  = localStorage.getItem(PASTE_BOX_KEY);
    const isOpen  = stored === null ? true : stored === '1';
    const body    = document.getElementById('pasteBoxBody');
    const chevron = document.getElementById('pasteBoxChevron');
    if (!body || !chevron) return;
    body.style.display      = isOpen ? 'block' : 'none';
    chevron.style.transform = isOpen ? 'rotate(0deg)' : 'rotate(-90deg)';
}
