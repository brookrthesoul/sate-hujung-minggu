// utils.js — small shared helpers used by both the admin app (index.html)
// and the customer ordering page (order.html), to avoid repeating the same
// snippets everywhere. Loaded right after config.js on both pages.

// Formats a number as Ringgit currency, e.g. formatRM(4.5) -> "RM4.50".
// Used anywhere a price/total is shown instead of writing `RM${x.toFixed(2)}` by hand.
function formatRM(amount) {
    return `RM${Number(amount || 0).toFixed(2)}`;
}

// Formats a date (or "today" when called with no argument) as a YYYY-MM-DD
// string in local time, e.g. dayKey() -> "2026-07-25", dayKey(o.pickupTs) -> "2026-07-26".
// Used anywhere dates are compared/grouped by calendar day, instead of writing
// `new Date(x).toLocaleDateString('en-CA')` by hand.
function dayKey(date) {
    return (date === undefined ? new Date() : new Date(date)).toLocaleDateString('en-CA');
}

// ── Modal helpers (style.display based) — used on the admin page (orders.js),
// where modals are shown/hidden via inline style.display 'flex'/'none'. ──
function showModalById(id) {
    const modal = document.getElementById(id);
    if (modal) modal.style.display = 'flex';
    return modal;
}
function hideModalById(id) {
    const modal = document.getElementById(id);
    if (modal) modal.style.display = 'none';
    return modal;
}

// ── Modal helpers (class-toggle based) — used on the customer order page
// (order.html), where modals are shown/hidden via the .open CSS class. ──
function openModalById(id) {
    const modal = document.getElementById(id);
    if (modal) modal.classList.add('open');
    return modal;
}
function closeModalById(id) {
    const modal = document.getElementById(id);
    if (modal) modal.classList.remove('open');
    return modal;
}

// ── Scroll-style time picker ──────────────────────────────────────────────────
// An iOS-style wheel picker (hour / minute / AM-PM columns) used in place of
// the native <input type="time"> on both the customer order page and the
// admin new-order form. openScrollTimePicker writes the chosen time as a
// 24-hour "HH:MM" string into the target input's value and fires a native
// 'change' event on it — so any existing code reading that input's value (or
// listening for 'change' on it) keeps working completely unchanged. Pass
// opts.onConfirm(value) if you also need to update a separate display element
// with a nicer-looking 12-hour string (see formatTime12hr below).
const STP_ROW_H = 44; // px — must match .stp-row/.stp-spacer height in CSS

function _stpBuildColumn(values, initialIndex) {
    const col = document.createElement('div');
    col.className = 'stp-col';

    const scroll = document.createElement('div');
    scroll.className = 'stp-col-scroll';

    const spacerTop = document.createElement('div');
    spacerTop.className = 'stp-spacer';
    scroll.appendChild(spacerTop);

    const rows = [];
    values.forEach((label, i) => {
        const row = document.createElement('div');
        row.className = 'stp-row';
        row.textContent = label;
        row.addEventListener('click', () => {
            if (row.classList.contains('stp-row-disabled')) return; // guard, on top of pointer-events:none
            scroll.scrollTo({ top: i * STP_ROW_H, behavior: 'smooth' });
        });
        scroll.appendChild(row);
        rows.push(row);
    });

    const spacerBottom = document.createElement('div');
    spacerBottom.className = 'stp-spacer';
    scroll.appendChild(spacerBottom);

    col.appendChild(scroll);
    const highlight = document.createElement('div');
    highlight.className = 'stp-highlight';
    col.appendChild(highlight);

    scroll.scrollTop = 0; // set for real after this column is attached to the document — see below
    col._stpScroll = scroll;
    col._stpValues = values;
    col._stpRows   = rows;
    col._stpInitialIndex = initialIndex;
    return col;
}

function _stpReadColumn(col) {
    const idx = Math.round(col._stpScroll.scrollTop / STP_ROW_H);
    const clamped = Math.max(0, Math.min(col._stpValues.length - 1, idx));
    return col._stpValues[clamped];
}

