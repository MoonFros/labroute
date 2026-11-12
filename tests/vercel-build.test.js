'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { initializationPlan, runVercelBuild } = require('../tools/vercel-build');
const { migrationUrl, safeErrorMessage, setupDatabase } = require('../tools/migrate-db');

const runtimeUrl = 'postgresql://app:test-only@ep-build-test-pooler.c-8.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require';
const directUrl = 'postgresql://owner:also-test-only@ep-build-test.c-8.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require';
const production = (changes = {}) => ({ VERCEL: '1', VERCEL_ENV: 'production', VERCEL_TARGET_ENV: 'production',
  DATABASE_URL: runtimeUrl, DATABASE_URL_UNPOOLED: directUrl, MOMENTS_STORAGE: 'postgres',
  MOMENTS_MIGRATE_ON_BUILD: '1', ...changes });

test('local, preview, development and custom builds cannot initialize even with the flag and a database URL', async (t) => {
  for (const [name, env] of [
    ['ordinary local build', { DATABASE_URL: runtimeUrl, MOMENTS_MIGRATE_ON_BUILD: '1' }],
    ['local with VERCEL_ENV set', production({ VERCEL: undefined })],
    ['preview', production({ VERCEL_ENV: 'preview', VERCEL_TARGET_ENV: 'preview' })],
    ['development', production({ VERCEL_ENV: 'development', VERCEL_TARGET_ENV: 'development' })],
    ['custom environment', production({ VERCEL_TARGET_ENV: 'staging' })],
    ['missing production marker', production({ VERCEL_ENV: undefined })]
  ]) {
    await t.test(name, async () => {
      let built = false;
      await runVercelBuild({ env,
        initialize: async () => assert.fail('a non-production build tried to initialize PostgreSQL'),
        build: () => { built = true; }, log() {} });
      assert.equal(built, true);
    });
  }
});

test('production setup is off by default and respects explicit opt-out values', () => {
  for (const value of [undefined, '', '0', 'false', ' FALSE ']) {
    assert.equal(initializationPlan(production({ MOMENTS_MIGRATE_ON_BUILD: value })).initialize, false);
  }
});

test('production requires explicit 1/true and accepts an absent optional target marker', () => {
  for (const value of ['1', 'true', ' TRUE ']) {
    assert.equal(initializationPlan(production({ MOMENTS_MIGRATE_ON_BUILD: value })).initialize, true);
  }
  assert.equal(initializationPlan(production({ VERCEL_TARGET_ENV: undefined })).initialize, true);
  assert.throws(() => initializationPlan(production({ MOMENTS_MIGRATE_ON_BUILD: 'yes' })), /must be 1\/true/);
});

test('skipped builds do not parse or use database credentials', () => {
  assert.equal(initializationPlan(production({ VERCEL_ENV: 'preview', DATABASE_URL: 'invalid', DATABASE_URL_UNPOOLED: 'invalid' })).initialize, false);
  assert.equal(initializationPlan(production({ MOMENTS_MIGRATE_ON_BUILD: '0', DATABASE_URL: undefined })).initialize, false);
});

test('opted-in production setup rejects absent/invalid credentials or a non-PostgreSQL runtime mode before any work', async () => {
  for (const env of [production({ DATABASE_URL: undefined }), production({ DATABASE_URL: '' }),
    production({ DATABASE_URL: 'https://example.com/db' }), production({ DATABASE_URL: 'invalid' }),
    production({ MOMENTS_STORAGE: 'blob' }), production({ MOMENTS_STORAGE: 'local' })]) {
    await assert.rejects(runVercelBuild({ env,
      initialize: async () => assert.fail('invalid settings reached the initializer'),
      build: () => assert.fail('invalid settings reached the static build'), log() {} }));
  }
  assert.equal(initializationPlan(production({ MOMENTS_STORAGE: 'auto' })).initialize, true);
});

