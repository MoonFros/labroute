#!/usr/bin/env node
'use strict';

const { loadProjectEnv } = require('../lib/env');
const { loadConfig } = require('../lib/config');
const { createPostgresPool, databaseUrl } = require('../lib/postgres');
const { migrate } = require('../lib/postgres-migrations');
const { importDatabase, legacyBlob } = require('./import-db');

async function run({ importOnly = false } = {}) {
  loadProjectEnv();
  const config = loadConfig({ storage: 'postgres' });
  const url = databaseUrl(process.env.DATABASE_URL_UNPOOLED || config.databaseUrl, { direct: true });
  const pool = createPostgresPool(url.toString(), { max: 1 });
  try {
    await pool.query('SELECT 1');
    console.log('PostgreSQL direct connection: OK');
    if (!importOnly) {
      const applied = await migrate(pool);
      console.log(`Migrations: ${applied.length ? applied.join(', ') : 'already up to date'}`);
    }
    if (!process.argv.includes('--schema-only')) {
      const counts = await importDatabase({ pool, config,
        blobStorage: process.argv.includes('--from-blob') ? legacyBlob() : null,
        refreshContent: !process.argv.includes('--keep-content') });
      console.log('Imported (source files retained):', JSON.stringify(counts));
    }
    console.log('Database setup: OK');
  } finally { await pool.end(); }
}

function reportFailure(error) {
  // Error.detail can contain SQL parameter values; do not print connection URLs,
  // error objects, admin hashes, query parameters, or provider credentials.
  const safe = String(error.message || 'Unknown database error')
    .replace(/postgres(?:ql)?:\/\/\S+/gi, '[redacted database URL]')
    .replace(/npg_[A-Za-z0-9]+/g, '[redacted]');
  console.error(`Database setup FAILED: ${error.code || error.name || 'Error'}: ${safe}`);
  console.error('No source data was deleted. Confirm Neon connectivity and retry npm run db:migrate.');
  process.exitCode = 1;
}

module.exports = { run, reportFailure };
if (require.main === module) run().catch(reportFailure);