function openScrollTimePicker(targetInput, opts = {}) {
    const hours     = Array.from({ length: 12 }, (_, i) => String(i + 1));
    const minutes   = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, '0'));
    const meridiems = ['AM', 'PM'];

    // Start from opts.initialValue if given (a suggested opening position that
    // does NOT touch targetInput.value unless Done is actually pressed — this
    // matters: previously callers pre-filled by writing straight into the real
    // field before the picker even opened, so tapping in to just look, then
    // hitting Cancel, still silently left a time set). Falls back to the
    // target's current value, or now if both are empty.
    const seedValue = opts.initialValue || targetInput.value;
    let h24, m;
    if (seedValue) {
        const parts = seedValue.split(':');
        h24 = parseInt(parts[0], 10) || 0;
        m   = parseInt(parts[1], 10) || 0;
    } else {
        const now = new Date();
        h24 = now.getHours();
        m   = now.getMinutes();
    }
    const meridiemIdx = h24 >= 12 ? 1 : 0;
    let hour12 = h24 % 12;
    if (hour12 === 0) hour12 = 12;

    // Optional earliest-allowed time (24hr "HH:MM") — rows that would produce
    // an earlier time get greyed out and can't be tapped, so the customer
    // doesn't have to hit Done a few times to discover it's too early.
    let minH24 = null, minM = null;
    if (opts.minValue) {
        const mp = opts.minValue.split(':');
        const ph = parseInt(mp[0], 10), pm = parseInt(mp[1], 10);
        if (!isNaN(ph) && !isNaN(pm)) { minH24 = ph; minM = pm; }
    }

    const overlay = document.createElement('div');
    overlay.className = 'stp-overlay';
    const sheet = document.createElement('div');
    sheet.className = 'stp-sheet';

    const header = document.createElement('div');
    header.className = 'stp-header';
    header.innerHTML = `
        <button type="button" class="stp-cancel">Cancel</button>
        <span class="stp-title">${opts.title || 'Select Pick-up Time'}</span>
        <button type="button" class="stp-done">Done</button>
    `;
    sheet.appendChild(header);

    const columns = document.createElement('div');
    columns.className = 'stp-columns';
    const hourCol = _stpBuildColumn(hours, hour12 - 1);
    const minCol  = _stpBuildColumn(minutes, m);
    const merCol  = _stpBuildColumn(meridiems, meridiemIdx);
    const colon   = document.createElement('div');
    colon.className = 'stp-colon';
    colon.textContent = ':';

    columns.append(hourCol, colon, minCol, merCol);
    sheet.appendChild(columns);
    overlay.appendChild(sheet);
    document.body.appendChild(overlay);

    // Only now that these columns are actually attached to the document does
    // the browser know their real scrollable height — setting scrollTop any
    // earlier (e.g. while still detached, mid-construction) gets silently
    // ignored and every column would sit at index 0 regardless of what was
    // requested. This is the "no animation, just land there" jump.
    [hourCol, minCol, merCol].forEach(col => {
        col._stpScroll.scrollTop = col._stpInitialIndex * STP_ROW_H;
    });

    // Grey out rows that would produce a time earlier than opts.minValue.
    // Meridiem only affects whether AM is entirely too early; hour rows
    // depend on which meridiem is currently centered; minute rows depend on
    // both the currently centered hour and meridiem — so hour/meridiem
    // scrolling needs to re-grey the columns underneath them.
    if (minH24 !== null) {
        const toH24 = (h12, mer) => (h12 % 12) + (mer === 'PM' ? 12 : 0);
        const isTooEarly = (h24val, mval) => h24val < minH24 || (h24val === minH24 && mval < minM);
        const applyDisabled = (col, disabledFn) => {
            col._stpRows.forEach((row, i) => row.classList.toggle('stp-row-disabled', disabledFn(i)));
        };
        const refreshMeridiem = () => {
            // A meridiem is only entirely too early if even its latest minute is.
            applyDisabled(merCol, i => isTooEarly(i === 0 ? 11 : 23, 59));
        };
        const refreshHour = () => {
            const mer = _stpReadColumn(merCol);
            applyDisabled(hourCol, i => isTooEarly(toH24(i + 1, mer), 59));
        };
        const refreshMinute = () => {
            const mer   = _stpReadColumn(merCol);
            const h12   = parseInt(_stpReadColumn(hourCol), 10);
            const h24val = toH24(h12, mer);
            applyDisabled(minCol, i => isTooEarly(h24val, i));
        };
        refreshMeridiem();
        refreshHour();
        refreshMinute();
        merCol._stpScroll.addEventListener('scroll', () => { refreshHour(); refreshMinute(); });
        hourCol._stpScroll.addEventListener('scroll', refreshMinute);
    }

    requestAnimationFrame(() => overlay.classList.add('stp-open'));

    function close() { overlay.remove(); }
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
    header.querySelector('.stp-cancel').addEventListener('click', close);
    header.querySelector('.stp-done').addEventListener('click', () => {
        const hVal   = parseInt(_stpReadColumn(hourCol), 10);
        const mVal   = parseInt(_stpReadColumn(minCol), 10);
        const merVal = _stpReadColumn(merCol);
        let h = hVal % 12;
        if (merVal === 'PM') h += 12;
        const finalValue = String(h).padStart(2, '0') + ':' + String(mVal).padStart(2, '0');
        targetInput.value = finalValue;
        targetInput.dispatchEvent(new Event('change', { bubbles: true }));
        close();
        if (typeof opts.onConfirm === 'function') opts.onConfirm(finalValue);
    });
}