test('migrations use the direct Neon endpoint and reject a different database before connecting', () => {
  assert.equal(migrationUrl(runtimeUrl).hostname, new URL(directUrl).hostname);
  assert.equal(migrationUrl(runtimeUrl, directUrl, { requireSameDatabase: true }).username, 'owner');
  assert.equal(migrationUrl(runtimeUrl.replace('&', '&amp;')).searchParams.get('channel_binding'), 'require');
  for (const url of [directUrl.replace('/neondb?', '/other_database?'),
    directUrl.replace('ep-build-test.', 'ep-other-branch.'), directUrl.replace('.neon.tech/', '.neon.tech:9999/')]) {
    assert.throws(() => initializationPlan(production({ DATABASE_URL_UNPOOLED: url })), /same endpoint and database/);
  }
  assert.equal(migrationUrl('postgresql://app:test@localhost/db', 'postgresql://owner:test@localhost:5432/db',
    { requireSameDatabase: true }).port, '5432');
  for (const query of ['host=other.neon.tech', 'port=9999', 'options=endpoint%3Dep-other-branch']) {
    for (const key of ['DATABASE_URL', 'DATABASE_URL_UNPOOLED']) {
      const url = key === 'DATABASE_URL' ? runtimeUrl : directUrl;
      assert.throws(() => initializationPlan(production({ [key]: `${url}&${query}` })), /routing overrides/);
    }
  }
  for (const url of ['postgresql://app:test@localhost', 'postgresql://app:test@/db']) {
    assert.throws(() => initializationPlan(production({ DATABASE_URL: url, DATABASE_URL_UNPOOLED: '' })),
      /explicit hostname and database name|valid PostgreSQL connection string/);
  }
  assert.throws(() => migrationUrl('postgresql://app:test@localhost/a%2Fb', 'postgresql://owner:test@localhost/a/b',
    { requireSameDatabase: true }), /same endpoint and database/);
});

test('the opt-in runs first-time setup before building, without reading local env files or inheriting CLI flags', async () => {
  const sequence = [];
  await runVercelBuild({ env: production(),
    initialize: async (options) => {
      sequence.push('initialize');
      assert.deepEqual(options, { initializeOnly: true, readEnvFile: false, cliArgs: [] });
    }, build: () => sequence.push('build'), log() {} });
  assert.deepEqual(sequence, ['initialize', 'build']);
});

test('a migration failure stops the static build', async () => {
  const failure = new Error('injected migration failure');
  await assert.rejects(runVercelBuild({ env: production(),
    initialize: async () => { throw failure; },
    build: () => assert.fail('static build must not run after failed setup'), log() {} }),
  (error) => error === failure);
});

test('a static build failure is not swallowed after successful setup', async () => {
  const failure = new Error('injected static build failure');
  failure.exitCode = 7;
  await assert.rejects(runVercelBuild({ env: production(), initialize: async () => {},
    build: () => { throw failure; }, log() {} }), (error) => error.exitCode === 7);
});

test('first-time setup cannot be combined with schema-only or legacy Blob import', async () => {
  for (const mode of [{ schemaOnly: true }, { fromBlob: true }, { importOnly: true }]) {
    await assert.rejects(setupDatabase({ pool: { query() { assert.fail('incompatible mode performed SQL'); } },
      config: {}, initializeOnly: true, ...mode }), /cannot be combined/);
  }
});

test('build failure messages redact connection strings and Neon password tokens', () => {
  const message = safeErrorMessage(new Error(`Failed for ${runtimeUrl} and npg_NOTAREALPASSWORD`));
  assert.ok(!message.includes(runtimeUrl));
  assert.ok(!message.includes('npg_NOTAREALPASSWORD'));
  assert.match(message, /redacted/);
});

test('Vercel uses the guarded wrapper while the ordinary build stays database-free', () => {
  const root = path.join(__dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const vercel = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
  assert.equal(vercel.buildCommand, 'npm run build:vercel');
  assert.equal(pkg.scripts['build:vercel'], 'node tools/vercel-build.js');
  assert.equal(pkg.scripts.build, 'tsc -p tsconfig.neon.json && node tools/build.js');
  assert.ok(!fs.readFileSync(path.join(root, 'tools/build.js'), 'utf8').includes("require('./migrate-db')"));
});
