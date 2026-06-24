// sw-register.js — registers SW and forces immediate update

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').then(reg => {

    // Force the new SW to take over immediately without waiting
    if (reg.waiting) {
      reg.waiting.postMessage({ type: 'SKIP_WAITING' });
    }

    reg.addEventListener('updatefound', () => {
      const newWorker = reg.installing;
      if (!newWorker) return;
      newWorker.addEventListener('statechange', () => {
        if (newWorker.state === 'installed') {
          // Force activation immediately
          newWorker.postMessage({ type: 'SKIP_WAITING' });
        }
      });
    });

  }).catch(err => console.warn('SW registration failed', err));

  // When new SW takes control, reload once to get fresh JS files
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloaded) return;
    reloaded = true;
    window.location.reload();
  });
}

// ─── Install prompt ───────────────────────────────────────────────────────────

let deferredInstallPrompt = null;
let hasJustBeenInstalled  = false;

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredInstallPrompt = e;
  updateInstallUI();
});

window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  hasJustBeenInstalled  = true;
  updateInstallUI();
});

function isRunningStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches
      || window.navigator.standalone === true;
}

function updateInstallUI() {
  const btn  = document.getElementById('installAppBtn');
  const hint = document.getElementById('installAppHint');
  if (!btn || !hint) return;
  if (isRunningStandalone() || hasJustBeenInstalled) {
    btn.style.display = 'none';
    hint.textContent  = '✅ App is installed.';
    return;
  }
  if (deferredInstallPrompt) {
    btn.style.display = 'inline-block';
    hint.textContent  = '';
  } else {
    btn.style.display = 'none';
    hint.textContent  = 'To install: tap ⋮ menu in Chrome → "Add to Home screen".';
  }
}

async function installApp() {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  const { outcome } = await deferredInstallPrompt.userChoice;
  console.log('Install choice:', outcome);
  deferredInstallPrompt = null;
  updateInstallUI();
}

document.addEventListener('DOMContentLoaded', updateInstallUI);