// Converts a 24-hour "HH:MM" string (or '' ) to a friendly 12-hour display
// string, e.g. formatTime12hr('14:30') -> "2:30 PM".
function formatTime12hr(hhmm) {
    if (!hhmm) return '';
    const [hStr, mStr] = hhmm.split(':');
    let h = parseInt(hStr, 10);
    if (isNaN(h)) return '';
    const mer = h >= 12 ? 'PM' : 'AM';
    h = h % 12;
    if (h === 0) h = 12;
    return `${h}:${mStr} ${mer}`;
}

// ─── Numeric keyboard "Done" bar ───────────────────────────────────────────
// type="number" inputs bring up the device's on-screen numeric keypad, but
// unlike the text keyboard it often has no obvious "Done"/return key — the
// only way to dismiss it is the small "⌄" collapse control (position varies
// by keyboard app) or tapping empty space above it. This adds a small
// floating "Done" bar that appears right above the keypad whenever ANY
// number input in the app is focused, and blurs it (closing the keypad) when
// tapped. Delegated on `document`, so it automatically covers every number
// input — including ones rendered later by orders.js/stock.js/menu.js/etc —
// with nothing to change at each individual <input>.
(function () {
    let bar = null;
    let hideTimer = null;

    function isNumInput(el) {
        return !!(el && el.matches && el.matches('input[type="number"]'));
    }

    function ensureBar() {
        if (bar) return bar;
        bar = document.createElement('div');
        bar.className = 'num-done-bar';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'num-done-btn';
        btn.textContent = 'Done';
        // pointerdown (fired before focusout) + preventDefault so the input
        // never actually loses focus to the button itself — we blur it
        // ourselves right here instead. Without this, tapping the button
        // would blur-then-refocus and the bar would flicker or the keypad
        // wouldn't close reliably on the first tap.
        btn.addEventListener('pointerdown', e => {
            e.preventDefault();
            if (isNumInput(document.activeElement)) document.activeElement.blur();
            hideBar();
        });
        bar.appendChild(btn);
        document.body.appendChild(bar);
        return bar;
    }

    function positionBar() {
        if (!bar) return;
        const vv = window.visualViewport;
        // Sit flush above the visible on-screen keyboard. Falls back to the
        // bottom of the screen on browsers without the visualViewport API.
        const gap = vv ? (window.innerHeight - vv.height - vv.offsetTop) : 0;
        bar.style.bottom = Math.max(0, gap) + 'px';
    }

    function showBar() {
        clearTimeout(hideTimer);
        ensureBar();
        positionBar();
        requestAnimationFrame(() => bar.classList.add('num-done-open'));
    }

    function hideBar() {
        if (bar) bar.classList.remove('num-done-open');
    }

    document.addEventListener('focusin', e => {
        if (isNumInput(e.target)) showBar();
    });

    document.addEventListener('focusout', e => {
        if (!isNumInput(e.target)) return;
        // Short grace period: tapping the Done button, or focus moving
        // straight to another number input, shouldn't cause the bar to
        // flash closed and reopen.
        hideTimer = setTimeout(() => {
            if (!isNumInput(document.activeElement)) hideBar();
        }, 80);
    });

    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', positionBar);
        window.visualViewport.addEventListener('scroll', positionBar);
    }
})();

// Stable per-browser/device id, shared by the admin app and the customer page
// (same localStorage key 'shmDeviceId'). Every order carries this plus its
// createdAt timestamp, which together uniquely identify one real
// order-creation event. That pair is what lets the server recognise a RETRY
// of an order it already saved (connection dropped before the confirmation
// came back) instead of quietly saving a second, duplicate order.
function getDeviceId() {
    let id = localStorage.getItem('shmDeviceId');
    if (!id) {
        id = (crypto.randomUUID ? crypto.randomUUID()
                                : 'd_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10));
        localStorage.setItem('shmDeviceId', id);
    }
    return id;
}
