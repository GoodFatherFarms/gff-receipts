# GFF Receipts (installable app)

Good Father Farms' phone app for receipts, sales, and truck miles. It is a Progressive Web App (PWA):
a small website that installs to the home screen with the GFF icon, opens full screen, and works with no signal.
All data lives in the farm's Google Sheet ledger through the Apps Script backend (`Code.gs`, v7). This folder
holds only the phone app. No data and no passwords are stored here.

## Files

| File | What it is |
|---|---|
| `index.html` | The app's single page (sign-in, Home, Expense, Income, Miles, Approve, Settings) |
| `app.js` | Everything the app does: sign-in, forms, photos + OCR, offline queue, approvals, team |
| `styles.css` | GFF look: green `#283E36`, cream `#F4EFE2`, gold `#C8A24A`, Merriweather Sans + Assistant |
| `config.js` | The backend URL (the Apps Script `/exec` link) and the app version |
| `sw.js` | Service worker: caches the app so it opens offline, and offers updates |
| `manifest.webmanifest` | Install info: name, icons, full-screen (`standalone`), colors, shortcuts |
| `icons/` | 32, 180 (apple-touch-icon), 192, 512, and maskable 192/512 icons |
| `fonts/` | Assistant and Merriweather Sans (SIL Open Font License), self-hosted for offline use |
| `.nojekyll` | Tells GitHub Pages to serve the files as they are |

## How it talks to the backend

Every call is `fetch(API_URL, {method: 'POST', headers: {'Content-Type': 'text/plain'}, redirect: 'follow'})`
with a JSON body `{action, token, ...}`. `text/plain` keeps it a "simple" request, so the browser skips the
CORS preflight that Apps Script can't answer. Apps Script replies `302` to `script.googleusercontent.com`,
and both hops send `Access-Control-Allow-Origin: *` (checked 2026-11-04 with an `Origin` header).

## Deploy (first time)

**Jonah does these himself (needs his sign-ins):**
1. Make a free GitHub account at <https://github.com/signup> (or sign in). GitHub asks for an email code and
   two-factor setup. The username becomes part of the app link: `https://USERNAME.github.io/gff-receipts/`.
2. Approve the backend update below (it changes the live ledger: new Status columns, a hidden Users tab,
   and the Monthly Summary formulas).

**Then (the CFO bot can do these in the box browser once Jonah is signed in and says go):**

3. Create the repo: GitHub → **New repository** → name `gff-receipts` → **Public** (free GitHub Pages needs
   public; the code has no secrets) → Create.
4. Push this folder: either `git init && git add . && git commit -m "GFF Receipts v7" && git branch -M main &&
   git remote add origin https://github.com/USERNAME/gff-receipts.git && git push -u origin main`, or on the
   repo page use **Add file → Upload files** and drag in everything in this folder (keep the `icons/` and `fonts/` folders).
5. Turn on Pages: repo → **Settings → Pages** → Source **Deploy from a branch** → Branch `main`, folder `/ (root)`
   → Save. After about a minute the page shows `Your site is live at https://USERNAME.github.io/gff-receipts/`.
6. Update the backend (Apps Script editor, project "GFF Receipts", signed in as thepasturepreacher@gmail.com):
   1. Replace `Code.gs` with the v7 `Code.gs`. `Index.html` and `appsscript.json` stay the same. Save.
   2. Run **`setupV7`** (pick it in the function menu, press Run). Open **Execution log**: it shows the owner
      PIN for "Jonah" and the `TEST_TOKEN`. Write the PIN down. (To choose your own PIN instead, first add a
      script property `OWNER_PIN` in Project Settings; setupV7 uses it and then deletes it.)
   3. Run **`repairMileageRateTableV7`** (puts back the IRS-rate table in Mileage K:M).
   4. Run **`updateSummaryFormulasV7`** (Monthly Summary counts approved rows only; it saves the old formulas
      to a hidden "Summary backup pre-v7" tab first. Undo: `restoreSummaryFormulasPreV7`).
   5. **Project Settings → Script properties → Add**: `PWA_URL` = `https://USERNAME.github.io/gff-receipts/`
      (used by the weekly email link and the "moved" page).
   6. **Deploy → Manage deployments** → the existing web app deployment → ✏️ **Edit** → Version **New version**
      → description `v7: PWA API, PIN sign-in, approvals` → **Deploy**. Execute as **Me**, access **Anyone**
      stay the same. Do NOT make a new deployment: the `/exec` URL in `config.js` must stay the same.
7. Test (script is `receipt_app_v7/test_v7.sh` on the CFO bot box, needs curl + jq): `GFF_URL=<exec URL> GFF_TEST_TOKEN=<from step 6.2> bash test_v7.sh` (makes and deletes TEST rows only).
   Afterward you can delete the `TEST_TOKEN` script property to switch test mode off.

## Install on a phone

Open `https://USERNAME.github.io/gff-receipts/` on the phone, then:

- **iPhone:** open the link in **Safari** → tap **Share** (square with the up arrow) → **Add to Home Screen** →
  **Add**. Open it from the new GFF icon and sign in there (the installed app keeps its own sign-in, separate
  from Safari). The first photo asks for camera access: tap Allow.
- **Android:** open the link in **Chrome** → tap **Install** when it offers, or **⋮ → Install app** (some phones say
  **Add to Home screen → Install**). Open it from the GFF icon and sign in.

Then delete the old "GFF Receipts" home-screen bookmark (the `script.google.com` one).

## Adding an employee

Owner: app → ⚙ Settings → Team → **＋ Add a person** (name, 4–6 digit PIN, Employee). Tell them the PIN in person.
They install the app the same way and sign in with that name and PIN. Their entries show up under ✅ Approve and
don't count anywhere until you approve them. **Turn off** someone and they are signed out on every phone at once.

## Updating the app later

Change the files, bump `APP_VERSION` in `config.js` **and** `CACHE` in `sw.js` (same number), push. Phones show
"A new version is ready → Update now" the next time the app is opened. Pickup-day prices live in the backend
(`PRESETS` in `Code.gs`), so a price change there needs only a new Apps Script version, not a new app release.

## Local testing

`python3 -m http.server 8080` in this folder, then open `http://localhost:8080/?api=<backend URL>`. The `?api=`
switch works only on `localhost`, so a link can never point the real app at another server.
