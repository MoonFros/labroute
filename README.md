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

- **Approve** — the file moves to `assets/gallery/moments/` and becomes **image 1**
  of `content/gallery.json`. Every existing image shifts one place to the right.
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

The API runs on Vercel as a Function: `api/[...path].js` hands every `/api/*`
request to the same handler as the local server (a plain static deployment
never starts `server.js`, which is why `/api/moments/status` used to 404 and
the upload page reported the sharing service as unreachable).

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
report `"storage": "vercel-blob"` and `"secretConfigured": true`.
`"storage": "ephemeral"` there means the temporary fallback is in use.

Notes:

- Photos are capped at **3 MB on Vercel** (Vercel Functions reject request
  bodies over 4.5 MB, and uploads travel base64-encoded). The upload page
  shows the limit the API reports.
- Alternatively, deploy `server.js` to any Node host with a persistent disk
  (Render, Railway, Fly.io, a VPS) — no Blob store is needed there.
- The home page still falls back to `content/gallery.json` if the upload
  service is offline.
