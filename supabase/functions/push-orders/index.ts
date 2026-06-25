// Supabase Edge Function — triggered by DB webhook on orders INSERT
// Deploy: supabase functions deploy push-orders

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const SUPABASE_URL      = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const VAPID_PUBLIC_KEY  = "BA0chhJSJEf1dx_hgn1ktNYQEJRZyQxPKWDXPk0Cp-t090ZYbPAfPgxS9aFhwGeFpPMngJqOEaa_ez810uvduWg";
const VAPID_PRIVATE_KEY = "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg9JGomljzZ9UssIjAfW5LubS5EDiydnmHrlMU4eh0OQOhRANCAAQNHIYSUiRH9Xcf4YJ9ZLTWEBCUWckMTylg1z5NAqfrdPdGWGzwHz4MUvWhYcBnhaTzJ4CajhGmv3s_NdLr3blo";
const VAPID_SUBJECT     = "mailto:admin@yourdomain.com"; // change this

// ── Minimal VAPID / Web Push implementation using WebCrypto ──────────────────

function b64url(buf: Uint8Array): string {
  return btoa(String.fromCharCode(...buf)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}

async function makeVapidToken(audience: string): Promise<string> {
  const header  = b64url(new TextEncoder().encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const now     = Math.floor(Date.now() / 1000);
  const payload = b64url(new TextEncoder().encode(JSON.stringify({ aud: audience, exp: now + 43200, sub: VAPID_SUBJECT })));
  const unsigned = `${header}.${payload}`;

  const privDer = b64urlDecode(VAPID_PRIVATE_KEY);
  const privKey = await crypto.subtle.importKey("pkcs8", privDer,
    { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);

  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privKey,
    new TextEncoder().encode(unsigned)
  );
  return `${unsigned}.${b64url(new Uint8Array(sig))}`;
}

async function sendPush(sub: { endpoint: string; keys: { p256dh: string; auth: string } }, payload: string) {
  const url      = new URL(sub.endpoint);
  const audience = `${url.protocol}//${url.host}`;
  const jwt      = await makeVapidToken(audience);

  // ECDH + AES-128-GCM encryption (RFC 8291)
  const serverKeys = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveKey", "deriveBits"]);
  const serverPubRaw = new Uint8Array(await crypto.subtle.exportKey("raw", serverKeys.publicKey));

  const clientPubRaw = b64urlDecode(sub.keys.p256dh);
  const authSecret   = b64urlDecode(sub.keys.auth);

  const clientPubKey = await crypto.subtle.importKey("raw", clientPubRaw,
    { name: "ECDH", namedCurve: "P-256" }, false, []);
  const sharedBits   = await crypto.subtle.deriveBits({ name: "ECDH", public: clientPubKey }, serverKeys.privateKey, 256);

  // PRK (HKDF-SHA-256)
  const enc     = new TextEncoder();
  const salt    = crypto.getRandomValues(new Uint8Array(16));
  const ikm     = new Uint8Array(sharedBits);

  async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, len: number): Promise<Uint8Array> {
    const k   = await crypto.subtle.importKey("raw", ikm, { name: "HKDF" }, false, ["deriveBits"]);
    const prk = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info: new Uint8Array() }, k, 256);
    const k2  = await crypto.subtle.importKey("raw", prk, { name: "HKDF" }, false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(), info }, k2, len * 8);
    return new Uint8Array(bits);
  }

  function concat(...arrays: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
    let off = 0; for (const a of arrays) { out.set(a, off); off += a.length; }
    return out;
  }

  const keyInfo  = concat(enc.encode("Content-Encoding: aes128gcm\0"), new Uint8Array(1));
  const nonceInfo= concat(enc.encode("Content-Encoding: nonce\0"), new Uint8Array(1));
  const prkSalt  = concat(enc.encode("WebPush: info\0"), clientPubRaw, serverPubRaw);

  const prk     = await hkdf(authSecret, ikm, prkSalt, 32);
  const cek     = await hkdf(salt, prk, keyInfo,  16);
  const nonce   = await hkdf(salt, prk, nonceInfo, 12);

  const aesKey  = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  const rs      = 4096;
  const padLen  = 0;
  const header  = concat(
    salt,
    new Uint8Array([0, 0, 16, 0]),      // rs big-endian + keylen
    new Uint8Array([serverPubRaw.length]),
    serverPubRaw
  );
  const record  = concat(enc.encode(payload), new Uint8Array([2])); // delimiter
  const encrypted = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce }, aesKey, record
  ));

  const body = concat(header, encrypted);

  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      "Content-Type":   "application/octet-stream",
      "Content-Encoding": "aes128gcm",
      "Authorization":  `vapid t=${jwt},k=${VAPID_PUBLIC_KEY}`,
      "TTL":            "86400",
    },
    body
  });

  if (!res.ok && res.status !== 201) {
    const txt = await res.text();
    // 410 = subscription expired, caller should delete it
    if (res.status === 410 || res.status === 404) return "gone";
    throw new Error(`Push failed ${res.status}: ${txt}`);
  }
  return "ok";
}

// ── Main handler ─────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  let body: any;
  try { body = await req.json(); } catch { return new Response("Bad JSON", { status: 400 }); }

  // Supabase DB webhook sends { type, table, record, ... }
  const record = body.record ?? body;
  if (!record) return new Response("No record", { status: 400 });

  const orderData = record.data ?? {};
  const items     = orderData.items && typeof orderData.items === "object"
    ? Object.values(orderData.items) as any[] : [];
  const parts     = items.filter((i: any) => i.qty > 0).map((i: any) => `${i.qty}× ${i.name}`);
  const label     = orderData.description || `Order #${record.id}`;
  const msgBody   = parts.length > 0 ? `${label}: ${parts.join(", ")}` : label;

  const notification = JSON.stringify({
    title: "🍢 New Order!",
    body:  msgBody,
    tag:   `new-order-${record.id}`
  });

  // Fetch all push subscriptions
  const subRes = await fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions?select=*`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` }
  });
  const subs: any[] = await subRes.json();

  const gone: string[] = [];
  await Promise.allSettled(subs.map(async (s) => {
    try {
      const result = await sendPush({ endpoint: s.endpoint, keys: s.keys }, notification);
      if (result === "gone") gone.push(s.endpoint);
    } catch(e) { console.error("push error", e); }
  }));

  // Clean up expired subscriptions
  for (const ep of gone) {
    await fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions?endpoint=eq.${encodeURIComponent(ep)}`, {
      method: "DELETE",
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` }
    });
  }

  return new Response(JSON.stringify({ sent: subs.length, gone: gone.length }), {
    headers: { "Content-Type": "application/json" }
  });
});
