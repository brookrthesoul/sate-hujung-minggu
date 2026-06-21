// app.js — tab switching and app bootstrap
        // ---------- Tab switching ----------
        function switchTab(tab) {
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));

            if (tab === 'home') {
                document.getElementById('homePanel').classList.add('active');
                document.querySelector('.tab:nth-child(1)').classList.add('active');
            } else if (tab === 'orders') {
                document.getElementById('ordersPanel').classList.add('active');
                document.querySelector('.tab:nth-child(2)').classList.add('active');
                loadOrders();
            } else if (tab === 'ratio') {
                document.getElementById('ratioPanel').classList.add('active');
                document.querySelector('.tab:nth-child(3)').classList.add('active');
                updateSliderLabel();
                calculateRatio();
            }else if (tab === 'settings') {
                document.getElementById('settingsPanel').classList.add('active');
                document.querySelector('.tab:nth-child(4)').classList.add('active');
                renderSettingsMenuList();
            }
        }

        // ---------- Initial load ----------
        window.onload = () => {
            loadMenu();
            renderHomeMenuInputs();
            setupPrinter();
        };
