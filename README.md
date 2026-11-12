# LabRoute

A UNIBEN ELA report archive with a moderated community photo gallery.

- Umoh Etini — Team Lead and Report Author
- Aika Osakioya — Team Member and JS Dev
- Agbonze Leonard — Team Member and Front-end Dev
- Oboh Christopher — Team Member and Report Author

## Community Lab Moments: upload → approve or reject

1. A visitor previews a photo on `upload.html`, adds a caption, confirms consent,
   and submits it. No account or email address is required.
2. **The image bytes and pending record are committed together to PostgreSQL.**
   They stay private and remain available for review across app restarts,
   serverless cold starts, redeploys, and database restarts. There is no automatic
   expiry on pending photos.
3. An authenticated admin opens **Pending uploads** on `dashboard.html`:
   - **Approve** publishes the existing image immediately as **image 1** in the
     gallery. Older submissions approved later also go first.
   - **Reject** removes the image bytes, excludes it from the gallery, and retains
     a small review tombstone so reimporting stale data cannot revive it.

**No photo downloads, JSON edits, GitHub commits, or redeploys are needed to
approve a photo.** Download endpoints remain available as optional admin-only
backups, not as publication prerequisites. The old `publish` endpoint is disabled
when PostgreSQL is selected.

The gallery displays nine photos per page. A successful approval is visible to
all subsequent gallery requests immediately. Already-open home pages refresh on
focus, every 30 seconds while visible, and immediately after an approval in
another tab of the same browser. The API is `no-store`; immutable approved image
URLs can be cached. Database errors are reported as **503**, not as an empty
pending queue or a silently restored archive-only gallery.

## Neon setup

Use Node **22 LTS or newer** and npm. From the project root:

```bash
npm ci
npm i -g neon@latest
# If global installation is unavailable, replace neon with npx neon@latest.

neon init -y --org-id org-plain-grass-35697520 \
  --project-id jolly-voice-71537315 --branch production --services postgres
neon deploy
```

If prompted, complete browser sign-in. If it fails or times out, run
`neon login`, finish signing in, then retry `neon deploy`. This uses the existing
project; do not create a replacement project or switch the current Git branch.

`neon.ts` declares the PostgreSQL-only setup (Postgres is implicit in Neon
projects), keeps existing admin authentication, and never expires `production`.
Neon agent skills are installed under `.agents/skills/`; the PostgreSQL skill's
Vercel guidance is followed: **`pg` with a small pooled connection pool and
`attachDatabasePool` from `@vercel/functions`**. The app is a Node/Vercel Function,
not an edge runtime. TLS verifies the server certificate and channel binding is
enabled for Neon.

`neon deploy` pulls `DATABASE_URL` and `DATABASE_URL_UNPOOLED` into a local env
file. Alternatively, copy `.env.example` to `.env.local` and fill in the two
URLs. Use literal `&`, not HTML `&amp;` (the driver also normalizes pasted HTML
entities). Keep only one authoritative local copy of each URL.

- `DATABASE_URL`: pooled hostname (`-pooler`) for the running app.
- `DATABASE_URL_UNPOOLED`: direct hostname for migrations/imports. If omitted,
  migration tooling derives the direct Neon hostname from `DATABASE_URL`.
- `MOMENTS_STORAGE=postgres`: explicitly select PostgreSQL, even if an old Blob
  token or `MOMENTS_STORAGE=blob` setting is still present on the host.
- `MOMENTS_SECRET`: optional existing signing key. Otherwise one persistent
  signing key is stored in PostgreSQL and shared across all instances.

Hosting/process variables win over files. `.env.local` takes precedence over
`.env`. Neither file, nor the local `.neon` link, is checked in. Never put a
connection string in browser JavaScript or an admin screenshot. Rotate any
password previously shared in chat and update local and hosting env variables.

### Apply the schema and migrate existing data

**Pause legacy uploads/reviews during the final import and cutover.** This avoids
new writes being left behind in the old store. Back up the legacy data first.

```bash
# Versioned schema + import current local content, admins, and surviving uploads.
npm run db:migrate

# If the live site used Vercel Blob, also set its existing token in the local
# environment and copy its approved gallery, pending images and cooldowns:
npm run db:import -- --from-blob
```

If local runtime files exist only on the old Node host, run the import there
against Neon before retiring that host. The imported state includes:

| PostgreSQL table | Data |
| --- | --- |
| `labroute_moments` | Gallery metadata, pending/approved image bytes (`bytea`), moderation status, publication order |
| `labroute_admins` | Existing admin emails and password hashes; no new passwords are created |
| `labroute_documents` | All 146 current report/index, products and ads JSON documents |
| `labroute_settings` | Shared signing key and completed-import marker |
| `labroute_rate_events` | Per-visitor/device/network cooldowns; only HMAC identifiers |
| `labroute_login_attempts` | Shared admin sign-in throttling |
| `labroute_notifications` | Notification delivery records, including any local legacy JSONL log |
| `labroute_schema_migrations` | Applied migration names and checksums |

The original archive photographs, styles, PDFs and other static assets remain
normal static files; their catalog metadata is in PostgreSQL. New community
images are stored in the database, **not `/tmp` or a local deployment folder**.
At the existing 3 MiB Vercel upload limit this keeps each photo and its review
state atomic and requires only the requested PostgreSQL service. If the gallery
grows substantially, image bytes can later move to durable object storage without
returning to file-based queue manifests.

The importer is transactional and repeatable. It never deletes legacy sources,
never overwrites an existing photo's moderation decision or an existing admin's
credentials, and fails instead of silently skipping missing image bytes. A
successful import writes a completion marker; the app refuses database-backed
requests until import has finished. Schema migrations are checksum-checked and
run on a direct connection under a transaction-scoped lock.

