# Labroute #
A website for UNIBEN ELA

Umoh Etini - Team Lead and Report Author (Tee Hee 😁)

Aika Osakioya - Team Member and JS Dev

Agbonze Leonard - Team Member and front-end dev

Oboh Christopher - Team Member and Report Author

## Community Lab Moments

The gallery on the home page accepts visitor photos, but nothing is published
immediately. A visitor previews any photo on `upload.html` and sends it for
review. The photo is stored in the private pending area
(`data/pending/` on a Node host, Vercel Blob on Vercel)
and listed under **Pending uploads** on `dashboard.html`, where an admin can:

- **Download photo** / **Download JSON** — save the original image (correct
  extension) and the exact `content/gallery.json` record. Every card shows the
  path to commit: `assets/gallery/moments/<file>` for the photo, plus the record
  in `content/gallery.json`.
- **Approve** — first *checks the repository for that photo*, then completes.
  - Committed (by `npm run publish`, the GitHub web editor, or a `git push`):
    the queue entry is cleared and the photo is **image 1**; every existing
    photo shifts one place down. Where its record sits in
    `content/gallery.json` does not matter — the newest community photo is
    always served first and the archive follows in file order (ordering lives
    in `lib/gallery-store.js`, mirrored in `js/app.js` for the static fallback).
  - Not committed, on a deployment with no durable storage: the request is
    answered with **409 `not_committed`** naming the two files to commit. The
    dashboard shows that instruction in amber and keeps the download links, so
    nothing is silently lost. Press **Approve again** once the commit has
    deployed.
  - Not committed, on a Node host (`npm start`) or with Blob storage connected:
    the photo is published automatically — moved to `assets/gallery/moments/`
    and written to `content/gallery.json` on a Node host, or copied to Vercel
    Blob and recorded in the Blob copy of the gallery list on Vercel, because a
    deployed Function's own files are read-only.
- **Decline** — the file and its entry are deleted.

Approving a photo whose queue entry has already gone (the deploy that followed
your commit wipes `/tmp`) still succeeds while the photo is in the gallery, so a
reloaded dashboard never loses a photo it has just published.

### Home page gallery

The gallery shows **nine photos at a time** — a 3x3 block on desktop, nine cards
in the horizontal carousel on phones — with `Prev`/`Next` and numbered page
buttons below it (`Showing 1-9 of 23 photos`). Paging is client side in
`js/app.js` (`GALLERY_PAGE_SIZE`), so the API and `content/gallery.json` still
carry the whole gallery; only the current page is in the DOM. A gallery of nine
or fewer photos shows no pager at all.

Each visitor is held to **one upload every 30 minutes**. The cooldown is scoped
to that visitor (a signed HttpOnly cookie plus a browser-local device id), so one
person uploading does not block anybody else. A hashed network guard also limits
bursts from a single network without storing raw IP addresses. No account is
required, and the upload page never asks for an email address.

When a photo arrives for review, the admin team receives an email notification.
The admin dashboard also shows the pending queue with the photo, caption, and
submitting visitor's name.

### Run the site

```bash
npm start
```

Then open <http://localhost:3000>. The local Node service uses only the
standard library, so it runs without an install step. (`@vercel/blob` is the
one dependency; it is loaded only when Blob storage is in use, and Vercel
installs it automatically during deployment.)

For local development with automatic restarts:

```bash
npm run dev
```

### Upload storage

On a Node host everything is on disk:

| Path | Purpose |
| --- | --- |
| `content/gallery.json` | Ordered public gallery. The first item is displayed first. |
| `assets/gallery/moments/` | Approved images, named with unguessable ids. |
| `data/pending/` | Photos awaiting review plus `pending.json`. Private, never served statically, and gitignored. |
| `data/runtime/` | Generated cookie secret, hashed cooldown state, and the notification log. This directory is gitignored. |

On Vercel the same data lives in a connected Blob store under the `labroute/`
prefix (`labroute/state/*.json`, `labroute/pending/`, `labroute/gallery/`);
`content/gallery.json` in the repo is only the seed shown until the first
approval. See **Deploying to Vercel** below.

