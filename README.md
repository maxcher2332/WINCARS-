# Window Sticker Widget

Pixel-style Monroney window sticker that any car-related website can embed.
Designed to be powered by the **Vehicle Databases Window Sticker API**.

## What's in this folder

| File | Purpose |
|---|---|
| `window-sticker.html` | The visual widget. Open it in any browser to see the demo (currently filled with the sample 2023 Mazda CX-5 data). |
| `server.js` | A tiny Node.js backend that hides your API key on the server and exposes a clean `/api/window-sticker?vin=...` endpoint your front-end can safely call. |
| `.env` *(you create this)* | Holds your real `VDB_API_KEY`. Never commit it to git. |

## Step 1 — See the demo

Just double-click `window-sticker.html`. It opens in your browser with the example car already populated. This is the version you can show to your team / investors right now.

## Step 2 — Wire it up to live data (safely)

> **Never** put the API key directly into `window-sticker.html` — anyone visiting your site could read it.

1. Install Node.js: <https://nodejs.org>
2. In this folder, run:
   ```
   npm init -y
   npm install express node-fetch dotenv cors
   ```
   In the generated `package.json`, add `"type": "module"`.
3. Create a file named `.env` next to `server.js` with **one line**:
   ```
   VDB_API_KEY=your_real_api_key_here
   ```
4. Start the server:
   ```
   node server.js
   ```
5. Open <http://localhost:3000/window-sticker.html?vin=JM3KFBCM5P0102946> — it will fetch real data from Vehicle Databases through your server.

## Step 3 — Embed on your real website

Two options:

**A. Iframe** *(simplest, no code changes on your site)*

```html
<iframe
  src="https://YOUR-DOMAIN.com/window-sticker.html?vin=JM3KFBCM5P0102946"
  width="1200" height="900"
  style="border:0;">
</iframe>
```

**B. Inline** *(prettier, takes 5 minutes for a developer)*

Copy the `<style>` and `<div id="sticker-root">` from `window-sticker.html` into your page, then call:

```html
<script>
  fetch("/api/window-sticker?vin=" + theVin)
    .then(r => r.json())
    .then(data => window.renderWindowSticker(data));
</script>
```

## Security checklist

- [x] API key only lives in `.env` (never in HTML/JS)
- [x] `.env` is in `.gitignore` so it's never pushed to GitHub
- [x] Production host (Render / Railway / Vercel / etc.) has the key in its "Environment Variables" UI
- [x] If the key was ever shared anywhere public — **regenerate it immediately** in the Vehicle Databases dashboard
