// app.js — tab switching with swipe support

const TABS = ['home', 'orders', 'ratio', 'settings'];
let currentTabIndex = 0;

// ── Slide to a tab index ──────────────────────────────────────────────────
function slideTo(index) {
    const track = document.getElementById('panelsTrack');
    track.style.transform = `translateX(-${index * 100}%)`;

    // Update active class on tabs and panels
    document.querySelectorAll('.tab').forEach((t, i) => t.classList.toggle('active', i === index));
    document.querySelectorAll('.panel').forEach((p, i) => p.classList.toggle('active', i === index));

    currentTabIndex = index;
}

// ── Named switchTab (called from HTML onclick) ────────────────────────────
function switchTab(tab) {
    const index = TABS.indexOf(tab);
    if (index === -1) return;
    slideTo(index);

    // Side effects per tab
    if (tab === 'orders') loadOrders();
    if (tab === 'ratio') { updateSliderLabel(); calculateRatio(); }
    if (tab === 'settings') renderSettingsMenuList();
}

// ── Swipe / drag support ─────────────────────────────────────────────────
(function setupSwipe() {
    const track = document.getElementById('panelsTrack');
    let startX = 0, startY = 0, deltaX = 0;
    let isSwiping = false;
    let isVertical = null;   // resolved after first few px of movement
    const THRESHOLD = 50;    // px to commit a swipe

    function onStart(x, y) {
        startX = x; startY = y; deltaX = 0;
        isSwiping = true; isVertical = null;
        track.classList.add('dragging');
    }

    function onMove(x, y) {
        if (!isSwiping) return;
        const dx = x - startX;
        const dy = y - startY;

        // Resolve axis on first meaningful movement
        if (isVertical === null && (Math.abs(dx) > 5 || Math.abs(dy) > 5)) {
            isVertical = Math.abs(dy) > Math.abs(dx);
        }
        if (isVertical) {
            // Let the page scroll naturally
            track.classList.remove('dragging');
            isSwiping = false;
            return;
        }

        deltaX = dx;
        const base = currentTabIndex * 100;   // % units
        // Rubber-band at edges
        let resistedDx = deltaX;
        if ((currentTabIndex === 0 && deltaX > 0) || (currentTabIndex === TABS.length - 1 && deltaX < 0)) {
            resistedDx = deltaX / 3;
        }
        track.style.transform = `translateX(calc(-${base}% + ${resistedDx}px))`;
    }

    function onEnd() {
        if (!isSwiping) return;
        track.classList.remove('dragging');
        isSwiping = false;

        if (deltaX < -THRESHOLD && currentTabIndex < TABS.length - 1) {
            slideTo(currentTabIndex + 1);
            // Trigger side effects
            const newTab = TABS[currentTabIndex];
            if (newTab === 'orders') loadOrders();
            if (newTab === 'ratio') { updateSliderLabel(); calculateRatio(); }
            if (newTab === 'settings') renderSettingsMenuList();
        } else if (deltaX > THRESHOLD && currentTabIndex > 0) {
            slideTo(currentTabIndex - 1);
        } else {
            // Snap back
            slideTo(currentTabIndex);
        }
    }

    // Touch events
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

    // Mouse events (desktop drag)
    track.addEventListener('mousedown', e => {
        // Ignore if clicking on an input/button/select/textarea
        if (['INPUT','BUTTON','SELECT','TEXTAREA','A'].includes(e.target.tagName)) return;
        onStart(e.clientX, e.clientY);
        e.preventDefault();
    });
    window.addEventListener('mousemove', e => { if (isSwiping) onMove(e.clientX, e.clientY); });
    window.addEventListener('mouseup', () => { if (isSwiping) onEnd(); });
})();

// ── Initial load ─────────────────────────────────────────────────────────
window.onload = () => {
    slideTo(0);   // ensure correct position on load
    loadMenu();
    renderHomeMenuInputs();
    setupPrinter();
};
