import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const SUPABASE_URL      = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const FCM_PROJECT_ID   = "sate-hujung-minggu";
const FCM_CLIENT_EMAIL = "firebase-adminsdk-fbsvc@sate-hujung-minggu.iam.gserviceaccount.com";
const FCM_KEY_B64      = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDJ6Eu714+tYoeKtcjBz4pzSj7qNwPHhNSCvq+v/+i41ahuxmW184JNGGMiYvcRVOtQh/AJmB/X8ar1HE2yRtuSXr5tVYRgHt5aUdo0OtHrZP8JlgAJqmIG6zKsQIki+MrPJn42RCb7uFpCJgJ59u5P5Ek7K27WMbdygWTdH1FeffF5x4UQ4XZVIgspojycy3przE44VBY2bJuveVMcAQg6ybhvlqJsAQTcTSnSC/C4bfoix0MoOWYS25hkRSBgO5twVWkelyLqovXpvxalxyjylz3Kq7KFypG3IrR5Q7uud/fnzKRn+inB7KIR3RGYDSZG3CugVOGvQtA/vIbYtUUpAgMBAAECggEAAUFkAyl+d7YGoLqromTfeAMMrBkmeV2ekqeL4RzGvit57iJmrIB0nXUa3LJf1ehAxFHsEKs0+3tBtF92LjcZk2nqZjSja5OVj1s176A0APIyUcVwf57jGCbrPD30fFausCYNn9nBokwNp56j4k1CQxXozKji+gr6GIisb2GL+HnuKHZ1qwSDEWLqoPZjA5ueC9sZ+bdzz/nIMWNU/yO71doKMs2AfzBJsq4s3ZkMNXKZ5T5LYGliNzk9ZMZPnGuJAcIQuQZBlLHpi1NA9tI4L+3W7M+FBBTsDcWZhl4sm2k/L8T+q9+5KARmAmMpZQ4WTgkKqoqtT9fh/xA9zy62twKBgQD7g5+I058farx44W11AzyXxCpl8ZlyGSYqgqFJOVkBt5j7UVCOT7l2FOV4rti9FY2wTK3qYZR0RsMDR1WnDinleWVPn+xZFqgDI1zuD/BOYeOfpJCU03STc3ewz6VzT6m1En9sP0Iu6lB1FTX0+PRrURe/H7vjfZOLj+N7cZe6VwKBgQDNgiztzfNxrciBtdIp63VYdonTqMbfhsHIE7MLybJoJan0L7zwLqIXwEKZF/JNZW4M/yDPYVZWPsY2PhpDxtOQFk23b5pjdW/2FLlMqTLiArT3Qwny6fjub9x1E6mbPep4OMK72pJEgdLQdXpUtgm9tckCR9eXyAVvcI/vzxJMfwKBgA9tf3exI22V6oGvsjsfO7RDgCZIr5TkHgc1hBctwVvtmyCvWDWihknL9ld0wi63B73sti5OVgDb5lJpKcPZhpBg5eoAcUr1rNCkdqrTp3XnY0MDoSq/3cK9rnXWBtwP4uUMgWxuZOzjypOj/W9NZhC/JKnAlJHbvhUtelK0IQ55AoGAR/QGCxUK4Yh5JYElnmvEYD7Qrvzu9KBYBNdw3vW1s2VMhiSYwHdzZWF5b+TEf3i9+Wryb+misvuzppZD1+src817VHiM07nwg3ZqEn9DQ4KzHcepGhX1hHZB9/P0dFhPWdx1whQbFkVmLHqVZEeATZ3yTQweXhQ4YvZETzBvNb0CgYEAiCoNOWX6KQtKIXF+efjuOCSibOof3jcZRjSl9+U/EJVfgys2w2Pf8GfZ0aq45akvZ2SsoO4Bk/QLkat/uLRgXQmOoS/b7gxs0to341z9vIdB0NPbkv+MRTwGQp4Bd4tSr8F5olF85i4oVnquupVlRqpQWUszzKlDq9qBMFz6tQk=";

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
          icon:  "https://brookrthesoul.github.io/sate-hujung-minggu/icon-192.png",
          badge: "https://brookrthesoul.github.io/sate-hujung-minggu/icon-192.png",
          requireInteraction: true,
          vibrate: [200, 100, 200],
        },
        fcm_options: { link: "https://brookrthesoul.github.io/sate-hujung-minggu/" }
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
    icon: "https://brookrthesoul.github.io/sate-hujung-minggu/icon-192.png" });

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

  // VAPID public key for legacy endpoint
  const VAPID_PUB = "BFtZOppJvX5JN9_jEMDYLhr8VLMaOxeOY6w8hFXwLRD0aZ0Jl4bvhCDvUwOQapHKU9E_FZpJXuI74G10W12_Z_E";
  const VAPID_PRIV = "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg08EzcXzvbclKz95ZUTZM6sth0bCTDiEUiNTZSmuHm9KhRANCAARbWTqaSb1-STff4xDA2C4a_FSzGjsXjmOsPIRV8C0Q9GmdCZeG74Qg71MDkGqRylPRPxWaSV7iO-BtdFtdv2fx";

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