**Approved photos are never written back into this Git repository.** A Vercel
Function cannot write to the deployment it is running from, and this app has no
GitHub token, so `assets/gallery/moments/` in the repo stays exactly as
committed (the eight `gal-1` … `gal-8` originals). Every new photo is stored in
external storage (Vercel Blob) and referenced from the Blob copy of
`gallery.json`. If Blob is not connected, the only place left to write is the
Function's `/tmp`, which is wiped on restart — see **Why did an approved photo
disappear?** below.

### Sponsored card (single, quiet ad)

`content/ads.json` drives one small promo card that appears **once per browser
session**:

- **Where** — a card tucked into the bottom-right corner on desktop; on phones a
  compact bar pinned above the bottom edge, inset for `env(safe-area-inset-bottom)`.
  No backdrop, no scroll lock, and the rest of the page stays usable.
- **When** — after `delaySeconds` (default 12, clamped to 3–120s) so nobody is
  interrupted before they start reading. It is skipped entirely in a hidden tab,
  when the visitor sends Do-Not-Track, or with `?noad=1` on any URL.
- **How often** — `oncePerSession` marks `sessionStorage`, so following a link to
  another page will not re-open it. `dismissDays` (default `0`) adds an optional
  cross-session cooldown after a dismissal.
- **Dismissing** — the `×` button, Escape, or following the ad. Two interactive
  elements only: the creative (one link covering image + text) and the close
  button.
- **Layout** — on a desktop the card sits in the bottom-right corner; on a phone
  (`max-width: 640px`) it is the same card made full width above the bottom
  safe area: 16:9 creative on top, then *Sponsored*, the title, the description
  (two lines) and the call-to-action button. Only the width changes, so the
  advertisement always says what it is offering. Its close button sits over the
  image, and the card never exceeds the viewport height.
- **Safety** — image and link values are validated (`assets/…` or https, never
  `javascript:`/`data:`/`//host`), and every text field is HTML-escaped.

To advertise something:

```json
{
  "enabled": true,
  "delaySeconds": 12,
  "label": "Sponsored",
  "ads": [
    {
      "id": "my-product",
      "enabled": true,
      "image": "assets/ads/my-product.png",
      "alt": "Describe the product for screen readers",
      "title": "My product",
      "body": "One short line of context.",
      "cta": "Shop now",
      "href": "https://example.com/my-product",
      "weight": 1
    }
  ]
}
```

Put the creative in `assets/ads/`, set `enabled: true`, and commit. Several ads
can share the slot — one is chosen per session, proportionally to `weight`.
Set the top-level `enabled` to `false` to pause all advertising without touching
the pages. `assets/ads/sample-lab-kit.jpg` and its record are a placeholder to
replace.

### Publishing without Blob (manual commit)

The upload → review → **download → commit** path needs no storage service and
nothing can expire, because the photo ends up as a normal file in the repo.

1. Visitor uploads; the photo waits under **Pending uploads** on `dashboard.html`.
2. An admin clicks **Download photo** (original bytes, correct extension) and
   **Download JSON** (the exact gallery record).
3. Locally, in a clone of the repository:

   ```bash
   npm run publish -- ~/Downloads/moment-abc123.png \
       --metadata ~/Downloads/moment-abc123.json
   ```

   That copies the photo to `assets/gallery/moments/` and prepends the record to
   `content/gallery.json` (idempotent; `--dry-run` shows the change without
   writing, `--force` overwrites).
4. Commit and push:

   ```bash
   git add assets/gallery/moments/ content/gallery.json
   git commit -m "gallery: publish moment-abc123"
   git push
   ```

5. Back on the dashboard, click **Approve**. It verifies the commit and clears
   the item from the queue; the photo is already image 1 because the repository
   is the gallery.

