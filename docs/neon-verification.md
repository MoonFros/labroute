# Neon migration implementation and verification

Date: 2026-11-12. Branch: `arena/4e7ab402-labroute`.

## Status

**Code/build/local PostgreSQL verification passed. Live Neon deployment and
production data migration are blocked by connectivity and are NOT complete.**

No production rows were imported or changed. The supplied connection details
are in a gitignored `.env.local`, not source control; this file was created from
the supplied URL because the Neon CLI could not pull environment variables.
Rotate the password that was shared in chat and update both local and hosting
environments before production use.

## Implemented

- Neon CLI installed globally with `npm i -g neon@latest`.
- Ran the requested `neon init` targeting organization
  `org-plain-grass-35697520`, project `jolly-voice-71537315`, branch `production`,
  service `postgres`. The CLI wrote an **offline, unverified** `.neon` link,
  `neon.ts`, and installed the Neon agent skills.
- Node/Vercel `pg` connection pool with Vercel pool lifecycle integration,
  verified TLS, channel binding, pooled runtime URL, and direct migration URL.
- Versioned PostgreSQL schema and transactional, non-destructive local/Blob
  importer for gallery metadata/bytes, pending photos, admin hashes, content
  documents, signing key, cooldown state, and local notification logs.
- Shared PostgreSQL admin login throttling and cookie signing key.
- Atomic upload storage and cross-instance cooldown locks. No temporary-storage
  fallback after a database error, and no upload acceptance on default /tmp-only
  serverless deployments.
- Approve/reject dashboard, no manual Git publication prerequisite. Approval
  updates an existing row; new approvals sort first by DB approval timestamp.
  Rejection clears bytes. Concurrency and retries cannot overwrite other photos.
- All public JSON content reads come from PostgreSQL in Neon mode. Admin hashes
  are not browser-accessible. Build output excludes seeds and legacy community
  files so static hosting cannot override the database moderation decision.

## Passing command output

Runtime used: Node v22.22.3. Tests use a real, isolated PostgreSQL server, not SQL
mocks. Generated test credentials and test databases are cleaned up afterward.

### `npm run build`

```text
> tsc -p tsconfig.neon.json && node tools/build.js

Build passed: 41 JavaScript files checked; Neon config type-checked.
Built 10 pages and 10 browser scripts into dist/.
Private data excluded; /content/* and approved uploads are served by the API.
```

### `npm test`

```text
# tests 87
# suites 0
# pass 87
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

### `npm run test:postgres`

```text
# tests 21
# suites 0
# pass 21
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

This includes pending privacy, source-file bypass prevention, cross-instance
session/cooldown persistence, approve/reject races, concurrent uploads including
same-millisecond network accounting, atomic rollback on an injected write
failure, local/Blob import idempotence, missing image recovery errors, Vercel
rewrites, incomplete-import protection, and failure without a stale seed fallback.
Expected error logs during injected-failure tests are not test failures.

### `npm run test:e2e`

```text
E2E target: isolated real PostgreSQL (not live Neon; no production data is touched).
PASS migrations + import: 8 gallery records, 146 content documents, 1 test admin
PASS app started on 0.0.0.0
PASS GET /api/health -> 200; storage=postgres, durable=true, database.connected=true
PASS report index, report detail, products and ads read from PostgreSQL
PASS upload -> 201; pending image private (401 admin API / 404 public path)
PASS database-backed admin login -> 200
PASS app process AND PostgreSQL restarted: pending bytes, admin session and cooldown survived
PASS Approve -> 200; image is gallery[0] immediately; public image bytes match upload
PASS approved photo survives another app process restart
PASS Reject -> 200; pending and public image -> 404; gallery unchanged
E2E PASS
```

The disposable admin is confined to the test database. Production import uses the
four existing admin records, not a newly created test account.

### `npm audit`

```text
found 0 vulnerabilities
```

The original installation reported four high-severity transitive advisories.
The vulnerable `@vercel/cli-config` Zod dependency is overridden to the patched
compatible 4.x release; the final full audit is clean.

`git diff --check` passed. A static-output audit confirmed `dist/` contains no
`.env*`, `.neon`, admin data, server sources, content JSON, or legacy community
image directory.

## Live Neon commands that failed

### `neon deploy` (retried after final configuration)

```text
ERROR: Could not reach the Neon API. Please check your internet connection and try again.
```

### `npm run db:migrate` (supplied direct Neon database URL)

```text
Database setup FAILED: Error: Connection terminated unexpectedly
No source data was deleted. Confirm Neon connectivity and retry npm run db:migrate.
```

A separate pooled-connection probe failed too. This workspace's outbound host
allowlist does not include the Neon API or database hosts; these failures do not
establish that the supplied credentials are invalid.

### `npm start` (actual supplied Neon configuration)

The app started and listened on `0.0.0.0:3000` in `postgres` mode. Live HTTP checks:

```text
GET / -> 200
GET /api/health -> 503
GET /api/gallery -> 503
{"ok":false,"error":"database_unavailable","message":"The database is temporarily unavailable. Nothing was saved to temporary storage. Please try again."}
```

The process was stopped after the checks rather than leaving a broken preview
running. This confirms failure is explicit; it is **not** a successful live Neon
end-to-end test.

## Remaining production steps

From a terminal/runner that can reach Neon:

1. Run `neon login` and complete browser sign-in, then retry `neon deploy`.
2. Ensure the current pooled/direct URLs are in the authoritative local env file;
   don't let an older `.env.local` override a newly pulled `.env`.
3. Pause old uploads/reviews and run `npm run db:migrate` against Neon.
4. If old live data is in Blob, set its existing credentials locally and run
   `npm run db:import -- --from-blob`. If on another Node host, import its surviving
   runtime/upload directories from there. No legacy Blob credentials were supplied
   in this session, so remote historical uploads could not be inspected/imported.
5. Configure the Vercel Production environment with the rotated pooled
   `DATABASE_URL` and `MOMENTS_STORAGE=postgres`, then deploy this code. Retain the
   previous `MOMENTS_SECRET` if already used, or use the database-backed key.
6. Confirm HTTP 200 from `/api/health` with `storage=postgres`, `durable=true`,
   `database.connected=true`; confirm `/api/gallery` reports `source=postgres`.
   Repeat upload → approve → first gallery image and upload → reject on the live
   app and verify across a redeploy.

Already-erased /tmp images cannot be recovered from this repository or by
changing databases; they require an old backup or visitor resubmission. The
README contains the full cutover and recovery instructions.
