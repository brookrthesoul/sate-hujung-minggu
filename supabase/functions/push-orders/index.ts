import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const SUPABASE_URL      = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const FCM_PROJECT_ID   = "sate-hujung-minggu";
const FCM_CLIENT_EMAIL = "firebase-adminsdk-fbsvc@sate-hujung-minggu.iam.gserviceaccount.com";
// Raw PKCS8 DER in base64 — no PEM headers, no newlines
const FCM_KEY_B64      = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDJ6Eu714+tYoeKtcjBz4pzSj7qNwPHhNSCvq+v/+i41ahuxmW184JNGGMiYvcRVOtQh/AJmB/X8ar1HE2yRtuSXr5tVYRgHt5aUdo0OtHrZP8JlgAJqmIG6zKsQIki+MrPJn42RCb7uFpCJgJ59u5P5Ek7K27WMbdygWTdH1FeffF5x4UQ4XZVIgspojycy3przE44VBY2bJuveVMcAQg6ybhvlqJsAQTcTSnSC/C4bfoix0MoOWYS25hkRSBgO5twVWkelyLqovXpvxalxyjylz3Kq7KFypG3IrR5Q7uud/fnzKRn+inB7KIR3RGYDSZG3CugVOGvQtA/vIbYtUUpAgMBAAECggEAAUFkAyl+d7YGoLqromTfeAMMrBkmeV2ekqeL4RzGvit57iJmrIB0nXUa3LJf1ehAxFHsEKs0+3tBtF92LjcZk2nqZjSja5OVj1s176A0APIyUcVwf57jGCbrPD30fFausCYNn9nBokwNp56j4k1CQxXozKji+gr6GIisb2GL+HnuKHZ1qwSDEWLqoPZjA5ueC9sZ+bdzz/nIMWNU/yO71doKMs2AfzBJsq4s3ZkMNXKZ5T5LYGliNzk9ZMZPnGuJAcIQuQZBlLHpi1NA9tI4L+3W7M+FBBTsDcWZhl4sm2k/L8T+q9+5KARmAmMpZQ4WTgkKqoqtT9fh/xA9zy62twKBgQD7g5+I058farx44W11AzyXxCpl8ZlyGSYqgqFJOVkBt5j7UVCOT7l2FOV4rti9FY2wTK3qYZR0RsMDR1WnDinleWVPn+xZFqgDI1zuD/BOYeOfpJCU03STc3ewz6VzT6m1En9sP0Iu6lB1FTX0+PRrURe/H7vjfZOLj+N7cZe6VwKBgQDNgiztzfNxrciBtdIp63VYdonTqMbfhsHIE7MLybJoJan0L7zwLqIXwEKZF/JNZW4M/yDPYVZWPsY2PhpDxtOQFk23b5pjdW/2FLlMqTLiArT3Qwny6fjub9x1E6mbPep4OMK72pJEgdLQdXpUtgm9tckCR9eXyAVvcI/vzxJMfwKBgA9tf3exI22V6oGvsjsfO7RDgCZIr5TkHgc1hBctwVvtmyCvWDWihknL9ld0wi63B73sti5OVgDb5lJpKcPZhpBg5eoAcUr1rNCkdqrTp3XnY0MDoSq/3cK9rnXWBtwP4uUMgWxuZOzjypOj/W9NZhC/JKnAlJHbvhUtelK0IQ55AoGAR/QGCxUK4Yh5JYElnmvEYD7Qrvzu9KBYBNdw3vW1s2VMhiSYwHdzZWF5b+TEf3i9+Wryb+misvuzppZD1+src817VHiM07nwg3ZqEn9DQ4KzHcepGhX1hHZB9/P0dFhPWdx1whQbFkVmLHqVZEeATZ3yTQweXhQ4YvZETzBvNb0CgYEAiCoNOWX6KQtKIXF+efjuOCSibOof3jcZRjSl9+U/EJVfgys2w2Pf8GfZ0aq45akvZ2SsoO4Bk/QLkat/uLRgXQmOoS/b7gxs0to341z9vIdB0NPbkv+MRTwGQp4Bd4tSr8F5olF85i4oVnquupVlRqpQWUszzKlDq9qBMFz6tQk=";

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

  // Decode base64 to DER bytes
  const binary = atob(FCM_KEY_B64);
  const der = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) der[i] = binary.charCodeAt(i);
  console.log("[auth] DER length:", der.length, "first byte:", der[0]);

  const privKey = await crypto.subtle.importKey(
    "pkcs8", der.buffer.slice(der.byteOffset, der.byteOffset + der.byteLength),
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
  console.log("[auth] response keys:", Object.keys(data).join(","));
  if (!data.access_token) throw new Error("OAuth failed: " + JSON.stringify(data));
  return data.access_token;
}

async function sendFCMv1(token: string, title: string, body: string, tag: string, accessToken: string): Promise<string> {
  const url = "https://fcm.googleapis.com/v1/projects/" + FCM_PROJECT_ID + "/messages:send";
  const msg = {
    message: {
      token,
      notification: { title, body },
      webpush: {
        notification: {
          title, body, tag,
          icon:  "https://brookrthesoul.github.io/sate-hujung-minggu/icon-192.png",
          badge: "https://brookrthesoul.github.io/sate-hujung-minggu/icon-192.png",
          requireInteraction: true,
          vibrate: [200, 100, 200, 100, 200],
        },
        fcm_options: { link: "https://brookrthesoul.github.io/sate-hujung-minggu/" }
      },
      data: { title, body, tag }
    }
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + accessToken },
    body: JSON.stringify(msg),
  });
  const txt = await res.text();
  console.log("[fcm] status=" + res.status + " body=" + txt.slice(0, 200));
  if (res.status === 404 || res.status === 410) return "gone";
  if (!res.ok) throw new Error("FCM failed " + res.status + ": " + txt);
  return "ok";
}

function extractToken(endpoint: string): string | null {
  const m = endpoint.match(/fcm\/send\/(.+)$/);
  return m ? m[1] : null;
}

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
  console.log("[push-orders] got access token OK");

  const gone: string[] = [];
  await Promise.allSettled(subs.map(async (s) => {
    try {
      const token = extractToken(s.endpoint);
      if (!token) { console.warn("[push-orders] no token in:", s.endpoint); return; }
      const result = await sendFCMv1(token, "🍢 New Order!", msgBody, tag, accessToken);
      if (result === "gone") gone.push(s.endpoint);
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