You can paste the JSON record anywhere in `content/gallery.json` (top, bottom,
or straight through GitHub's web editor) — the newest community photo is served
first either way, and every existing photo simply shifts one place down.

Why this is durable: Vercel checks the filesystem **before** applying
`vercel.json` rewrites ("precedence is given to the filesystem prior to rewrites
being applied"), so a committed
`assets/gallery/moments/<id>.<ext>` is served directly from the deployment. The
`/assets/gallery/moments/(.*)` rewrite only catches file names that exist solely
in Blob. `content/gallery.json` is the committed gallery, so the entry appears
on the home page as soon as the deployment lands.

One rule to know: once storage holds a gallery manifest (i.e. after any
automatic approval), records added to `content/gallery.json` are merged in front
of it, and archived captions edited in the repo win over the stored copy — but
an item deleted from the repo is not removed while the manifest still lists it.
Deleting archived photos from a live deployment therefore needs the Blob
manifest cleared as well.

Caveat: the *pending queue* still needs somewhere to live between upload and
download. With a working Blob store it is durable; without one the photos sit in
the Function's `/tmp`, so download them before that instance is recycled (a few
minutes of inactivity, or the next deploy). Anything already downloaded is safe.

Run `npm test` to execute the integration suite (pending uploads, approval and
decline, gallery ordering, downloads and manual publishing, per-visitor
cooldowns, validation, admin authentication, the review queue, and the
Vercel/Blob deployment path).

### Email notifications

Copy `.env.example` to `.env` and configure one provider:

- **Resend** (recommended — sends to every admin in `data/admins.json`):
  `RESEND_API_KEY` and `RESEND_FROM`.
- **Formspree** (works with no extra account because the site already uses a
  Formspree form): the form owner receives the alert. This is the default
  fallback.
- **Webhook**: set `MOMENTS_WEBHOOK_URL` to forward the alert to Google Apps
  Script, Slack, n8n, or your own service.
- Set `MOMENTS_EMAIL_PROVIDER=none` to disable email entirely. Uploads still
  work and the notification is recorded in `data/runtime/notifications.jsonl`.

Admin addresses are read from `data/admins.json`; override them with
`MOMENTS_ADMIN_EMAILS=one@example.com,two@example.com` if needed.

### Deploying to Vercel (labroute.vercel.app)

The API runs on Vercel as a Function: `api/index.js` (plus the rewrites in
`vercel.json`) hands every `/api/*` request to the same handler as the local
server (a plain static deployment never starts `server.js`, which is why
`/api/moments/status` used to 404 and the upload page reported the sharing
service as unreachable).

Two one-time dashboard steps make uploads **durable** on Vercel. Without
them the API still works, but pending photos sit in a Function's temporary
`/tmp` storage and can disappear when the instance is recycled:

1. **Connect a Blob store** — Vercel dashboard → your project → **Storage →
   Create → Blob**, choose **Private**, and connect it to the project
   (Production at minimum). This sets `BLOB_READ_WRITE_TOKEN` / `BLOB_STORE_ID`
   automatically. (A *public* store also works; the service detects the
   store type, or you can pin it with `BLOB_ACCESS=public`.)
2. **Set a cookie secret** — Project **Settings → Environment Variables**:
   `MOMENTS_SECRET` to a long random string (32+ characters). Without it each
   Function instance signs cookies with its own temporary secret, so admin
   sessions and visitor cooldowns would appear to reset randomly.

Then redeploy. Verify with <https://labroute.vercel.app/api/health>: it should
report `"storage": "vercel-blob"`, `"durable": true`, and
`"secretConfigured": true`.

### Why did an approved photo disappear?

Symptom: a photo appears at the front of the gallery right after approval, then
is gone after a refresh a while later (or after the next deploy).

Cause: `GET /api/health` reported `"storage": "ephemeral"`. Approved photos and
the gallery manifest were written to the Function instance's `/tmp`, which
belongs to that one instance. Once Vercel recycles it — or a new deployment
replaces it — the photo and the manifest entry are gone. The eight original
`gal-*` photos were never affected because they are real files committed to
`assets/gallery/`, served by the deployment itself.

Diagnose it in one request:

```bash
curl -s https://labroute.vercel.app/api/health
```

| Field | Meaning |
| --- | --- |
| `storage` | `vercel-blob` = durable. `ephemeral` = `/tmp`, approvals will vanish. `local` = a Node host's disk, durable. |
| `durable` | `false` when approvals are temporary. The admin dashboard shows a red **Approvals are temporary** banner whenever this is false, and the approve endpoint says so in its response. |
| `blob.credentials` | `false` when the Function has no credential it can authenticate with. |
| `blob.hasStoreId` / `blob.hasReadWriteToken` / `blob.hasOidcToken` | `hasStoreId: true` with **both** `hasReadWriteToken: false` and `hasOidcToken: false` means a store is attached to the project but the running Function has no usable token — the gallery then stays on `/tmp` even though "Blob is connected". |
| `blob.sdkAvailable` | `false` if `@vercel/blob` did not install into the Function. |

`GET /api/gallery` also reports `source`: `storage` means the list came from
Blob/disk, `seed` means storage had no manifest and the committed
`content/gallery.json` was served instead. A gallery that shows only the
original photos is usually `source: "seed"`.

### Store attached, but still ephemeral

This is the state where the dashboard's *Storage* tab clearly shows a Blob
store, yet `/api/health` reports:

```json
"storage": "ephemeral",
"blob": { "credentials": false, "hasReadWriteToken": false, "hasStoreId": true, "hasOidcToken": false }
```

`BLOB_STORE_ID` is injected into the deployment, but the SDK has nothing to
authenticate with, so it cannot read or write a single byte. Two ways to fix it:

1. **Give the deployment the store token (most reliable).** Vercel dashboard →
   **Storage** → your Blob store → **.env** / **Connect** → copy
   `BLOB_READ_WRITE_TOKEN`, then **Project → Settings → Environment Variables**
   → add `BLOB_READ_WRITE_TOKEN` with that value for **Production** →
   **Redeploy**. `/api/health` must then report `blob.hasReadWriteToken: true`.
2. **Enable OIDC for the project** so Vercel injects `VERCEL_OIDC_TOKEN` at
   runtime (`blob.hasOidcToken: true`), then redeploy.

Either way the target is `"storage": "vercel-blob"` and `"durable": true`.

Fix: connect the Blob store to **Production** (not just Preview/Development), so
`blob.credentials` becomes `true`, then redeploy and confirm
`"storage": "vercel-blob"` / `"durable": true`. Photos approved after that are
written to Blob and survive restarts, redeploys, and new Function instances.

**Connecting a store is not retroactive.** Vercel captures environment
variables into each deployment, so an already-running Production deployment
keeps its old (credential-free) environment until a **new deployment** is
created — push a commit, or use *Deployments → ⋯ → Redeploy*. Loading the site
immediately after connecting a store therefore still shows
`"storage": "ephemeral"`. If a redeploy is not possible, `MOMENTS_STORAGE=blob`
forces the Blob path even when `BLOB_READ_WRITE_TOKEN` is not detected (the
store must still be connected, or every request fails).

Note that anything approved while the site was on `/tmp` cannot be recovered —
those bytes were deleted with the instance. Ask visitors to re-upload.

Approvals are also verified: `GalleryStore.add` reads the manifest back after
writing it, and if the write cannot be confirmed the approval fails with an
error (and the photo is moved back to pending) instead of reporting a success
that later disappears.

Notes:

- Photos are capped at **3 MB on Vercel** (Vercel Functions reject request
  bodies over 4.5 MB, and uploads travel base64-encoded). The upload page
  shows the limit the API reports. The browser resizes every photo to 2048 px
  on the long edge and re-encodes it as JPEG, so a 10 MP phone photo arrives as
  a few hundred KB and comfortably fits.
- **Any photo format is accepted.** `upload.html` has `accept="image/*"` and the
  browser re-encodes what it can decode (JPEG, PNG, WebP, GIF, BMP, AVIF, and
  HEIC on iOS Safari) into JPEG, which also applies EXIF rotation and strips
  GPS metadata. The server then sniffs the bytes rather than trusting the
  browser's label:
  - a JPEG reported as `application/octet-stream`, with no label at all, or as
    `image/jpg` (Android) is accepted — this used to fail with "the photo could
    not be read";
  - a mislabelled file (PNG bytes sent as `image/jpeg`) is stored as what it
    actually is;
  - GIF and BMP are stored as-is when they arrive directly;
  - HEIC that the browser cannot decode (iPhone photos opened in desktop
    Chrome) is refused with instructions for switching the iPhone camera to
    *Most Compatible*; TIFF/AVIF exported to the API directly get a message
    asking for JPEG/PNG/WebP/GIF/BMP.
- Alternatively, deploy `server.js` to any Node host with a persistent disk
  (Render, Railway, Fly.io, a VPS) — no Blob store is needed there.
- The home page still falls back to `content/gallery.json` if the upload
  service is offline.
