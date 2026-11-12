#!/usr/bin/env node
'use strict';

const { loadProjectEnv } = require('../lib/env');
const { loadConfig } = require('../lib/config');
const { createPostgresPool, databaseUrl } = require('../lib/postgres');
const { migrate } = require('../lib/postgres-migrations');
const { importDatabase, legacyBlob } = require('./import-db');

function migrationUrl(runtimeUrl, unpooledUrl, { requireSameDatabase = false } = {}) {
  const expected = databaseUrl(runtimeUrl, { direct: true });
  const direct = databaseUrl(unpooledUrl || runtimeUrl, { direct: true });
  if (requireSameDatabase) {
    for (const url of [expected, direct]) {
      if (!url.hostname || !url.pathname || url.pathname === '/') {
        throw new Error('Production database setup requires an explicit hostname and database name in both database URLs.');
      }
      // pg honors host/port query parameters over the URL authority; Neon can
      // also route via options=endpoint. Do not let those bypass target checks.
      if (['host', 'port', 'options'].some((key) => url.searchParams.has(key))) {
        throw new Error('Production database setup does not support host/port/options routing overrides in database URL query parameters. Use the explicit Neon endpoint and database URL.');
      }
    }
  }
  if (requireSameDatabase && (direct.hostname !== expected.hostname ||
      (direct.port || '5432') !== (expected.port || '5432') ||
      decodeURI(direct.pathname) !== decodeURI(expected.pathname))) {
    throw new Error('DATABASE_URL_UNPOOLED must target the same endpoint and database as DATABASE_URL; refusing to initialize a different database.');
  }
  return direct;
}

async function setupDatabase({ pool, config, importOnly = false, initializeOnly = false,
  schemaOnly = false, fromBlob = false, refreshContent = true, log = console.log }) {
  if (initializeOnly && (importOnly || schemaOnly || fromBlob)) {
    throw new Error('First-time production setup cannot be combined with schema-only or legacy import modes.');
  }
  await pool.query('SELECT 1');
  log('PostgreSQL direct connection: OK');
  const applied = importOnly ? [] : await migrate(pool);
  if (!importOnly) log(`Migrations: ${applied.length ? applied.join(', ') : 'already up to date'}`);

  let imported = null;
  if (!schemaOnly) {
    imported = await importDatabase({ pool, config, initializeOnly,
      blobStorage: fromBlob ? legacyBlob() : null,
      refreshContent: initializeOnly ? false : refreshContent });
    if (imported) log('Imported (source files retained):', JSON.stringify(imported));
    else log('Initial data: already initialized; existing content, admins, photos and signing key left untouched.');
  }
  return { applied, imported };
}

async function verifyRuntimeDatabase(connectionString) {
  // The app uses the pooled URL, which can have different credentials from the
  // direct migration role. Verify that connection before allowing a deployment.
  const pool = createPostgresPool(connectionString, { max: 1 });
  try {
    const { rows } = await pool.query("SELECT value FROM labroute_settings WHERE key = 'data_import_complete'");
    if (!rows.length) throw new Error('Initial data import did not finish; production build cannot continue.');
    // Read no application data, but verify the expected columns and runtime read
    // access for each table. This is not a comprehensive DML privilege check.
    await pool.query(`
      SELECT id, status, caption, contributor, image_path, image_data, ext, mime,
        width, height, bytes, tall, uploaded, uploaded_at, approved_at,
        publication_order, archive_order FROM labroute_moments LIMIT 0;
      SELECT email, password_hash FROM labroute_admins LIMIT 0;
      SELECT path, body, updated_at FROM labroute_documents LIMIT 0;
      SELECT key, occurred_at, event_id FROM labroute_rate_events LIMIT 0;
      SELECT key, count, reset_at FROM labroute_login_attempts LIMIT 0;
      SELECT id, source_key, created_at, body FROM labroute_notifications LIMIT 0;
    `);
  } finally { await pool.end(); }
}

async function run({ importOnly = false, initializeOnly = false,
  readEnvFile = true, cliArgs = process.argv.slice(2) } = {}) {
  if (readEnvFile) loadProjectEnv();
  // A build imports repository seeds, never a serverless runtime's /tmp paths.
  const config = loadConfig({ storage: 'postgres', ...(initializeOnly ? { serverless: false } : {}) });
  const url = migrationUrl(config.databaseUrl, process.env.DATABASE_URL_UNPOOLED,
    { requireSameDatabase: initializeOnly });
  const pool = createPostgresPool(url.toString(), { max: 1 });
  try {
    // Build initialization never inherits CLI flags that could omit the seed or
    // unexpectedly contact an old Blob store. Manual CLI behavior is preserved.
    const args = initializeOnly ? [] : cliArgs;
    const result = await setupDatabase({ pool, config, importOnly, initializeOnly,
      schemaOnly: args.includes('--schema-only'), fromBlob: args.includes('--from-blob'),
      refreshContent: !args.includes('--keep-content') });
    if (initializeOnly) {
      await verifyRuntimeDatabase(config.databaseUrl);
      console.log('PostgreSQL runtime connection: ready (schema and initial import verified)');
    }
    console.log(args.includes('--schema-only') ? 'Database schema: OK (initial data import still required)' : 'Database setup: OK');
    return result;
  } finally { await pool.end(); }
}

function safeErrorMessage(error) {
  // Error.detail can contain SQL parameters: only use the message, redact URLs
  // and Neon passwords, and never print error objects or provider credentials.
  return String(error.message || 'Unknown error')
    .replace(/postgres(?:ql)?:\/\/\S+/gi, '[redacted database URL]')
    .replace(/npg_[A-Za-z0-9]+/g, '[redacted]');
}

function reportFailure(error) {
  console.error(`Database setup FAILED: ${error.code || error.name || 'Error'}: ${safeErrorMessage(error)}`);
  console.error('No source data was deleted. Confirm Neon connectivity and retry npm run db:migrate.');
  process.exitCode = 1;
}

module.exports = { run, setupDatabase, verifyRuntimeDatabase, migrationUrl, safeErrorMessage, reportFailure };
if (require.main === module) run().catch(reportFailure);
