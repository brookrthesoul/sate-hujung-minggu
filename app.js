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
        if (typeof renderSettingsMenuList === 'function') renderSettingsMenuList();
        if (typeof renderStockManager    === 'function') renderStockManager();
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
        if (typeof renderSettingsMenuList === 'function') renderSettingsMenuList();
        if (typeof renderStockManager    === 'function') renderStockManager();
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
        // Day-close runs after sync in sync.js DOMContentLoaded
    });
};
