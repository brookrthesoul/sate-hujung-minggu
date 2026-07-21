import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const SUPABASE_URL      = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

// ⚠️ These used to be hardcoded here — that's a real security problem if this
// file is ever committed to a public (or even private-but-shared) repo, since
// FCM_KEY_B64 and VAPID_PRIV are private keys that grant push-sending power.
// They now come from Supabase Edge Function secrets instead — see SETUP.md
// "Push notifications" section for how to set them (one-time, via the
// Supabase dashboard or `supabase secrets set`).
const FCM_PROJECT_ID   = Deno.env.get("FCM_PROJECT_ID")!;
const FCM_CLIENT_EMAIL = Deno.env.get("FCM_CLIENT_EMAIL")!;
const FCM_KEY_B64      = Deno.env.get("FCM_KEY_B64")!;
const VAPID_PUB        = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_PRIV       = Deno.env.get("VAPID_PRIVATE_KEY")!;

// The live site's URL — used to build the notification icon and the link the
// notification opens when tapped. Set as a secret too so this file never has
// to be edited when you switch hosting providers or domains.
const SITE_URL = (Deno.env.get("SITE_URL") ?? "").replace(/\/+$/, "");

// ── helpers ──────────────────────────────────────────────────────────────────

function b64u(buf: Uint8Array): string {
  return btoa(String.fromCharCode(...buf))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function getAccessToken(): Promise<string> {
  const enc = new TextEncoder();
  const now = Math.floor(Date.now() / 1000);
  const header  = b64u(enc.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const payload = b64u(enc.encode(JSON.stringify({
    iss: FCM_CLIENT_EMAIL,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: now, exp: now + 3600,
  })));
  const signing = header + "." + payload;

  const binary = atob(FCM_KEY_B64);
  const der = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) der[i] = binary.charCodeAt(i);

  const privKey = await crypto.subtle.importKey(
    "pkcs8", der.buffer.slice(0),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false, ["sign"]
  );
  const sig = new Uint8Array(await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" }, privKey, enc.encode(signing)
  ));
  const jwt = signing + "." + b64u(sig);

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=" + jwt,
  });
  const data = await res.json();
  if (!data.access_token) throw new Error("OAuth failed: " + JSON.stringify(data));
  console.log("[auth] got access token OK");
  return data.access_token;
}

// Extract FCM registration token from endpoint URL
// Legacy: https://fcm.googleapis.com/fcm/send/TOKEN
function extractToken(endpoint: string): string | null {
  const m = endpoint.match(/fcm\/send\/(.+)$/);
  return m ? m[1] : null;
}

async function sendFCMv1(token: string, title: string, body: string, tag: string, accessToken: string): Promise<string> {
  const url = "https://fcm.googleapis.com/v1/projects/" + FCM_PROJECT_ID + "/messages:send";

  // Try with registration token directly
  const msg = {
    message: {
      token,
      webpush: {
        headers: { TTL: "86400" },
        notification: {
          title, body, tag,
          icon:  `${SITE_URL}/icon-192.png`,
          badge: `${SITE_URL}/icon-192.png`,
          requireInteraction: true,
          vibrate: [200, 100, 200],
        },
        fcm_options: { link: `${SITE_URL}/?tab=orders` }
      },
      data: { title, body, tag }
    }
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + accessToken,
    },
    body: JSON.stringify(msg),
  });

  const txt = await res.text();
  console.log("[fcm] status=" + res.status + " body=" + txt.slice(0, 300));
  if (res.status === 404 || res.status === 410) return "gone";
  if (!res.ok) throw new Error("FCM failed " + res.status + ": " + txt);
  return "ok";
}

