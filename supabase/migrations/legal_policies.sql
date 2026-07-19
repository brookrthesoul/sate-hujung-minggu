-- Run this ONCE in your Supabase SQL editor.
-- Seeds a starter Privacy Policy & Terms and Conditions so customers see
-- something right away. Edit the actual text anytime from
-- Admin → Settings → Policies (no need to touch SQL again after this).

insert into settings (key, value) values (
    'legalPolicies',
    jsonb_build_object(
        'privacyPolicy', $$Last updated: [DATE]

We collect your name and phone number when you place an order so that we can:
- Identify and prepare your order correctly
- Contact you (including via WhatsApp) if there's an issue with your order, or to confirm pick-up details
- Receive payment receipts you send us via WhatsApp after an online transfer

We do NOT sell, rent, or share your information with third parties for marketing purposes. Your details are only used to fulfil your order and are stored securely.

We keep order records for our own bookkeeping. If you'd like your information removed from our records, message us on WhatsApp and we'll action it, subject to any records we're required to keep for accounting purposes.

If you have any questions about how your information is used, contact us via WhatsApp.$$,
        'terms', $$Last updated: [DATE]

1. Orders placed through this page are for pick-up only — we do not offer delivery.
2. Payment is made in person at the stall (cash, online transfer, or other method as arranged). We do not process payment through this app.
3. Please arrive at your selected pick-up time. Orders not collected within a reasonable time may need to be reconfirmed.
4. Stock is limited and shown on the order page — items may sell out even after you've started an order.
5. If you need to change or cancel your order, please contact us directly via WhatsApp using the number provided.
6. By placing an order, you agree to provide accurate name and phone number so we can reach you regarding your order.$$,
        'updatedAt', extract(epoch from now()) * 1000
    )::text
)
on conflict (key) do nothing;
