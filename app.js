// app.js — tab switching with swipe support

const TABS = ['home', 'orders', 'ratio', 'settings'];
let currentTabIndex = 0;

// ── Slide to a tab index ──────────────────────────────────────────────────
function slideTo(index) {
    const track = document.getElementById('panelsTrack');
    const panelWidth = track.parentElement.offsetWidth; // viewport width in px
    track.style.transform = `translateX(${-index * panelWidth}px)`;

    document.querySelectorAll('.tab').forEach((t, i) => t.classList.toggle('active', i === index));
    document.querySelectorAll('.panel').forEach((p, i) => p.classList.toggle('active', i === index));

    currentTabIndex = index;
}

// ── Named switchTab (called from HTML onclick) ────────────────────────────
function switchTab(tab) {
    const index = TABS.indexOf(tab);
    if (index === -1) return;
    slideTo(index);

    if (tab === 'orders') loadOrders();
    if (tab === 'ratio') { updateSliderLabel(); calculateRatio(); }
    if (tab === 'settings') renderSettingsMenuList();
}

// ── Re-snap on resize (orientation change, etc.) ──────────────────────────
window.addEventListener('resize', () => slideTo(currentTabIndex));

// ── Swipe / drag support ──────────────────────────────────────────────────
(function setupSwipe() {
    const track = document.getElementById('panelsTrack');
    let startX = 0, startY = 0, deltaX = 0;
    let isSwiping = false;
    let isVertical = null;
    const THRESHOLD = 50; // px to commit a swipe

    function panelWidth() {
        return track.parentElement.offsetWidth;
    }

    function onStart(x, y) {
        startX = x; startY = y; deltaX = 0;
        isSwiping = true; isVertical = null;
        track.classList.add('dragging');
    }

    function onMove(x, y) {
        if (!isSwiping) return;
        const dx = x - startX;
        const dy = y - startY;

        if (isVertical === null && (Math.abs(dx) > 5 || Math.abs(dy) > 5)) {
            isVertical = Math.abs(dy) > Math.abs(dx);
        }
        if (isVertical) {
            track.classList.remove('dragging');
            isSwiping = false;
            return;
        }

        deltaX = dx;
        const base = currentTabIndex * panelWidth();
        // Rubber-band at edges
        let offset = deltaX;
        if ((currentTabIndex === 0 && deltaX > 0) || (currentTabIndex === TABS.length - 1 && deltaX < 0)) {
            offset = deltaX / 3;
        }
        track.style.transform = `translateX(${-base + offset}px)`;
    }

    function onEnd() {
        if (!isSwiping) return;
        track.classList.remove('dragging');
        isSwiping = false;

        let next = currentTabIndex;
        if (deltaX < -THRESHOLD && currentTabIndex < TABS.length - 1) next = currentTabIndex + 1;
        else if (deltaX > THRESHOLD && currentTabIndex > 0) next = currentTabIndex - 1;

        slideTo(next);

        // Side effects when swiping (not tapping tab)
        const newTab = TABS[next];
        if (newTab === 'orders') loadOrders();
        if (newTab === 'ratio') { updateSliderLabel(); calculateRatio(); }
        if (newTab === 'settings') renderSettingsMenuList();
    }

    // Touch
    track.addEventListener('touchstart', e => {
        const t = e.touches[0];
        onStart(t.clientX, t.clientY);
    }, { passive: true });
    track.addEventListener('touchmove', e => {
        const t = e.touches[0];
        onMove(t.clientX, t.clientY);
    }, { passive: true });
    track.addEventListener('touchend', onEnd);
    track.addEventListener('touchcancel', onEnd);

    // Mouse (desktop)
    track.addEventListener('mousedown', e => {
        if (['INPUT','BUTTON','SELECT','TEXTAREA','A'].includes(e.target.tagName)) return;
        onStart(e.clientX, e.clientY);
        e.preventDefault();
    });
    window.addEventListener('mousemove', e => { if (isSwiping) onMove(e.clientX, e.clientY); });
    window.addEventListener('mouseup', () => { if (isSwiping) onEnd(); });
})();

// ── Initial load ──────────────────────────────────────────────────────────
window.onload = () => {
    slideTo(0);
    loadMenu();
    renderHomeMenuInputs();
    setupPrinter();
};
