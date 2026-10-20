# Labroute #
A website for UNIBEN ELA

Umoh Etini - Team Lead and Report Author (Tee Hee 😁)

Aika Osakioya - Team Member and JS Dev

Agbonze Leonard - Team Member and front-end dev

Oboh Christopher - Team Member and Report Author

## Community Lab Moments

The gallery on the home page accepts visitor photos, but nothing is published
immediately. A visitor previews a JPEG, PNG, or WebP image on `upload.html` and
sends it for review. The photo is stored in the private pending area
(`data/pending/` on a Node host, Vercel Blob on Vercel)
and listed under **Pending uploads** on `dashboard.html`, where an admin can:

- **Approve** — the photo becomes **image 1** of the gallery; every existing
  image shifts one place to the right. On a Node host it is moved to
  `assets/gallery/moments/` and recorded in `content/gallery.json` on disk. On
  Vercel it is copied to the connected Vercel Blob store and recorded in the
  Blob copy of the gallery list, because the deployment's own files (and this
  repository) are read-only to the running Function.
- **Decline** — the file and its entry are deleted.

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

Run `npm test` to execute the integration suite (pending uploads, approval and
decline, gallery ordering, per-visitor cooldowns, validation, admin
authentication, the review queue, and the Vercel/Blob deployment path).

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
| `blob.credentials` | `false` when no Blob store is connected to this environment at all. |
| `blob.hasStoreId` / `blob.hasOidcToken` | A store connected to the project but only for Preview shows `hasStoreId` without `hasOidcToken` (and no `hasReadWriteToken`) in Production. |
| `blob.sdkAvailable` | `false` if `@vercel/blob` did not install into the Function. |

`GET /api/gallery` also reports `source`: `storage` means the list came from
Blob/disk, `seed` means storage had no manifest and the committed
`content/gallery.json` was served instead. A gallery that shows only the
original photos is usually `source: "seed"`.

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
  shows the limit the API reports.
- Alternatively, deploy `server.js` to any Node host with a persistent disk
  (Render, Railway, Fly.io, a VPS) — no Blob store is needed there.
- The home page still falls back to `content/gallery.json` if the upload
  service is offline.
