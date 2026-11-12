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

### Initialize Neon from Vercel (no local terminal)

If the live site's logs say `PostgreSQL operation failed: 42P01`, the app can
reach PostgreSQL but a required table is missing. Adding environment variables
alone does not create the schema. You can initialize it **from a Vercel
production build**, using the existing connection:

1. Deploy code that includes `tools/vercel-build.js`. `vercel.json` selects
   **`npm run build:vercel`**, not the ordinary database-free build. Keep any
   custom Build Command setting on this wrapper and confirm it in Build Logs.
2. In **Vercel → Project → Settings → Environment Variables**, set **Production**:

   | Variable | Value |
   | --- | --- |
   | `DATABASE_URL` | Your current pooled Neon connection string |
   | `MOMENTS_STORAGE` | `postgres` |
   | `MOMENTS_MIGRATE_ON_BUILD` | `1` |

   `DATABASE_URL_UNPOOLED` is optional: when omitted the direct Neon hostname is
   derived from `DATABASE_URL`. If supplied, it must point to the **same endpoint
   and database**, though it may use a different migration role. Both roles must
   have the permissions they need. Keep the previous `MOMENTS_SECRET` if set.
3. Trigger a new **Production build** of that code. Redeploying an older
   deployment that still uses `npm run build` will not run the new setup.
   Promoting an already-built Preview deployment may not rebuild it, so do not
   rely on promotion alone to run production initialization.
4. Look for **`Database setup: OK`**, **`PostgreSQL runtime connection: ready`**,
   and then **`Build passed`** in Build Logs. The wrapper applies versioned SQL
   on the direct connection, imports the repository admin/gallery/content seeds
   once, and checks the actual pooled runtime connection before building.
5. Verify `/api/health` is HTTP 200 with `storage=postgres`, `durable=true` and
   `database.connected=true`, then test upload → approve/reject on the live site.
6. Remove `MOMENTS_MIGRATE_ON_BUILD` or set it to `0` for later deployments.
   Future schema changes then need a manual migration or an explicitly opted-in
   production build with the flag re-enabled.

The flag is off by default. Even if accidentally present in Preview, Development
or a custom environment, the setup does not run there. Local `npm run build`
always stays database-free. Vercel's system variables must identify an actual
production build (`VERCEL=1`, `VERCEL_ENV=production`, and the optional
`VERCEL_TARGET_ENV` must not name a different environment).

A failed migration, seed, or runtime-readiness check **fails the build** instead
of deploying an uninitialized app. After a successful first import, later
opted-in builds still check/apply versioned migrations but **skip all reseeding**:
DB-edited content, changed admin credentials, uploads, moderation decisions and
the cookie key are preserved. Concurrent initializers are transaction-locked.
Build initialization never reads runtime `/tmp`/pending/log state or imports
legacy Blob storage. It does not introduce an unauthenticated setup API.

This initializes the current repository's 4 admin records, 8 archived gallery
records and 146 report/product/ad documents; it does not recover images already
lost from an old `/tmp` instance. Surviving historical uploads still need the
explicit legacy import below. See
[`docs/vercel-neon-initialization.md`](docs/vercel-neon-initialization.md) for
safety details, expected logs and verification.

### Apply the schema and migrate existing data manually

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
The ordinary `npm run build` does **not** connect to or mutate a production
database. Vercel uses `npm run build:vercel`, whose explicitly opted-in
production-only setup is described above; otherwise migrate separately.
`dist/` excludes credentials, admin hashes, source code,
content JSON and old community image files. This prevents Vercel's static-file
precedence from bypassing database content or image approval checks.

### Deploy to Vercel

1. Choose either the opted-in Vercel initialization above (no local terminal)
   or a manual Neon migration/import, and verify its row counts.
2. Set **Production** environment variables `DATABASE_URL` and
   `MOMENTS_STORAGE=postgres` in the Vercel project. Keep an existing
   `MOMENTS_SECRET` consistent across deployments, or omit it to use the DB key.
   For build initialization, also enable `MOMENTS_MIGRATE_ON_BUILD=1` for the
   first Production deployment. Never put database URLs in browser code.
3. Deploy this branch's code. `vercel.json` runs `build:vercel`, builds `dist/`,
   and routes `/api/*`, `/content/*`, and `/assets/gallery/moments/*` through
   `api/index.js` as needed.
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
npm run test:vercel-setup
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

`test:vercel-setup` reproduces the live `42P01` failure against a fresh local
PostgreSQL database, executes the actual `npm run build:vercel` command with
Vercel production variables, verifies schema/seeds and healthy API responses,
and tests login/upload/approval/rejection plus a non-destructive rebuild. It also
proves preview and opted-out builds do not initialize, failures stop the build,
wrong runtime credentials are detected, and concurrent setup/rollback is safe.

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
