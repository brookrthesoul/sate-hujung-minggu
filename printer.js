// printer.js — Bluetooth receipt printer setup (ESC/POS) and order printing
//
// Uses two sister libraries from Niels Leenheer's @point-of-sale family:
//   - WebBluetoothReceiptPrinter  (connection + sending raw bytes over Bluetooth)
//   - ReceiptPrinterEncoder       (building the receipt content as raw bytes)
// Both are loaded via <script> tags in index.html.

let receiptPrinter = null;
let printerInfo = null; // set from the 'connected' event: { type, name, id, language, codepageMapping }

// Adjust to match your printer's paper width in characters.
// Common values: 32 for small 58mm printers, 42-48 for 80mm printers.
const RECEIPT_COLUMNS = 32;

function setupPrinter() {
    if (typeof WebBluetoothReceiptPrinter === 'undefined') {
        console.warn('WebBluetoothReceiptPrinter library failed to load — printing will be unavailable.');
        updatePrinterStatus();
        return;
    }

    receiptPrinter = new WebBluetoothReceiptPrinter();

    receiptPrinter.addEventListener('connected', (device) => {
        printerInfo = device;
        try {
            localStorage.setItem('lastPrinterDevice', JSON.stringify({ id: device.id }));
        } catch (e) { /* ignore storage errors */ }
        console.log('🖨️ Connected to printer:', device.name);
        updatePrinterStatus();
    });

    receiptPrinter.addEventListener('disconnected', () => {
        console.log('🖨️ Printer disconnected');
        printerInfo = null;
        updatePrinterStatus();
    });

    // Browsers allow silently reconnecting to a previously-paired device on page
    // load (unlike connect(), which requires a user gesture every time).
    const saved = localStorage.getItem('lastPrinterDevice');
    if (saved) {
        try {
            receiptPrinter.reconnect(JSON.parse(saved));
        } catch (e) {
            console.warn('Could not auto-reconnect to printer:', e);
        }
    }

    updatePrinterStatus();
}

// Must be triggered by a real user click (Bluetooth permission requirement).
function connectPrinter() {
    if (!receiptPrinter) {
        alert('Printer support is not available in this browser. Try Chrome or Edge on desktop or Android.');
        return;
    }
    receiptPrinter.connect().catch((e) => {
        console.log('Printer connect cancelled or failed:', e.message);
    });
}

function updatePrinterStatus() {
    const el = document.getElementById('printerStatus');
    if (!el) return;
    el.textContent = printerInfo ? `✅ Connected to ${printerInfo.name}` : '⭕ Not connected';
}

// ---------- Print a saved order as a receipt ----------
async function printOrder(id) {
    if (!receiptPrinter) {
        alert('Printer is not available in this browser.');
        return;
    }
    if (!printerInfo) {
        alert('No printer connected. Go to Settings → Receipt Printer and tap "Connect Printer" first.');
        return;
    }

    const all = await getAllOrders();
    const rawOrder = all.find(o => o.id === id);
    if (!rawOrder) return;
    const order = normalizeOrder(rawOrder);

    try {
        const encoder = new ReceiptPrinterEncoder({
            language: printerInfo.language || 'esc-pos',
            codepageMapping: printerInfo.codepageMapping || 'cp437'
        });

        let receipt = encoder
            .initialize()
            .align('center')
            .bold(true).line('SATE HUJUNG MINGGU').bold(false)
            .line(`Order #${order.id}`)
            .line(formatDate(order.createdAt || Date.now()))
            .align('left')
            .rule({ style: 'single', width: RECEIPT_COLUMNS });

        const itemRows = Object.values(order.items || {})
            .filter(r => r.qty > 0)
            .map(r => [`${r.name} x${r.qty}`, `RM${r.cost.toFixed(2)}`]);

        if (itemRows.length > 0) {
            receipt = receipt.table(
                [
                    { width: RECEIPT_COLUMNS - 10, align: 'left' },
                    { width: 10, align: 'right' }
                ],
                itemRows
            );
        }

        receipt = receipt
            .rule({ style: 'single', width: RECEIPT_COLUMNS })
            .table(
                [
                    { width: RECEIPT_COLUMNS - 10, align: 'left' },
                    { width: 10, align: 'right' }
                ],
                [
                    ['Cucuk', `${order.skewerQty || 0}`],
                    ['Senduk', `${order.scoops || 0}`]
                ]
            )
            .rule({ style: 'double', width: RECEIPT_COLUMNS })
            .align('right')
            .bold(true)
            .line(`TOTAL RM${(order.totalCost || 0).toFixed(2)}`)
            .bold(false)
            .align('left');

        if (order.description) {
            receipt = receipt
                .newline()
                .line('Note:')
                .text(order.description);
        }

        const data = receipt
            .newline(2)
            .cut()
            .encode();

        await receiptPrinter.print(data);
    } catch (e) {
        alert('❌ Print failed: ' + e.message);
        console.error(e);
    }
}
