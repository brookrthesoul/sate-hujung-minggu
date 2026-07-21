# Setup Guide — Sate Hujung Minggu PWA

This guide walks through setting this app up completely from scratch, even if
you've never coded before. Follow the parts **in order** — each one depends on
the last.

**Accounts you'll need (all free):**
1. [GitHub](https://github.com) — stores your app's files
2. [Netlify](https://netlify.com) — hosts the live website
3. [Supabase](https://supabase.com) — the database
4. [Firebase](https://firebase.google.com) — push notifications ("New Order!" alerts)

**Hosting: GitHub vs Netlify.** You mentioned you're currently using GitHub to
host the site — I'd recommend switching hosting to **Netlify** instead, while
still keeping your files stored on GitHub. Reasons:
- Netlify gives you HTTPS automatically with zero setup (this PWA *requires*
  HTTPS to work — service workers, push notifications, and "Add to Home
  Screen" all refuse to run without it).
- GitHub Pages runs your site through a tool called Jekyll by default, which
  can quietly ignore or mangle certain files unless you remember to add a
  `.nojekyll` file. Netlify doesn't do this — it just serves your files as-is.
- Netlify auto-deploys the moment you save a change on GitHub — no separate
  "enable Pages" step, and it gives you a dashboard with deploy logs if
  something goes wrong.
- If you ever want a custom domain (e.g. `order.yourshop.com`), it's a few
  clicks in Netlify.

So: **GitHub holds the code, Netlify serves the website.** You'll connect the
two once in Part 6, and after that every change you make on GitHub goes live
automatically.

---

## Part 1 — Get the code onto GitHub

If your code is already on GitHub, skip to Part 2.

1. Go to [github.com](https://github.com) and create a free account if you
   don't have one.
2. Click the **+** icon (top right) → **New repository**.
3. Name it something like `sate-hujung-minggu`. Set it to **Private** (recommended —
   keeps your Supabase project structure less visible, though your real
   secrets are never in this repo anyway once you finish this guide).
   Click **Create repository**.
4. On the new repo's page, click **uploading an existing file**.
5. Drag in every file and folder from the project (all the `.html`, `.js`,
   `.css`, `.json` files, the `icon-192.png`/`icon-512.png` images, and the
   whole `supabase` folder).
6. Scroll down, click **Commit changes**.

You now have the code on GitHub. You'll edit files here later (Part 5) using
GitHub's built-in editor — no extra software needed.

---

## Part 2 — Set up Supabase (the database)

1. Go to [supabase.com](https://supabase.com) → sign up / log in.
2. Click **New project**. Pick an organization, name the project (e.g.
   `sate-hujung-minggu`), set a database password (save it somewhere — a
   password manager or a note; you likely won't need it again, but keep it
   just in case), pick the region closest to your customers, click **Create
   new project**. Wait a minute or two for it to finish setting up.
3. In the left sidebar, click the **SQL Editor** icon (looks like `>_`).
4. You're going to run several `.sql` files from the `supabase/migrations`
   folder, **one at a time, in this exact order**. For each one:
   - Open the file on GitHub (click into the `supabase/migrations` folder,
     click the filename).
   - Click the **Copy raw file** button (or select-all and copy the text).
   - Back in Supabase's SQL Editor, click **New query**, paste the text in,
     click **Run** (bottom right).
   - You should see "Success. No rows returned" (or similar). If you see a
     red error instead, stop and check you copied the *whole* file and ran
     the previous ones first.

   **Run these in this order:**
   1. `orders_table.sql`
   2. `menu_table.sql`
   3. `stock_table.sql`
   4. `settings_table.sql`
   5. `push_subscriptions.sql`
   6. `customer_order_rpc.sql`
   7. `reset_sequence_rpc.sql`
   8. `customer_info.sql`
   9. `legal_policies.sql`
   10. `customer_blocklist.sql`

5. **Get your API keys** (needed for Part 5): in the left sidebar, click the
   ⚙️ **Project Settings** → **API**. You'll need two values from this page:
   - **Project URL** (looks like `https://xxxxxxxx.supabase.co`)
   - **anon public** key (a long string, under "Project API keys")

   Keep this tab open, or copy both values into a notes app — you'll paste
   them into `config.js` in Part 5.

6. **Double-check Realtime is on** for the tables (the migrations already
   enable this, but it's worth confirming): left sidebar → **Database** →
   **Replication**. Under `supabase_realtime`, make sure `orders`, `stock`,
   `menu`, and `settings` are all toggled on.

That's the database fully set up.

---

## Part 3 — Set up Firebase (push notifications)

This part sends the "🍢 New Order!" alert to your phone/computer when a
customer orders. It's the most fiddly part of setup — take it slowly.

### 3a. Create the Firebase project

1. Go to [console.firebase.google.com](https://console.firebase.google.com) →
   **Add project**. Name it (e.g. `sate-hujung-minggu`), you can disable
   Google Analytics (not needed), click **Create project**.
2. Once created, click the **`</>`** (web) icon to add a web app. Give it a
   nickname (e.g. "PWA"), click **Register app**. You'll see a code block
   with a `firebaseConfig` object — you need the values inside it:
   `apiKey`, `authDomain`, `projectId`, `storageBucket`, `messagingSenderId`,
   `appId`. Copy these somewhere — they go into `config.js` in Part 5.
   Click **Continue to console**.

### 3b. Get the VAPID public key

1. In the Firebase console, click the ⚙️ gear icon → **Project settings**.
2. Click the **Cloud Messaging** tab.
3. Scroll to **Web configuration** → **Web Push certificates**.
4. If there's no key pair yet, click **Generate key pair**. Copy the long
   string shown (starts with `B...`) — this is your `VAPID_PUBLIC_KEY`,
   needed in both `config.js` (Part 5) and as an Edge Function secret
   (Part 4).

### 3c. Get the service-account key (for sending pushes from the server)

1. Still in **Project settings**, click the **Service accounts** tab.
2. Click **Generate new private key** → confirm. This downloads a `.json`
   file to your computer — **treat this file as a password, never share it
   or upload it anywhere public.**
3. Open that file in a plain text editor (Notepad on Windows, TextEdit on
   Mac — set TextEdit to plain text mode). You need two fields from it:
   - `"client_email"` — a string like
     `firebase-adminsdk-xxxxx@yourproject.iam.gserviceaccount.com`. Copy the
     value exactly (without the quotes).
   - `"private_key"` — a long value that looks like:
     ```
     -----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg...(many lines)...\n-----END PRIVATE KEY-----\n
     ```
     You need to turn this into **one continuous string with the
     `-----BEGIN...-----`/`-----END...-----` lines and all the `\n` removed**.
     The easiest way: paste the whole `private_key` value into a text editor,
     delete the `-----BEGIN PRIVATE KEY-----` bit from the start, delete the
     `-----END PRIVATE KEY-----` bit from the end, then find-and-replace every
     `\n` with nothing (empty), so it becomes one long unbroken line of
     letters/numbers/symbols. That result is your `FCM_KEY_B64`.
   - Also note your Firebase **Project ID** (shown in Project settings →
     General tab, or it's the `projectId` value from step 3a) — this is
     `FCM_PROJECT_ID`.

Keep all of these (`FCM_PROJECT_ID`, `FCM_CLIENT_EMAIL`, `FCM_KEY_B64`,
`VAPID_PUBLIC_KEY`) somewhere safe — they go into Supabase as **secrets** in
Part 4, not into any file that goes on GitHub.

> **About the "legacy" fallback push path:** the Edge Function code has a
> secondary, best-effort delivery method (`VAPID_PRIVATE_KEY`) for very old
> push subscriptions. Firebase doesn't hand you this private key through its
> console — it's only obtainable by generating your own independent VAPID
> key pair with an external tool. **You can safely skip this one.** The
> primary delivery path (the service-account method above) doesn't need it
> and is what actually sends your notifications; leaving
> `VAPID_PRIVATE_KEY` unset just means that one rarely-used fallback path
> won't fire, which in practice you're unlikely to ever notice.

---

## Part 4 — Deploy the push-notification Edge Function

This is the small piece of server-side code that actually sends the push
notification when a new order comes in.

1. In your Supabase project, left sidebar → **Edge Functions**.
2. Click **Deploy a new function** → choose the option to write/paste code
   directly in the browser (not the CLI option — you don't need a terminal
   for this).
3. Name the function exactly `push-orders`.
4. Open `supabase/functions/push-orders/index.ts` from your GitHub repo,
   copy its full contents, and paste them into the editor. Click **Deploy**.
5. Now set the secrets this function needs. Still in **Edge Functions**, find
   **Manage secrets** (or **Settings** → **Edge Functions** → **Secrets**
   depending on your Supabase version). Add each of these as a secret name
   and value:

   | Secret name | Value |
   |---|---|
   | `FCM_PROJECT_ID` | your Firebase Project ID |
   | `FCM_CLIENT_EMAIL` | the `client_email` from Part 3c |
   | `FCM_KEY_B64` | the cleaned-up `private_key` from Part 3c |
   | `VAPID_PUBLIC_KEY` | the key from Part 3b |
   | `SITE_URL` | your site's live URL, no trailing slash — e.g. `https://sate-hujung-minggu.netlify.app` (you'll know this after Part 6; you can come back and set this secret then) |

   (Skip `VAPID_PRIVATE_KEY` per the note in Part 3c. `SUPABASE_URL` and
   `SUPABASE_ANON_KEY` are provided to every Edge Function automatically —
   you don't need to set those yourself.)

6. Last step: tell Supabase to actually *call* this function whenever a new
   order is inserted. Left sidebar → **Database** → **Webhooks** → **Create a
   new hook**. Set:
   - Table: `orders`
   - Events: `Insert`
   - Type: **Supabase Edge Functions**
   - Function: `push-orders`

   Save it. New orders will now trigger a push notification.

---

## Part 5 — Fill in `config.js` (the one file to edit)

This is the only file that needs your actual values typed into it. Everything
else in the app reads from it automatically.

1. On GitHub, open `config.js`, click the pencil (✏️) icon to edit.
2. Fill in the values you collected in Parts 2 and 3:

```js
globalThis.APP_CONFIG = {
    SUPABASE_URL:      'https://xxxxxxxx.supabase.co',   // from Part 2 step 5
    SUPABASE_ANON_KEY: 'your anon public key here',      // from Part 2 step 5

    FIREBASE: {
        apiKey:            '...',   // from Part 3a
        authDomain:        '...',
        projectId:         '...',
        storageBucket:     '...',
        messagingSenderId: '...',
        appId:             '...'
    },

    VAPID_PUBLIC_KEY: '...',   // from Part 3b — same value you set as a secret in Part 4

    APP_NAME: 'Your Shop Name',
    VERSION:  '1.0.0'
};
```

3. Also open `manifest.json` and update the `"gcm_sender_id"` field to match
   your Firebase `messagingSenderId` from above — this is the **one** value
   that lives outside `config.js`, because `manifest.json` is a plain data
   file that can't read JavaScript. (Everything else in `manifest.json` —
   name, icons, colors — you can also customize here if you'd like, but it's
   not required.)
4. Commit your changes (GitHub will prompt you for a commit message when you
   click **Commit changes**).

---

## Part 6 — Deploy to Netlify

1. Go to [netlify.com](https://netlify.com) → sign up (you can sign up
   directly with your GitHub account, which makes the next step easier).
2. Click **Add new site** → **Import an existing project** → **Deploy with
   GitHub**. Authorize Netlify to access your GitHub account if asked.
3. Pick your repository (e.g. `sate-hujung-minggu`).
4. Build settings: leave **Build command** blank and **Publish directory**
   as `/` (this is a static site — nothing needs to be "built"). Click
   **Deploy**.
5. Netlify gives you a live URL like `https://random-name-123.netlify.app`.
   You can rename this: **Site configuration** → **Change site name**, so
   it's something memorable like `sate-hujung-minggu.netlify.app`.
6. **Go back to Part 4 step 5** and set (or update) the `SITE_URL` secret in
   Supabase to this exact URL (no trailing slash).

From now on, any time you edit a file on GitHub and commit it, Netlify
automatically redeploys the live site within about a minute.

---

## Part 7 — Test everything

Open your Netlify URL and check each of these:

- [ ] The **Home** page (admin app) loads and asks for your password (the
      one set inside the app — this isn't a Supabase/Firebase login, it's
      the app's own PIN screen).
- [ ] `yoursite.netlify.app/order.html` loads the customer ordering page.
- [ ] Add an item to a menu item's stock (Settings → Menu), then check it
      shows correctly on the customer order page.
- [ ] Place a **test order** from the customer page.
- [ ] The order appears in the admin app's **Orders** tab.
- [ ] You receive a **push notification** for the new order (you'll need to
      tap "Allow notifications" once in the admin app first — usually
      prompted automatically, or check Settings → Others for a notification
      toggle).
- [ ] Toggle **Dark Mode** (Settings → Others) and refresh — it should stay on.
- [ ] On `order.html`, switch your phone/OS to dark mode — the page should
      follow automatically.
- [ ] "Add to Home Screen" (on mobile) — the app should install as a PWA
      with its icon.
- [ ] Try blocking a test order's phone number (Orders → 🚫 button →
      Settings → 🚫 Blocked to confirm it's listed), then unblock it.

If push notifications don't arrive but everything else works, the issue is
almost always in Part 3c/4 (a copy-paste mistake in the private key, or a
missing webhook) — re-check those before anything else.

---

## Troubleshooting

**"Failed to fetch" errors everywhere / nothing loads data.**
Double-check `config.js` — a typo in `SUPABASE_URL` or `SUPABASE_ANON_KEY` is
the most common cause. Open your browser's developer console (F12) and look
for the exact error.

**Orders don't sync between admin and customer pages in real time.**
Recheck Part 2 step 6 — the `orders`, `stock`, `menu`, and `settings` tables
must all have Realtime enabled.

**Push notifications never arrive.**
- Check the Supabase Edge Function logs: **Edge Functions** → `push-orders`
  → **Logs**. Errors here usually point at exactly what's wrong (bad key
  format, missing secret, etc).
- Re-verify the `FCM_KEY_B64` secret has no `-----BEGIN/END-----` text and no
  line breaks left in it.
- Confirm the database webhook (Part 4 step 6) exists and is enabled.

**The site loads but looks broken / unstyled.**
Usually a file failed to upload to GitHub, or Netlify's publish directory
setting doesn't match where your files actually are. Check Netlify's
**Deploys** tab → click the latest deploy → **Deploy log** for errors.

**I changed something on GitHub but the live site didn't update.**
Check Netlify's **Deploys** tab — it should show a new deploy triggered
automatically within a minute of your commit. If it's stuck or failed, click
**Trigger deploy** → **Deploy site** to force a fresh one.
