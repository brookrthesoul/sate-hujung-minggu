// ratio.js — Allocator tab: ayam/daging ratio buying logic + RM-split mode
         // ---------- Ratio Tab Functions (Corrected) ----------

        // The Allocator has two modes that share the same output cards, the same
        // Clear button and the same "Fill New Order Form" button:
        //   'ratio' — one RM amount, split by the Ayam/Daging slider
        //   'split' — a separate RM amount for Ayam and for Daging
        let allocatorMode = 'ratio';

        function setAllocatorMode(mode) {
            allocatorMode = (mode === 'split') ? 'split' : 'ratio';
            const isSplit = allocatorMode === 'split';

            const ratioSection = document.getElementById('allocRatioMode');
            const splitSection = document.getElementById('allocSplitMode');
            if (ratioSection) ratioSection.style.display = isSplit ? 'none' : '';
            if (splitSection) splitSection.style.display = isSplit ? '' : 'none';

            const ratioBtn = document.getElementById('allocModeRatioBtn');
            const splitBtn = document.getElementById('allocModeSplitBtn');
            [[ratioBtn, !isSplit], [splitBtn, isSplit]].forEach(function (pair) {
                const btn = pair[0], active = pair[1];
                if (!btn) return;
                btn.style.background = active ? '#007bff' : '#e9ecef';
                btn.style.color = active ? '#ffffff' : '#495057';
            });

            const hint = document.getElementById('allocatorHint');
            if (hint) {
                hint.innerText = isSplit
                    ? 'Enter how much money goes to Ayam and how much to Daging — each budget is spent on its own Sate, and the leftovers add up to the balance.'
                    : 'Items are bought one by one, always choosing the Sate that brings the ratio closer to your slider.';
            }

            calculateRatio();
        }

        // Clears both modes' inputs and resets the shared output cards.
        function clearAllocator() {
            ['moneyInput', 'ayamMoneyInput', 'dagingMoneyInput'].forEach(function (id) {
                const el = document.getElementById(id);
                if (el) el.value = '';
            });
            const slider = document.getElementById('ratioSlider');
            if (slider) {
                slider.value = 50;
                updateSliderLabel();
            }
            calculateRatio();
        }

        function updateSliderLabel() {
            const val = document.getElementById('ratioSlider').value;
            const displayPercent = 100 - val;
            document.getElementById('sliderPercent').innerText = displayPercent + '%';
        }

        function renderAllocatorResults(ayam, daging, totalCost, balance) {
            document.getElementById('ayamCount').innerText = ayam;
            document.getElementById('dagingCount').innerText = daging;
            document.getElementById('totalItemsCount').innerText = ayam + daging;
            document.getElementById('balanceAmount').innerText = 'RM' + (balance < 0 ? 0 : balance).toFixed(2);
            document.getElementById('totalSpent').innerText = 'RM' + totalCost.toFixed(2);
        }

        // RM Split mode: each Sate gets its own budget, spent independently.
        function calculateSplit(ayamItem, dagingItem) {
            const ayamMoney   = parseFloat(document.getElementById('ayamMoneyInput').value) || 0;
            const dagingMoney = parseFloat(document.getElementById('dagingMoneyInput').value) || 0;

            const ayamPrice   = ayamItem.price;
            const dagingPrice = dagingItem.price;

            const ayam   = ayamPrice   > 0 ? Math.floor((ayamMoney   + 1e-9) / ayamPrice)   : 0;
            const daging = dagingPrice > 0 ? Math.floor((dagingMoney + 1e-9) / dagingPrice) : 0;

            const totalCost = ayam * ayamPrice + daging * dagingPrice;
            const balance   = (ayamMoney + dagingMoney) - totalCost;

            renderAllocatorResults(ayam, daging, totalCost, balance);
        }

        function calculateRatio() {
            const ayamItem = getMenuItem('ayam');
            const dagingItem = getMenuItem('daging');

            if (!ayamItem || !dagingItem) {
                // Ayam and/or Daging were removed from the menu — this tab is specifically
                // an Ayam-vs-Daging allocator, so show a clear "unavailable" state instead of NaN.
                document.getElementById('ayamCount').innerText = '–';
                document.getElementById('dagingCount').innerText = '–';
                document.getElementById('totalItemsCount').innerText = '–';
                document.getElementById('balanceAmount').innerText = '–';
                document.getElementById('totalSpent').innerText = '–';
                return;
            }

            if (allocatorMode === 'split') {
                calculateSplit(ayamItem, dagingItem);
                return;
            }

            const money = parseFloat(document.getElementById('moneyInput').value) || 0;

            // NOTE: do NOT use `|| 50` here — a slider value of 0 (full Ayam) is falsy in
            // JS, so `0 || 50` would silently snap it back to the 50/50 midpoint.
            let sliderVal = parseInt(document.getElementById('ratioSlider').value);
            if (isNaN(sliderVal)) sliderVal = 50;
            const targetRatio = 1 - (sliderVal / 100); // 0 = all daging, 1 = all ayam

            const ayamPrice = ayamItem.price;
            const dagingPrice = dagingItem.price;
            const minPrice = Math.min(ayamPrice, dagingPrice);

            let remaining = money;
            let ayam = 0;
            let daging = 0;

            // Pure ends of the slider are hard locks, not preferences: at 100% ayam we must
            // never buy a daging, and at 0% (all daging) we must never buy an ayam — even if
            // the leftover balance happens to cover one. Previously the "can't afford daging
            // but can afford ayam" fallback bought a stray ayam at 0%, e.g. RM6.10 gave
            // 1 ayam + 3 daging instead of 3 daging + RM1.30 balance.
            const allAyam   = targetRatio === 1;
            const allDaging = targetRatio === 0;

            if (allAyam || allDaging) {
                const price = allAyam ? ayamPrice : dagingPrice;
                const qty   = Math.floor((remaining + 1e-9) / price);
                if (allAyam) ayam = qty; else daging = qty;
                remaining -= qty * price;
            } else {
                while (remaining >= minPrice) {
                    const canBuyAyam = remaining >= ayamPrice;
                    const canBuyDaging = remaining >= dagingPrice;

                    if (canBuyAyam && canBuyDaging) {
                        const total = ayam + daging;
                        // Buy whichever item brings the ratio closer to the target, rather than
                        // comparing the current ratio to the target directly — that approach has
                        // a tie-breaking bug exactly at the 100%-ayam boundary (it favours daging
                        // on an exact tie, so it would buy a stray daging at ratio === 1).
                        const ratioIfAyam = (ayam + 1) / (total + 1);
                        const ratioIfDaging = ayam / (total + 1);
                        const diffAyam = Math.abs(targetRatio - ratioIfAyam);
                        const diffDaging = Math.abs(targetRatio - ratioIfDaging);

                        if (diffAyam <= diffDaging) {
                            ayam++;
                            remaining -= ayamPrice;
                        } else {
                            daging++;
                            remaining -= dagingPrice;
                        }
                    } else if (canBuyAyam) {
                        ayam++;
                        remaining -= ayamPrice;
                    } else if (canBuyDaging) {
                        daging++;
                        remaining -= dagingPrice;
                    } else {
                        break;
                    }
                }

                // Spend whatever is left, favouring the side the slider leans towards
                // (previously this always tried ayam first, which skewed daging-leaning mixes).
                const leansAyam = targetRatio >= 0.5;
                const first  = leansAyam ? ayamPrice : dagingPrice;
                const second = leansAyam ? dagingPrice : ayamPrice;
                if (remaining >= first) {
                    const extra = Math.floor(remaining / first);
                    if (leansAyam) ayam += extra; else daging += extra;
                    remaining -= extra * first;
                } else if (remaining >= second) {
                    const extra = Math.floor(remaining / second);
                    if (leansAyam) daging += extra; else ayam += extra;
                    remaining -= extra * second;
                }
            }


            const totalCost = ayam * ayamPrice + daging * dagingPrice;
            const balance   = money - totalCost;

            renderAllocatorResults(ayam, daging, totalCost, balance);
        }

        // Jumps to the New Order tab and fills in the Ayam/Daging quantity
        // fields with whatever the Allocator just worked out — so staff don't
        // have to retype the numbers by hand. Only touches those two fields;
        // anything else already in the form is left as-is.
        function fillNewOrderFromAllocator() {
            const ayamQty   = parseInt(document.getElementById('ayamCount').innerText) || 0;
            const dagingQty = parseInt(document.getElementById('dagingCount').innerText) || 0;

            switchTab('home');

            const ayamInput   = document.getElementById('qty-ayam');
            const dagingInput = document.getElementById('qty-daging');
            if (ayamInput) {
                ayamInput.value = ayamQty || '';
                if (typeof checkStockInput === 'function') checkStockInput('ayam', ayamInput.value);
                if (typeof refreshMenuItemButton === 'function') refreshMenuItemButton('ayam');
            }
            if (dagingInput) {
                dagingInput.value = dagingQty || '';
                if (typeof checkStockInput === 'function') checkStockInput('daging', dagingInput.value);
                if (typeof refreshMenuItemButton === 'function') refreshMenuItemButton('daging');
            }
        }
