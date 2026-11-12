# Initialize Neon from a Vercel production build

Follow-up to PR #26, on branch `arena/1506ecb0-labroute` (2026-11-12).

## What this fixes

The live API reported `PostgreSQL operation failed: 42P01`: it could reach
PostgreSQL, but a required application table was missing. Setting `DATABASE_URL`
and getting a successful static build did not run the schema migration/import.

The new `npm run build:vercel` wrapper can initialize the database **on Vercel**,
where the production connection is available. No local server, Neon CLI sign-in,
public setup endpoint, or new database project is required for this step.

**Status:** implemented and tested with real isolated PostgreSQL, including the
actual build command and HTTP app flow. This guide is not evidence that the new
code has been deployed or that the live Neon database has been initialized.
That must be verified after deploying this change to Production.

## One-time dashboard steps (no terminal)

1. Merge/deploy the code containing `tools/vercel-build.js`. Its `vercel.json`
   sets `buildCommand` to **`npm run build:vercel`**. Keep any custom Build Command
   in **Settings → Build and Deployment** set to the wrapper as well, and verify
   the command actually runs in Build Logs. Redeploying an older version that
   still runs only `npm run build` will not initialize the database.
2. In **Vercel → Project → Settings → Environment Variables**, use the
   **Production** environment for:

   | Name | Value |
   | --- | --- |
   | `DATABASE_URL` | The current pooled Neon connection string already used by the app |
   | `MOMENTS_STORAGE` | `postgres` |
   | `MOMENTS_MIGRATE_ON_BUILD` | `1` |

   Do not put real credentials in chat, source code, browser JavaScript, or public
   logs. Rotate any password that was previously shared. Retain an existing
   `MOMENTS_SECRET` if it is already configured.

   `DATABASE_URL_UNPOOLED` is optional. With a Neon URL, the script removes
   `-pooler` from the hostname to obtain a direct migration connection. If you
   supply an unpooled URL explicitly, it must target the **same endpoint and
   database** as the runtime URL. It may use a different migration role. A stale
   URL pointing elsewhere is rejected before any SQL is run. Use a standard Neon
   URL with an explicit hostname/database, not `host`, `port` or `options` query
   overrides that could redirect the driver to another endpoint.
3. Trigger a new **Production build** of the updated code. Promoting an existing
   Preview deployment may reuse its already-built output; that is not a substitute
   for running the production build with the setup flag. The wrapper must receive
   Vercel's system variables: `VERCEL=1`, `VERCEL_ENV=production`, and, when
   present, `VERCEL_TARGET_ENV=production`. Preview/custom environments are
   intentionally not eligible, even if someone enabled the flag there.
4. Open **Build Logs**. A first successful setup should include:

   ```text
   [labroute:build] Production PostgreSQL setup enabled; migrating and initializing before the static build.
   PostgreSQL direct connection: OK
   Migrations: 001_neon_storage.sql
   Imported (source files retained): {"admins":4,"documents":146,"gallery":8,"pending":0,"rateEvents":0,"notifications":0}
   PostgreSQL runtime connection: ready (schema and initial import verified)
   Database setup: OK
   [labroute:build] PostgreSQL setup verified; building the site.
   ```

   `Build passed` must follow. Counts can be smaller if the database already
   contains some of these records. If initialization previously completed, the
   import line is replaced by:

   ```text
   Initial data: already initialized; existing content, admins, photos and signing key left untouched.
   ```

5. Visit `https://labroute.vercel.app/api/health`. Require **HTTP 200** with:

   ```json
   {
     "storage": "postgres",
     "durable": true,
     "database": { "connected": true },
     "secretConfigured": true
   }
   ```

   Also require `source: "postgres"` from `/api/gallery`, then test a visitor
   upload, an admin approval as the first gallery photo, and a separate rejection.
6. After successful live verification, remove `MOMENTS_MIGRATE_ON_BUILD` or set it
   to `0`. Future schema changes will then require running the manual migration
   command or re-enabling the flag for a new production build. Keeping it enabled
   instead continues applying versioned migrations without reseeding existing data.
   No terminal is needed for the setup above.

## Safety and lifecycle

- The flag is **off by default**. Only `1`/`true` enables it; `0`/`false` disables
  it. An invalid value on a production build fails with a configuration error.
- Local `npm run build` remains database-free. Preview, development, and custom
  builds skip initialization, even with an inherited enabled flag and URL.
