// policies.js — "Policies" settings sub-tab: Privacy Policy & Terms and Conditions
// Stored in the `settings` table under key 'legalPolicies' as a JSON string:
//   { privacyPolicy: string, terms: string, updatedAt: number }

const DEFAULT_PRIVACY_POLICY = `Last updated: [DATE]

We collect your name and phone number when you place an order so that we can:
- Identify and prepare your order correctly
- Contact you (including via WhatsApp) if there's an issue with your order, or to confirm pick-up details
- Receive payment receipts you send us via WhatsApp after an online transfer

We do NOT sell, rent, or share your information with third parties for marketing purposes. Your details are only used to fulfil your order and are stored securely.

We keep order records for our own bookkeeping. If you'd like your information removed from our records, message us on WhatsApp and we'll action it, subject to any records we're required to keep for accounting purposes.

If you have any questions about how your information is used, contact us via WhatsApp.`;

const DEFAULT_TERMS = `Last updated: [DATE]

1. Orders placed through this page are for pick-up only — we do not offer delivery.
2. Payment is made in person at the stall (cash, online transfer, or other method as arranged). We do not process payment through this app.
3. Please arrive at your selected pick-up time. Orders not collected within a reasonable time may need to be reconfirmed.
4. Stock is limited and shown on the order page — items may sell out even after you've started an order.
5. If you need to change or cancel your order, please contact us directly via WhatsApp using the number provided.
6. By placing an order, you agree to provide accurate name and phone number so we can reach you regarding your order.`;

async function _policyFetch(path, opts = {}) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
        ...opts,
        headers: {
            'apikey':        SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
            'Content-Type':  'application/json',
            ...(opts.headers || {})
        }
    });
    if (!res.ok) throw new Error(`Policies API ${res.status}: ${await res.text()}`);
    const t = await res.text();
    return t ? JSON.parse(t) : null;
}

async function loadPolicies() {
    const privacyEl = document.getElementById('privacyPolicyInput');
    const termsEl    = document.getElementById('termsInput');
    if (!privacyEl || !termsEl) return;

    let policies = { privacyPolicy: DEFAULT_PRIVACY_POLICY, terms: DEFAULT_TERMS };
    try {
        const rows = await _policyFetch('settings?key=eq.legalPolicies&select=value');
        if (rows && rows.length) {
            try {
                const parsed = JSON.parse(rows[0].value);
                policies.privacyPolicy = parsed.privacyPolicy || DEFAULT_PRIVACY_POLICY;
                policies.terms         = parsed.terms || DEFAULT_TERMS;
            } catch (_) { /* fall back to defaults */ }
        }
    } catch (e) {
        console.warn('Could not load policies from Supabase:', e);
    }

    privacyEl.value = policies.privacyPolicy;
    termsEl.value    = policies.terms;
}

async function savePolicies() {
    const privacyEl = document.getElementById('privacyPolicyInput');
    const termsEl    = document.getElementById('termsInput');
    const status     = document.getElementById('policiesSaveStatus');

    const payload = {
        privacyPolicy: privacyEl.value.trim(),
        terms:         termsEl.value.trim(),
        updatedAt:     Date.now()
    };

    if (status) { status.style.color = '#6c757d'; status.textContent = '⏳ Saving...'; }

    try {
        await _policyFetch('settings', {
            method:  'POST',
            headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
            body:    JSON.stringify({ key: 'legalPolicies', value: JSON.stringify(payload) })
        });
        if (status) { status.style.color = '#28a745'; status.textContent = '✅ Saved! Customers will see the updated version immediately.'; }
    } catch (e) {
        if (status) { status.style.color = '#dc3545'; status.textContent = '❌ Save failed: ' + e.message; }
    }
}