`db:import` deliberately refreshes repository-authored report/product/ad content.
Use `--keep-content` to preserve existing database document edits. When adding a
report with the existing report authoring tool, update the versioned source JSON
and run `npm run db:import` to publish those content changes to PostgreSQL.
`content/gallery.json` is a one-time archive seed, not the live approval database.
The old `npm run publish` tool is for legacy recovery only; it is no longer the
photo approval workflow.

**Photos already erased from a former Vercel `/tmp` instance cannot be recovered
by this migration.** Import surviving Blob/local uploads or backups; ask visitors
to resubmit anything whose bytes are already gone. Blob cannot recover a
notification log that only existed on a destroyed `/tmp` instance either.

### Build and run

```bash
npm run build
npm start
# Development with automatic Node restarts:
npm run dev
```

Open `http://localhost:3000`. The server binds to `0.0.0.0`, uses same-origin API
URLs, and works behind the Arena/Vercel preview proxy. No browser-facing code
contains a database URL or calls a localhost backend.

The build type-checks `neon.ts`, syntax-checks application/test/tool JavaScript,
minifies browser scripts, and assembles an explicit static allowlist into `dist/`.
It does **not** connect to or mutate a production database. Migrate separately
before deploying. `dist/` excludes credentials, admin hashes, source code,
content JSON and old community image files. This prevents Vercel's static-file
precedence from bypassing database content or image approval checks.

### Deploy to Vercel

1. Complete the Neon migration/import above and verify its row counts.
2. Set **Production** environment variables `DATABASE_URL` and
   `MOMENTS_STORAGE=postgres` in the Vercel project. Keep an existing
   `MOMENTS_SECRET` consistent across deployments, or omit it to use the DB key.
   `DATABASE_URL_UNPOOLED` is needed where migrations run, not in browser code.
3. Deploy this branch's code. `vercel.json` builds `dist/` and routes `/api/*`,
   `/content/*`, and `/assets/gallery/moments/*` through `api/index.js` as needed.
   The same handler powers `npm start` and Vercel.
4. Confirm `/api/health` returns HTTP 200 with:

   ```json
   {
     "storage": "postgres",
     "durable": true,
     "database": { "connected": true },
     "secretConfigured": true
   }
   ```

5. Confirm `/api/gallery` returns `source: "postgres"`. Upload a test photo,
   open the dashboard, approve it, and confirm it is first and survives a refresh.
   Repeat with Reject and confirm it stays out of the public gallery.

An unreachable database causes **503** responses without a disk/Blob fallback.
A serverless deployment without any durable store rejects new uploads instead of
accepting photos that will disappear. Local disk and legacy Blob implementations
remain available for recovery/tests, but are not the Neon production path.

## Verification

```bash
npm run build
npm test
npm run test:postgres
npm run test:e2e
npm audit
```

`npm test` includes the original validation/gallery/email/Vercel tests and the
real-PostgreSQL suite. The local database binary is an npm **dev dependency**, not
a mock SQL engine and not a production service. Test clusters, randomly generated
test admin credentials, and uploaded test bytes are cleaned up afterward. Do not
run tests as root; PostgreSQL requires an unprivileged OS user.

`test:e2e` starts the actual `server.js` app in separate child processes, imports
the real archive catalog, authenticates a disposable test admin, uploads/previews
a photo, restarts **both the app and PostgreSQL**, reuses the admin session and
cooldown, approves the photo, compares public image bytes, restarts again, and
rejects another photo. It runs against an isolated local PostgreSQL database and
never modifies live Neon. **A local E2E pass is not a claim that Neon deployment
or production migration succeeded**; the live commands and health check must
also pass from an environment that can reach Neon.

## Notifications and upload limits

Set one email provider in your private env file:

- **Resend**: `RESEND_API_KEY`, `RESEND_FROM`.
- **Webhook**: `MOMENTS_WEBHOOK_URL`.
- **Formspree**: existing form fallback unless `MOMENTS_FORM_ENDPOINT=off`.
- **None**: `MOMENTS_EMAIL_PROVIDER=none` (useful for local testing).

Recipients come from PostgreSQL admin accounts, or `MOMENTS_ADMIN_EMAILS` if set.
Notification logs go to PostgreSQL; an email provider failure does not erase the
already-committed upload. Provider delivery needs that provider's network access.

Visitors get one upload per 30 minutes, plus a separate network burst limit.
Transaction-scoped locks and per-upload rate events enforce these limits across
multiple app instances without blocking unrelated visitors or losing concurrent
uploads. No raw visitor identifiers or IP addresses are stored in these tables.

Decoded image limits are 8 MiB on Node and 3 MiB on Vercel (base64 must fit the
platform's 4.5 MB request limit). The browser resizes to 2048 px and normally
re-encodes to JPEG. The server checks actual image bytes, dimensions, caption,
consent, and honeypot instead of trusting the filename/MIME label. Unsupported
HEIC/TIFF/AVIF API uploads get conversion instructions. Pending previews require
the signed, HttpOnly admin cookie; approved bytes are publicly readable.

## Sponsored card

The single quiet promo card is configured by `content/ads.json`, imported into
`labroute_documents`. Edit the versioned source and run `npm run db:import` to
publish it. It appears once per browser session after a clamped delay, respects
Do-Not-Track and `?noad=1`, and can be dismissed with Escape or its close button.
Images/links are validated and all text is escaped. Set `enabled: false` in the
configuration to pause advertising. Products and report source JSON use the same
import path; their existing browser URLs are served from PostgreSQL.
