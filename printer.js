// printer.js — Bluetooth receipt printer setup (ESC/POS) and order printing
//
// Uses two sister libraries from Niels Leenheer's @point-of-sale family:
//   - WebBluetoothReceiptPrinter  (connection + sending raw bytes over Bluetooth)
//   - ReceiptPrinterEncoder       (building the receipt content as raw bytes)
// Both are loaded via <script> tags in index.html.

let receiptPrinter = null;
let printerInfo = null; // set from the 'connected' event: { type, name, id, language, codepageMapping }

// Paper size configs: characters per line
// 58mm  ~  32 chars
// 80mm  ~  48 chars
const PAPER_SIZES = {
    '58': 32,
    '80': 48
};

function getPaperColumns() {
    const sel = document.getElementById('paperSize');
    const size = sel ? sel.value : '58';
    return PAPER_SIZES[size] || 32;
}

function savePaperSize() {
    const sel = document.getElementById('paperSize');
    if (sel) {
        try { localStorage.setItem('paperSize', sel.value); } catch(e) {}
    }
}

function loadPaperSize() {
    try {
        const saved = localStorage.getItem('paperSize');
        const sel = document.getElementById('paperSize');
        if (sel && saved) sel.value = saved;
    } catch(e) {}
}

// ---------- Manual line formatter (avoids .table() wrapping issues) ----------
// Pads left text and right text to exactly `cols` characters total.
// If left text is too long, it truncates with a space before right text.
function formatLine(left, right, cols) {
    const rightStr = String(right);
    const leftStr = String(left);
    const gap = cols - rightStr.length;
    if (leftStr.length >= gap) {
        // Truncate left so right fits
        return leftStr.substring(0, gap - 1) + ' ' + rightStr;
    }
    return leftStr + ' '.repeat(gap - leftStr.length) + rightStr;
}

// Center a string within `cols` characters
function centerLine(text, cols) {
    const str = String(text);
    if (str.length >= cols) return str.substring(0, cols);
    const totalPad = cols - str.length;
    const leftPad = Math.floor(totalPad / 2);
    return ' '.repeat(leftPad) + str;
}

function setupPrinter() {
    loadPaperSize();

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
        const COLS = getPaperColumns();
        const DASH = '-'.repeat(COLS);

        const encoder = new ReceiptPrinterEncoder({
            language: printerInfo.language || 'esc-pos',
            codepageMapping: printerInfo.codepageMapping || 'cp437'
        });

        // Build receipt using manual line formatting — no .table() to avoid wrapping bugs
        let receipt = encoder
            .initialize()
            .align('center')
            .bold(true).line('SATE HUJUNG MINGGU').bold(false)
            .line(`Order #${order.id}`)
            .line(formatDate(order.createdAt || Date.now()))
            .align('left')
            .line(DASH);

        // Item lines: "Ayam x10              RM13.00"
        const items = Object.values(order.items || {}).filter(r => r.qty > 0);
        items.forEach(r => {
            receipt = receipt.line(formatLine(`${r.name} x${r.qty}`, `RM${r.cost.toFixed(2)}`, COLS));
        });

        receipt = receipt
            .line(DASH)
            .line(formatLine('Cucuk', `${order.skewerQty || 0}`, COLS))
            .line(formatLine('Senduk', `${order.scoops || 0}`, COLS))
            .line(DASH)
            .align('right')
            .bold(true)
            .line(`TOTAL RM${(order.totalCost || 0).toFixed(2)}`)
            .bold(false)
            .align('left');

        if (order.description) {
            receipt = receipt
                .newline()
                .line('Note:')
                .line(order.description);
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
