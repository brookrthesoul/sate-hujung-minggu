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
