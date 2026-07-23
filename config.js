// config.js — the ONE file to edit when setting this app up for a new shop,
// or pointing it at a different Supabase / Firebase project.
//
// Loaded first by index.html, order.html, AND sw.js (the service worker), so
// `globalThis` is used instead of `window` — service workers don't have
// `window`, but both regular pages and service workers have `globalThis`.
// Don't change that part.

globalThis.APP_CONFIG = {

    // ── Supabase (database) ──────────────────────────────────────────────────
    // Find these in your Supabase project: Project Settings → API.
    SUPABASE_URL:      'https://efrwvksxttauhoxllhqu.supabase.co',
    SUPABASE_ANON_KEY: 'sb_publishable_SOoDs65SPw_G_m-lZ6NP-w_MbbqxOUw',

    // ── Firebase (push notifications) ────────────────────────────────────────
    // Find these in your Firebase project: Project settings → General →
    // "Your apps" → Web app → SDK setup and configuration.
    FIREBASE: {
        apiKey:            'AIzaSyBp4lTpf7tZrJOJOjv6olB0RgdVd8INOlI',
        authDomain:        'sate-hujung-minggu.firebaseapp.com',
        projectId:         'sate-hujung-minggu',
        storageBucket:     'sate-hujung-minggu.firebasestorage.app',
        messagingSenderId: '1027593948630',
        appId:             '1:1027593948630:web:2783052925848ec35f2877'
    },

    // Firebase project settings → Cloud Messaging → Web configuration →
    // "Web Push certificates" (generate one if you don't have one yet).
    // This one is safe to be public — it's the PUBLIC half of the key pair.
    VAPID_PUBLIC_KEY: 'BGhAz7NFT1wIyiBhqqCvl5hv1QCqjYjyaYZy5r0x-1MH58kVb8Q3QaZE6wlG3pff_qqROB44NfTECGNmAciJU1E',

    // ⚠️ IMPORTANT: manifest.json also has a "gcm_sender_id" field that must
    // match FIREBASE.messagingSenderId above. manifest.json is a plain JSON
    // file (not code), so it can't read this config automatically — if you
    // ever change messagingSenderId, open manifest.json and update
    // gcm_sender_id to match by hand.

    // ── App info ──────────────────────────────────────────────────────────────
    APP_NAME: 'My Shop',              // ← change this to your business name. Shown as the fallback before the Business Name setting (Settings → Others) loads, and used as the default anywhere else the app needs a name.
    VERSION:  '1.0.0'                  // shown in Settings, just for your own reference when troubleshooting
};
