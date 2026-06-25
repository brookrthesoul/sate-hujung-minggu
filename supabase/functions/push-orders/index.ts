import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const SUPABASE_URL      = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const VAPID_PUBLIC_KEY  = "BFtZOppJvX5JN9_jEMDYLhr8VLMaOxeOY6w8hFXwLRD0aZ0Jl4bvhCDvUwOQapHKU9E_FZpJXuI74G10W12_Z_E";
const VAPID_PRIVATE_KEY = "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg08EzcXzvbclKz95ZUTZM6sth0bCTDiEUiNTZSmuHm9KhRANCAARbWTqaSb1-STff4xDA2C4a_FSzGjsXjmOsPIRV8C0Q9GmdCZeG74Qg71MDkGqRylPRPxWaSV7iO-BtdFtdv2fx";
const VAPID_SUBJECT     = "mailto:admin@example.com";

// ── base64 helpers ────────────────────────────────────────────────────────────

// Decode ANY base64 variant (standard or url-safe, with or without padding)
function anyB64Dec(s: string): Uint8Array {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}

// Encode to url-safe base64 no padding
function b64u(buf: Uint8Array): string {
  return btoa(String.fromCharCode(...buf))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function concat(...arrays: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}

// ── HKDF ─────────────────────────────────────────────────────────────────────

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, len: number): Promise<Uint8Array> {
  const ikmKey = await crypto.subtle.importKey("raw", ikm, { name: "HKDF" }, false, ["deriveBits"]);
  const prk    = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info: new Uint8Array() }, ikmKey, 256
  ));
  const prkKey = await crypto.subtle.importKey("raw", prk, { name: "HKDF" }, false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info }, prkKey, len * 8
  ));
}

// ── VAPID JWT ─────────────────────────────────────────────────────────────────

async function makeVapidJwt(audience: string): Promise<string> {
  const enc     = new TextEncoder();
  const header  = b64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const now     = Math.floor(Date.now() / 1000);
  const payload = b64u(enc.encode(JSON.stringify({ aud: audience, exp: now + 43200, sub: VAPID_SUBJECT })));
  const signing = `${header}.${payload}`;
  const privKey = await crypto.subtle.importKey(
    "pkcs8", anyB64Dec(VAPID_PRIVATE_KEY),
    { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]
  );
  const sig = new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, privKey, enc.encode(signing)
  ));
  return `${signing}.${b64u(sig)}`;
}

// ── Web Push encryption (RFC 8291 aes128gcm) ──────────────────────────────────

async function encryptPayload(
  payload: string,
  p256dhRaw: string,   // may be standard or url-safe base64
  authRaw: string
): Promise<Uint8Array> {
  const enc        = new TextEncoder();
  const clientPub  = anyB64Dec(p256dhRaw);
  const authSecret = anyB64Dec(authRaw);

  console.log(`[encrypt] clientPub len=${clientPub.length} auth len=${authSecret.length}`);

  const serverPair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const serverPub  = new Uint8Array(await crypto.subtle.exportKey("raw", serverPair.publicKey));

  const clientKey  = await crypto.subtle.importKey(
    "raw", clientPub, { name: "ECDH", namedCurve: "P-256" }, false, []
  );
  const shared = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "ECDH", public: clientKey }, serverPair.privateKey, 256
  ));

  const salt = crypto.getRandomValues(new Uint8Array(16));

  // PRK
  const prkInfo = concat(enc.encode("WebPush: info\0"), clientPub, serverPub);
  const prk     = await hkdf(authSecret, shared, prkInfo, 32);

  // CEK and nonce
  const cek   = await hkdf(salt, prk, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, prk, enc.encode("Content-Encoding: nonce\0"), 12);

  // Encrypt
  const aesKey    = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  const plaintext = concat(enc.encode(payload), new Uint8Array([2]));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, plaintext));

  // aes128gcm content header: salt(16) + rs(4BE) + keyid_len(1) + keyid
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096, false);
  return concat(salt, rs, new Uint8Array([serverPub.length]), serverPub, ciphertext);
}

// ── Send ──────────────────────────────────────────────────────────────────────

async function sendWebPush(endpoint: string, keys: { p256dh: string; auth: string }, payload: string): Promise<string> {
  const url      = new URL(endpoint);
  const audience = `${url.protocol}//${url.host}`;
  const jwt      = await makeVapidJwt(audience);
  const body     = await encryptPayload(payload, keys.p256dh, keys.auth);

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type":     "application/octet-stream",
      "Content-Encoding": "aes128gcm",
      "Authorization":    `vapid t=${jwt},k=${VAPID_PUBLIC_KEY}`,
      "TTL":              "86400",
    },
    body
  });

  const txt = await res.text();
  console.log(`[push] status=${res.status} body=${txt.slice(0, 200)}`);
  if (res.status === 410 || res.status === 404) return "gone";
  if (!res.ok && res.status !== 201) throw new Error(`Push failed ${res.status}: ${txt}`);
  return "ok";
}

// ── Main ──────────────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  let body: any;
  try { body = await req.json(); } catch { return new Response("Bad JSON", { status: 400 }); }

  const record    = body.record ?? body;
  const orderData = record?.data ?? {};
  const items     = orderData.items && typeof orderData.items === "object"
    ? Object.values(orderData.items) as any[] : [];
  const parts     = items.filter((i: any) => i.qty > 0).map((i: any) => `${i.qty}× ${i.name}`);
  const label     = orderData.description || `Order #${record?.id}`;
  const msgBody   = parts.length > 0 ? `${label}: ${parts.join(", ")}` : label;
  const notification = JSON.stringify({ title: "🍢 New Order!", body: msgBody, tag: `new-order-${record?.id}` });

  console.log(`[push-orders] sending: ${msgBody}`);

  const subRes = await fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions?select=*`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` }
  });
  const subs: any[] = await subRes.json();
  console.log(`[push-orders] ${subs.length} subscription(s)`);

  const gone: string[] = [];
  await Promise.allSettled(subs.map(async (s) => {
    try {
      const keys = typeof s.keys === "string" ? JSON.parse(s.keys) : s.keys;
      console.log(`[push-orders] keys: p256dh=${keys.p256dh?.slice(0,20)}... auth=${keys.auth?.slice(0,10)}...`);
      const result = await sendWebPush(s.endpoint, keys, notification);
      if (result === "gone") gone.push(s.endpoint);
    } catch(e) { console.error("[push-orders] error:", String(e)); }
  }));

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
