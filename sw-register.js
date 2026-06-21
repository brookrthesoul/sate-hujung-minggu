// sw-register.js — service worker registration + install prompt
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('./sw.js').catch(err => console.log('SW registration failed', err));
        }

    window.addEventListener('beforeinstallprompt', (e) => {
            e.preventDefault();
            // Create a button somewhere to prompt
            const installBtn = document.createElement('button');
            installBtn.innerText = 'Install App';
            installBtn.style.position = 'fixed';
            installBtn.style.bottom = '20px';
            installBtn.style.right = '20px';
            installBtn.style.zIndex = 9999;
            document.body.appendChild(installBtn);
            installBtn.addEventListener('click', () => {
                e.prompt(); // Show the install dialog
            });
        });

