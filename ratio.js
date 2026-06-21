// ratio.js — Allocator tab: ayam/daging ratio buying logic
         // ---------- Ratio Tab Functions (Corrected) ----------
        function updateSliderLabel() {
            const val = document.getElementById('ratioSlider').value;
            const displayPercent = 100 - val;
            document.getElementById('sliderPercent').innerText = displayPercent + '%';
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

            const totalCost = ayam * ayamPrice + daging * dagingPrice;
            const balance = money - totalCost;

            document.getElementById('ayamCount').innerText = ayam;
            document.getElementById('dagingCount').innerText = daging;
            document.getElementById('totalItemsCount').innerText = ayam + daging;
            document.getElementById('balanceAmount').innerText = 'RM' + (balance < 0 ? 0 : balance).toFixed(2);
            document.getElementById('totalSpent').innerText = 'RM' + totalCost.toFixed(2);
        }
