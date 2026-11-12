#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { databaseUrl } = require('../lib/postgres');
const { migrationUrl, run: migrateDatabase, safeErrorMessage } = require('./migrate-db');

/** Only an explicitly opted-in, actual Vercel production build may initialize. */
function initializationPlan(env) {
  if (env.VERCEL !== '1' || env.VERCEL_ENV !== 'production' ||
      (env.VERCEL_TARGET_ENV && env.VERCEL_TARGET_ENV !== 'production')) {
    return { initialize: false, reason: 'not a Vercel production build (preview, development and custom environments never migrate)' };
  }

  const flag = String(env.MOMENTS_MIGRATE_ON_BUILD || '').trim().toLowerCase();
  if (!flag || flag === '0' || flag === 'false') {
    return { initialize: false, reason: 'MOMENTS_MIGRATE_ON_BUILD is not enabled' };
  }
  if (flag !== '1' && flag !== 'true') {
    throw new Error('MOMENTS_MIGRATE_ON_BUILD must be 1/true to enable setup, or 0/false to disable it.');
  }
  if (!String(env.DATABASE_URL || '').trim()) {
    throw new Error('Production database setup requires DATABASE_URL in the Vercel Production environment.');
  }
  const storage = String(env.MOMENTS_STORAGE || 'auto').trim().toLowerCase();
  if (!['postgres', 'auto'].includes(storage)) {
    throw new Error('Production database setup requires MOMENTS_STORAGE=postgres (or auto with DATABASE_URL).');
  }

  // Validate before doing any I/O, and never print credential-bearing URLs.
  databaseUrl(env.DATABASE_URL);
  migrationUrl(env.DATABASE_URL, env.DATABASE_URL_UNPOOLED, { requireSameDatabase: true });
  return { initialize: true };
}

function buildSite(env) {
  const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], {
    cwd: path.join(__dirname, '..'), env, stdio: 'inherit'
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const error = new Error(`Static build failed${result.signal ? ` (${result.signal})` : ''}.`);
    error.exitCode = result.status || 1;
    throw error;
  }
}

async function runVercelBuild({
  env = process.env,
  initialize = (options) => migrateDatabase(options),
  build = () => buildSite(env),
  log = console.log
} = {}) {
  const plan = initializationPlan(env);
  if (plan.initialize) {
    log('[labroute:build] Production PostgreSQL setup enabled; migrating and initializing before the static build.');
    // No CLI flags, local env files, /tmp state, or legacy Blob import are used.
    await initialize({ initializeOnly: true, readEnvFile: false, cliArgs: [] });
    log('[labroute:build] PostgreSQL setup verified; building the site.');
  } else {
    log(`[labroute:build] PostgreSQL setup skipped: ${plan.reason}.`);
  }
  await build();
}

module.exports = { initializationPlan, runVercelBuild };
if (require.main === module) {
  runVercelBuild().catch((error) => {
    console.error(`[labroute:build] Build stopped: ${error.code || error.name || 'Error'}: ${safeErrorMessage(error)}`);
    console.error('[labroute:build] Fix the setup/build error before redeploying. Database URLs and passwords must stay private.');
    process.exitCode = error.exitCode || 1;
  });
}
