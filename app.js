// app.js — tab switching with swipe support

const TABS = ['home', 'orders', 'ratio', 'settings'];
let currentTabIndex = 0;
let panelW = 0; // panel width in px, set on load and resize

function getTrack()    { return document.getElementById('panelsTrack'); }
function getViewport() { return document.getElementById('panelsTrack').parentElement; }

// Measure panel width and stamp it directly on every panel element
function measureAndStamp() {
    panelW = getViewport().getBoundingClientRect().width;
    document.querySelectorAll('.panel').forEach(p => {
        p.style.width = panelW + 'px';
        p.style.minWidth = panelW + 'px';
        p.style.maxWidth = panelW + 'px';
        p.style.flexShrink = '0';
    });
    return panelW;
}

// ── Slide to a tab index ──────────────────────────────────────────────────
function slideTo(index) {
    measureAndStamp();
    getTrack().style.transform = `translateX(${-index * panelW}px)`;

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

// ── Re-snap on resize / orientation change ────────────────────────────────
window.addEventListener('resize', () => slideTo(currentTabIndex));

// ── Swipe / drag support ──────────────────────────────────────────────────
(function setupSwipe() {
    const track = getTrack();
    let startX = 0, startY = 0, deltaX = 0;
    let isSwiping = false;
    let isVertical = null;
    const THRESHOLD = 50;

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
        let offset = deltaX;
        // Rubber-band at edges
        if ((currentTabIndex === 0 && deltaX > 0) || (currentTabIndex === TABS.length - 1 && deltaX < 0)) {
            offset = deltaX / 3;
        }
        track.style.transform = `translateX(${-(currentTabIndex * panelW) + offset}px)`;
    }

    function onEnd() {
        if (!isSwiping) return;
        track.classList.remove('dragging');
        isSwiping = false;

        let next = currentTabIndex;
        if (deltaX < -THRESHOLD && currentTabIndex < TABS.length - 1) next = currentTabIndex + 1;
        else if (deltaX > THRESHOLD && currentTabIndex > 0) next = currentTabIndex - 1;

        slideTo(next);

        const tab = TABS[next];
        if (tab === 'orders') loadOrders();
        if (tab === 'ratio') { updateSliderLabel(); calculateRatio(); }
        if (tab === 'settings') renderSettingsMenuList();
    }

    // Touch
    track.addEventListener('touchstart', e => {
        onStart(e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: true });
    track.addEventListener('touchmove', e => {
        onMove(e.touches[0].clientX, e.touches[0].clientY);
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
    // Use rAF to ensure layout is complete before measuring
    requestAnimationFrame(() => {
        measureAndStamp();
        slideTo(0);
        loadMenu();
        renderHomeMenuInputs();
        setupPrinter();
    });
};