// ── Also try legacy FCM send as fallback ─────────────────────────────────────
// Uses the full endpoint URL directly with VAPID-style Web Push
async function sendLegacyFCM(endpoint: string, keys: {p256dh: string, auth: string}, title: string, body: string, tag: string): Promise<string> {
  // Build minimal JSON payload — legacy FCM /fcm/send supports raw JSON for web push
  // when called with the full endpoint
  const payload = JSON.stringify({ title, body, tag,
    icon: `${SITE_URL}/icon-192.png` });

  // Use Web Push encryption
  const enc = new TextEncoder();

  function anyB64Dec(s: string): Uint8Array {
    s = s.replace(/-/g,"+").replace(/_/g,"/");
    while(s.length%4) s+="=";
    return Uint8Array.from(atob(s), c=>c.charCodeAt(0));
  }
  function concat(...arrays: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(arrays.reduce((n,a)=>n+a.length,0));
    let off=0; for(const a of arrays){out.set(a,off);off+=a.length;} return out;
  }
  async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, len: number): Promise<Uint8Array> {
    const k = await crypto.subtle.importKey("raw",ikm,{name:"HKDF"},false,["deriveBits"]);
    const prk = new Uint8Array(await crypto.subtle.deriveBits({name:"HKDF",hash:"SHA-256",salt,info:new Uint8Array()},k,256));
    const k2 = await crypto.subtle.importKey("raw",prk,{name:"HKDF"},false,["deriveBits"]);
    return new Uint8Array(await crypto.subtle.deriveBits({name:"HKDF",hash:"SHA-256",salt:new Uint8Array(32),info},k2,len*8));
  }

  const clientPub  = anyB64Dec(keys.p256dh);
  const authSecret = anyB64Dec(keys.auth);
  const serverPair = await crypto.subtle.generateKey({name:"ECDH",namedCurve:"P-256"},true,["deriveBits"]);
  const serverPub  = new Uint8Array(await crypto.subtle.exportKey("raw",serverPair.publicKey));
  const clientKey  = await crypto.subtle.importKey("raw",clientPub,{name:"ECDH",namedCurve:"P-256"},false,[]);
  const shared     = new Uint8Array(await crypto.subtle.deriveBits({name:"ECDH",public:clientKey},serverPair.privateKey,256));
  const salt       = crypto.getRandomValues(new Uint8Array(16));
  const prkInfo    = concat(enc.encode("WebPush: info\0"),clientPub,serverPub);
  const prk        = await hkdf(authSecret,shared,prkInfo,32);
  const cek        = await hkdf(salt,prk,enc.encode("Content-Encoding: aes128gcm\0"),16);
  const nonce      = await hkdf(salt,prk,enc.encode("Content-Encoding: nonce\0"),12);
  const aesKey     = await crypto.subtle.importKey("raw",cek,{name:"AES-GCM"},false,["encrypt"]);
  const plaintext  = concat(enc.encode(payload),new Uint8Array([2]));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({name:"AES-GCM",iv:nonce},aesKey,plaintext));
  const rs = new Uint8Array(4); new DataView(rs.buffer).setUint32(0,4096,false);
  const body2 = concat(salt,rs,new Uint8Array([serverPub.length]),serverPub,ciphertext);

  // VAPID keys come from the top-level constants (Edge Function secrets) now.

  const url2 = new URL(endpoint);
  const audience = url2.protocol+"//"+url2.host;
  const now2 = Math.floor(Date.now()/1000);
  const jHeader = b64u(enc.encode(JSON.stringify({typ:"JWT",alg:"ES256"})));
  const jPayload = b64u(enc.encode(JSON.stringify({aud:audience,exp:now2+43200,sub:"mailto:admin@example.com"})));
  const jSigning = jHeader+"."+jPayload;
  const ecPrivBin = atob(VAPID_PRIV.replace(/-/g,"+").replace(/_/g,"/"));
  const ecPrivDer = new Uint8Array(ecPrivBin.length); for(let i=0;i<ecPrivBin.length;i++) ecPrivDer[i]=ecPrivBin.charCodeAt(i);
  const ecKey = await crypto.subtle.importKey("pkcs8",ecPrivDer,{name:"ECDSA",namedCurve:"P-256"},false,["sign"]);
  const jSig = new Uint8Array(await crypto.subtle.sign({name:"ECDSA",hash:"SHA-256"},ecKey,enc.encode(jSigning)));
  const vapidJwt = jSigning+"."+b64u(jSig);

  const res2 = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Encoding": "aes128gcm",
      "Authorization": "vapid t="+vapidJwt+",k="+VAPID_PUB,
      "TTL": "86400",
    },
    body: body2
  });
  const txt2 = await res2.text();
  console.log("[legacy] status="+res2.status+" body="+txt2.slice(0,200));
  if(res2.status===410||res2.status===404) return "gone";
  return res2.ok||res2.status===201 ? "ok" : "fail";
}

// ── Main ─────────────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  let body: any;
  try { body = await req.json(); } catch { return new Response("Bad JSON", { status: 400 }); }

  const record    = body.record ?? body;
  const orderData = record?.data ?? {};
  const items     = orderData.items && typeof orderData.items === "object" ? Object.values(orderData.items) as any[] : [];
  const parts     = items.filter((i: any) => i.qty > 0).map((i: any) => i.qty + "x " + i.name);
  const label     = orderData.description || "Order #" + record?.id;
  const msgBody   = parts.length > 0 ? label + ": " + parts.join(", ") : label;
  const tag       = "new-order-" + record?.id;

  console.log("[push-orders] sending:", msgBody);

  const subRes = await fetch(SUPABASE_URL + "/rest/v1/push_subscriptions?select=*", {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: "Bearer " + SUPABASE_ANON_KEY }
  });
  const subs: any[] = await subRes.json();
  console.log("[push-orders]", subs.length, "subscription(s)");
  if (subs.length === 0) return new Response(JSON.stringify({ sent: 0 }), { headers: { "Content-Type": "application/json" } });

  const accessToken = await getAccessToken();

  const gone: string[] = [];
  await Promise.allSettled(subs.map(async (s) => {
    try {
      // Prefer firebase_token column, fall back to extracting from endpoint
      const fcmToken = s.firebase_token || extractToken(s.endpoint);
      console.log("[push-orders] using token:", fcmToken?.slice(0, 30) + "...");

      if (fcmToken) {
        const result = await sendFCMv1(fcmToken, "🍢 New Order!", msgBody, tag, accessToken);
        if (result === "gone") gone.push(s.endpoint);
      } else {
        console.warn("[push-orders] no token for endpoint:", s.endpoint);
      }
    } catch(e) { console.error("[push-orders] error:", String(e)); }
  }));

  for (const ep of gone) {
    await fetch(SUPABASE_URL + "/rest/v1/push_subscriptions?endpoint=eq." + encodeURIComponent(ep), {
      method: "DELETE", headers: { apikey: SUPABASE_ANON_KEY, Authorization: "Bearer " + SUPABASE_ANON_KEY }
    });
  }

  return new Response(JSON.stringify({ sent: subs.length - gone.length, gone: gone.length }), {
    headers: { "Content-Type": "application/json" }
  });
});