- The build uses hosting environment variables, not `.env.local` or `.env`.
  CLI flags cannot turn the build setup into a schema-only or legacy Blob import.
- It reuses the existing versioned, checksum-verified migrations over the direct
  connection. No ad hoc DDL, DROP/reset, runtime migration endpoint, or additional
  Neon service is added. Production migrations must remain backward compatible
  with the deployment that is still serving traffic.
- First-time seeding reads only the repository's admins, gallery, and content.
  It ignores runtime pending folders, writable gallery manifests, cooldown/log
  files, temporary cookie keys, and Blob state. Empty/missing admin or content
  seeds cannot produce a false successful initialization.
- The seed transaction writes `data_import_complete` only after the import
  succeeds. If seeding fails, all seed writes roll back. The schema migration
  may already be committed; a retry safely reuses it and retries the seed.
- Advisory transaction locks serialize migrations and initial imports. The
  completion marker is rechecked inside the import lock, so concurrent builds
  cannot both reseed. After completion, the seed files are not read again.
- Existing admin hashes, photo decisions, images, signing keys, and content are
  not overwritten. Even a retry after a missing marker does not replace existing
  document edits. Manual `npm run db:import` intentionally retains its original
  content-refresh behavior for explicit publishing/recovery.
- Before building the site, the wrapper checks the **pooled runtime credentials**,
  completion marker, and the expected runtime table columns/read access. A working
  migration role cannot hide a broken runtime login or a missing runtime table.
  This is not a comprehensive runtime write/sequence-privilege check; the live
  upload/moderation verification above is still required.
- Migration, import, readiness, or static-build failures cause a nonzero build
  exit, so Vercel does not publish the failed deployment. This does not roll back
  a schema migration that had already committed; it does not imply the database
  was untouched before a later build failure.
- Database URLs/passwords are redacted from failure messages. Seed hashes,
  migrations and setup source are excluded from the public `dist/` allowlist.

### Existing uploads and recovery

This solves the missing schema and initializes the current archive catalog. It
cannot recover photo bytes already erased with a former `/tmp` instance, and it
does not automatically import surviving uploads from another host or Blob store.
Use the explicit `db:import -- --from-blob` recovery path with that store's
credentials, or import surviving local state from its old host. Do not retire
old storage until surviving data has been copied and verified. Never delete
existing PostgreSQL tables merely to rerun initialization.

## Troubleshooting build logs

- **`setup skipped: not a Vercel production build`**: a Preview/custom deployment
  is expected to skip. For Production, check the system-variable exposure and
  that you deployed to the Production environment, not only a PR preview.
- **`MOMENTS_MIGRATE_ON_BUILD is not enabled`**: set `1` for Production and create
  a new deployment. A flag scoped only to Preview will not enable production.
- **`same endpoint and database`**: fix or remove a stale `DATABASE_URL_UNPOOLED`;
  the migration must not initialize a different database.
- **`28P01`**: authentication failed. Correct the relevant connection credentials;
  never paste the full URL into a public issue or chat.
- **`42501`**: the configured role lacks a required schema/table privilege. Use
  the proper migration role and grant the runtime role the app's needed access.
- **`42P01` after applied migration history, or `42P07` during migration**: a
  manually created/partially altered schema may not match its migration history.
  Stop and inspect/repair it deliberately; do not drop tables that may hold data.
- A failed seed is not an invitation to bypass the completion marker. Fix the
  source/connection error and retry with the flag still enabled.

## Verification on this branch

Commands:

```bash
npm ci --include=dev
npm run build
npm run build:vercel
npm test
npm run test:vercel-setup
npm run test:e2e
npm audit
```

The ordinary build passed with **44 JavaScript files checked**, Neon config
checked, and **10 pages / 10 browser scripts** built. Running the Vercel wrapper
locally explicitly skipped PostgreSQL setup and built successfully.

The full suite passed **123 tests, 0 failures**, including the **36** targeted
Vercel setup tests. Those cover guard policy, the real build command against a fresh PostgreSQL database,
initial import and HTTP health recovery, admin login/upload/approval/rejection,
non-destructive rebuilds/cold starts, failure exits, pooled-credential checks,
matching database targets, empty seeds, transactional rollback and concurrent
initializers. The separate restart-persistence E2E suite passed. `npm audit`
reported **0 vulnerabilities**.

All of these checks use isolated local PostgreSQL databases, not live Neon.
Expected injected-failure logs (including the initial `42P01`) are deliberate test
cases, not evidence of production deployment success or a real service outage.
