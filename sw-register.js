// sw-register.js — service worker registration, update detection, and install prompt handling

if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').then((registration) => {
        // A new version may already be sitting in the background waiting
        // (e.g. it finished downloading while the app was closed).
        if (registration.waiting) {
            showUpdateBanner(registration.waiting);
        }

        // A new version started downloading just now — watch it until it's
        // ready, then offer it (only if this isn't the very first install).
        registration.addEventListener('updatefound', () => {
            const newWorker = registration.installing;
            if (!newWorker) return;
            newWorker.addEventListener('statechange', () => {
                if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                    showUpdateBanner(newWorker);
                }
            });
        });
    }).catch(err => console.log('SW registration failed', err));

    // Once the new service worker actually takes control, reload exactly
    // once to pick up the new files (guarded against firing more than once).
    let hasReloadedForUpdate = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (hasReloadedForUpdate) return;
        hasReloadedForUpdate = true;
        window.location.reload();
    });
}

function showUpdateBanner(worker) {
    if (document.getElementById('updateBanner')) return; // already showing

    const banner = document.createElement('div');
    banner.id = 'updateBanner';
    banner.style.cssText = 'position:fixed; left:0; right:0; bottom:0; background:#007bff; color:white; padding:14px 16px; text-align:center; z-index:9999; font-size:14px; display:flex; align-items:center; justify-content:center; gap:12px; flex-wrap:wrap;';
    banner.innerHTML = `
        <span>🔄 A new version is ready.</span>
        <button id="updateBannerBtn" style="padding:6px 16px; border:none; border-radius:20px; background:white; color:#007bff; font-weight:bold; cursor:pointer;">Update now</button>
        <button id="updateBannerDismiss" style="padding:6px 12px; border:none; border-radius:20px; background:transparent; color:white; cursor:pointer; opacity:0.8;">Later</button>
    `;
    document.body.appendChild(banner);

    document.getElementById('updateBannerBtn').addEventListener('click', () => {
        worker.postMessage({ type: 'SKIP_WAITING' });
        banner.remove();
    });
    document.getElementById('updateBannerDismiss').addEventListener('click', () => {
        banner.remove();
    });
}

// ---------- Install prompt handling ----------

let deferredInstallPrompt = null;
let hasJustBeenInstalled = false;

// Fired only once Chrome's installability + engagement criteria are met
// (HTTPS, valid manifest, registered SW with a fetch handler, at least one
// tap on the page, and ~30 seconds of viewing time — see web.dev/install-criteria).
window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    updateInstallUI();
});

window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    hasJustBeenInstalled = true;
    updateInstallUI();
    console.log('✅ App installed');
});

function isRunningStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

function updateInstallUI() {
    const btn = document.getElementById('installAppBtn');
    const hint = document.getElementById('installAppHint');
    if (!btn || !hint) return;

    if (isRunningStandalone() || hasJustBeenInstalled) {
        btn.style.display = 'none';
        hint.textContent = '✅ App is installed.';
        return;
    }

    if (deferredInstallPrompt) {
        btn.style.display = 'inline-block';
        hint.textContent = '';
    } else {
        btn.style.display = 'none';
        hint.textContent = 'Not offering the automatic prompt yet (Chrome needs at least one tap and ~30 seconds on the page first). You can always install manually: tap the ⋮ menu in Chrome → "Add to Home screen" or "Install app".';
    }
}

async function installApp() {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    const choice = await deferredInstallPrompt.userChoice;
    console.log('Install choice:', choice.outcome);
    deferredInstallPrompt = null;
    updateInstallUI();
}

// Show the correct state immediately (e.g. the manual-install hint) rather
// than waiting — the event may simply never fire this session.
document.addEventListener('DOMContentLoaded', updateInstallUI);
