'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { createApp } = require('../server');
const { sha256 } = require('../lib/util');
const { importDatabase, contentDocuments } = require('../tools/import-db');
const { setupDatabase, verifyRuntimeDatabase } = require('../tools/migrate-db');
const { postgresFixture, listen, closeApp, request, uploadBody, PNG } = require('./postgres-fixture');

const root = path.join(__dirname, '..');
function build(env) {
  const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build:vercel'], {
    cwd: root, env, encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024
  });
  if (result.error) throw result.error;
  return { ...result, output: result.stdout + result.stderr };
}

async function relation(pool, name) {
  return (await pool.query('SELECT to_regclass($1) AS relation', [`public.${name}`])).rows[0].relation;
}

const buildEnv = (fixture, changes = {}) => ({ ...process.env,
  VERCEL: '1', VERCEL_ENV: 'production', VERCEL_TARGET_ENV: 'production',
  DATABASE_URL: fixture.databaseUrl, DATABASE_URL_UNPOOLED: fixture.databaseUrl,
  MOMENTS_STORAGE: 'postgres', MOMENTS_MIGRATE_ON_BUILD: '1',
  MOMENTS_SECRET: '', MOMENTS_EMAIL_PROVIDER: 'none', ...changes });

test('the real Vercel build command fixes a fresh database and preserves live state on rebuild', { timeout: 180000 }, async (t) => {
  const fixture = await postgresFixture({ initialize: false });
  const apps = [];
  const app = createApp(fixture.overrides);
  apps.push(app);
  const base = await listen(app);
  let cookie;
  let upload;
  let rejectedId;
  let before;
  try {
    await t.test('reproduces the missing-table failure before setup', async () => {
      assert.equal(await relation(fixture.pool, 'labroute_settings'), null);
      const health = await request(base, '/api/health');
      assert.equal(health.status, 503);
      assert.equal(health.json.error, 'database_unavailable');
    });

    await t.test('a preview build with the flag enabled runs only the static build, leaving the database empty', async () => {
      const result = build(buildEnv(fixture, { VERCEL_ENV: 'preview', VERCEL_TARGET_ENV: 'preview' }));
      assert.equal(result.status, 0, result.output);
      assert.match(result.output, /PostgreSQL setup skipped/);
      assert.match(result.output, /Build passed/);
      assert.equal(await relation(fixture.pool, 'labroute_settings'), null);
      assert.equal(await relation(fixture.pool, 'labroute_schema_migrations'), null);
    });

    await t.test('an opted-in production build creates the schema, imports repository seeds, and verifies the runtime URL', async () => {
      const result = build(buildEnv(fixture));
      assert.equal(result.status, 0, result.output);
      assert.match(result.output, /Migrations: 001_neon_storage.sql/);
      assert.match(result.output, /Imported \(source files retained\)/);
      assert.match(result.output, /PostgreSQL runtime connection: ready/);
      assert.ok(result.output.indexOf('Database setup: OK') < result.output.indexOf('Build passed:'));
      const expectedAdmins = JSON.parse(await fs.readFile(path.join(root, 'data/admins.json'), 'utf8')).admins;
      const expectedGallery = JSON.parse(await fs.readFile(path.join(root, 'content/gallery.json'), 'utf8'));
      const expectedDocuments = await contentDocuments(path.join(root, 'content'));
      assert.equal(Number((await fixture.pool.query('SELECT count(*) FROM labroute_admins')).rows[0].count), expectedAdmins.length);
      assert.equal(Number((await fixture.pool.query('SELECT count(*) FROM labroute_moments')).rows[0].count), expectedGallery.length);
      assert.equal(Number((await fixture.pool.query('SELECT count(*) FROM labroute_documents')).rows[0].count), expectedDocuments.length);
      const health = await request(base, '/api/health');
      assert.equal(health.status, 200, health.text);
      assert.equal(health.json.database.connected, true);
      assert.equal(health.json.storage, 'postgres');
      assert.equal(health.json.durable, true);
      // Required files are available only at build time, not in the public output.
      for (const name of ['tools', 'migrations', 'data', '.env.local', 'content', 'assets/gallery/moments']) {
        await assert.rejects(fs.access(path.join(root, 'dist', name)), { code: 'ENOENT' });
      }
    });

    await t.test('the initialized app can log in, accept a private upload, approve it first, and reject another', async () => {
      // A disposable extra admin is added only to this local test database.
      await fixture.pool.query('INSERT INTO labroute_admins (email, password_hash) VALUES ($1, $2)',
        [fixture.admin.email, sha256(fixture.admin.password)]);
      const login = await request(base, '/api/admin/login', { method: 'POST', body: fixture.admin });
      assert.equal(login.status, 200);
      cookie = login.cookie;
      upload = await request(base, '/api/moments', { method: 'POST', body: uploadBody('Vercel initialization E2E'), device: 'vercel-setup-visitor-one' });
      assert.equal(upload.status, 201, upload.text);
      const id = upload.json.moment.id;
      assert.equal((await fetch(`${base}/assets/gallery/moments/${id}.png`)).status, 404);
      const pending = await request(base, '/api/admin/pending', { cookie });
      assert.ok(pending.json.pending.some((item) => item.id === id));
      const approved = await request(base, `/api/admin/pending/${id}/approve`, { method: 'POST', cookie });
      assert.equal(approved.status, 200, approved.text);
      const gallery = await request(base, '/api/gallery');
      assert.equal(gallery.json.gallery[0].id, id);
      const image = await fetch(`${base}/${gallery.json.gallery[0].image}`);
      assert.equal(image.status, 200);
      assert.deepEqual(Buffer.from(await image.arrayBuffer()), PNG);
      const rejectUpload = await request(base, '/api/moments', { method: 'POST', body: uploadBody('Reject after Vercel setup'), device: 'vercel-setup-visitor-two' });
      assert.equal(rejectUpload.status, 201);
      rejectedId = rejectUpload.json.moment.id;
      assert.equal((await request(base, `/api/admin/pending/${rejectedId}/reject`, { method: 'POST', cookie })).status, 200);
      assert.equal((await fetch(`${base}/assets/gallery/moments/${rejectedId}.png`)).status, 404);
    });

    await t.test('another production build preserves database edits, photos, rejected tombstones, sessions and the signing key', async () => {
      await fixture.pool.query("UPDATE labroute_documents SET body = $1::jsonb WHERE path = 'ads.json'",
        [JSON.stringify({ enabled: false, title: 'Operator edit in PostgreSQL' })]);
      before = (await fixture.pool.query('SELECT key, value FROM labroute_settings ORDER BY key')).rows;
      const result = build(buildEnv(fixture));
      assert.equal(result.status, 0, result.output);
      assert.match(result.output, /Migrations: already up to date/);
      assert.match(result.output, /Initial data: already initialized/);
      assert.doesNotMatch(result.output, /Imported \(source files retained\)/);
      assert.deepEqual((await fixture.pool.query('SELECT key, value FROM labroute_settings ORDER BY key')).rows, before);
      assert.equal((await request(base, '/content/ads.json')).json.title, 'Operator edit in PostgreSQL');
      assert.equal((await request(base, '/api/gallery')).json.gallery[0].id, upload.json.moment.id);
      assert.equal((await fixture.pool.query('SELECT status, image_data FROM labroute_moments WHERE id = $1', [rejectedId])).rows[0].image_data, null);
      assert.equal((await request(base, '/api/admin/pending', { cookie })).status, 200);
      const cold = createApp({ ...fixture.overrides, runtimeDir: path.join(fixture.root, 'another-runtime') });
      apps.push(cold);
      const coldBase = await listen(cold);
      assert.equal((await request(coldBase, '/api/gallery')).json.gallery[0].id, upload.json.moment.id);
      assert.equal((await request(coldBase, '/api/admin/pending', { cookie })).status, 200);
      const cooldown = await request(coldBase, '/api/moments/status', { cookie: upload.cookie, device: 'vercel-setup-visitor-one' });
      assert.equal(cooldown.json.canUpload, false);
    });

    await t.test('production with the flag off succeeds without a reachable database', () => {
      const result = build(buildEnv(fixture, { MOMENTS_MIGRATE_ON_BUILD: '0', DATABASE_URL: 'invalid-but-unused', DATABASE_URL_UNPOOLED: '' }));
      assert.equal(result.status, 0, result.output);
      assert.match(result.output, /setup skipped: MOMENTS_MIGRATE_ON_BUILD is not enabled/);
      assert.match(result.output, /Build passed/);
    });

    await t.test('an enabled setup failure exits nonzero, leaks no credentials, and never starts the static build', async () => {
      const unreachable = 'postgresql://test:do-not-log-this-password@127.0.0.1:1/postgres?sslmode=disable';
      const result = build(buildEnv(fixture, { DATABASE_URL: unreachable, DATABASE_URL_UNPOOLED: '' }));
      assert.notEqual(result.status, 0);
      assert.match(result.output, /Build stopped/);
      assert.doesNotMatch(result.output, /Build passed|Built \d+ pages/);
      assert.ok(!result.output.includes(unreachable));
      assert.ok(!result.output.includes('do-not-log-this-password'));
      assert.equal((await request(base, '/api/health')).status, 200);
    });

    await t.test('a working direct URL cannot hide broken pooled runtime credentials', async () => {
      const runtime = new URL(fixture.databaseUrl);
      runtime.username = 'nonexistent_runtime_role';
      runtime.password = 'a-test-password-that-must-not-be-logged';
      const result = build(buildEnv(fixture, { DATABASE_URL: runtime.toString() }));
      assert.notEqual(result.status, 0);
      assert.match(result.output, /28P01/);
      assert.doesNotMatch(result.output, /PostgreSQL runtime connection: ready|Build passed/);
      assert.ok(!result.output.includes(runtime.password));
      assert.equal((await request(base, '/api/health')).status, 200);
    });

    await t.test('mismatched migration and runtime database targets are rejected before migration', () => {
      const result = build(buildEnv(fixture, { DATABASE_URL_UNPOOLED: fixture.databaseUrl.replace('/postgres?', '/different_database?') }));
      assert.notEqual(result.status, 0);
      assert.match(result.output, /same endpoint and database/);
      assert.doesNotMatch(result.output, /PostgreSQL direct connection: OK|Build passed/);
    });
  } finally {
    for (const current of apps) await closeApp(current);
    await fixture.close();
  }
});

test('first-time import is atomic, repository-only, and does not overwrite existing content', { timeout: 120000 }, async (t) => {
  const fixture = await postgresFixture({ initialize: false });
  const setup = (config = fixture.config) => setupDatabase({ pool: fixture.pool, config, initializeOnly: true, log() {} });
  try {
    await t.test('a seed failure rolls back all initial data and does not write the completion marker', async () => {
      const badAdmins = path.join(fixture.root, 'bad-admins.json');
      await fs.writeFile(badAdmins, JSON.stringify({ admins: [{ email: fixture.admin.email, passwordCrypt: 'invalid-hash' }] }));
      await assert.rejects(setup({ ...fixture.config, adminsFile: badAdmins }), (error) => error.code === '23514');
      assert.ok(await relation(fixture.pool, 'labroute_moments'), 'the versioned schema was applied');
      assert.equal((await fixture.pool.query('SELECT key FROM labroute_settings')).rows.length, 0);
      assert.equal(Number((await fixture.pool.query('SELECT count(*) FROM labroute_admins')).rows[0].count), 0);
      assert.equal(Number((await fixture.pool.query('SELECT count(*) FROM labroute_documents')).rows[0].count), 0);
    });

    await t.test('a retry initializes from repository seeds, ignoring runtime files and the writable gallery manifest', async () => {
      await fs.mkdir(fixture.config.pendingDir, { recursive: true });
      await fs.mkdir(fixture.config.runtimeDir, { recursive: true });
      for (const name of [fixture.config.pendingFile, fixture.config.rateLimitFile]) await fs.writeFile(name, 'invalid JSON that must never be read by a build');
      await fs.writeFile(fixture.config.notificationsFile, '{"momentId":"legacy-runtime-log"}\n');
      await fs.writeFile(path.join(fixture.config.runtimeDir, 'secret.key'), 'legacy-runtime-secret-that-must-not-be-imported');
      const galleryFile = path.join(fixture.root, 'writable-gallery.json');
      await fs.writeFile(galleryFile, 'invalid writable gallery; only the repository seed is valid');
      const result = await setup({ ...fixture.config, galleryFile, secretConfigured: false });
      assert.equal(result.imported.admins, 1);
      assert.equal(result.imported.gallery, 8);
      assert.equal(result.imported.pending, 0);
      assert.equal(result.imported.rateEvents, 0);
      assert.equal(result.imported.notifications, 0);
      assert.ok((await fixture.pool.query("SELECT key FROM labroute_settings WHERE key = 'data_import_complete'")).rows.length);
      const secret = (await fixture.pool.query("SELECT value FROM labroute_settings WHERE key = 'cookie_secret'")).rows[0].value;
      assert.notEqual(secret, 'legacy-runtime-secret-that-must-not-be-imported');
      assert.equal((await fs.readFile(fixture.config.pendingFile, 'utf8')), 'invalid JSON that must never be read by a build');
      await verifyRuntimeDatabase(fixture.databaseUrl);
    });

    await t.test('successful initialization is a true no-op even if the original seed paths are no longer readable', async () => {
      await fixture.pool.query("UPDATE labroute_documents SET body = $1::jsonb WHERE path = 'ads.json'", [JSON.stringify({ operatorEdit: true })]);
      const settings = (await fixture.pool.query('SELECT key, value FROM labroute_settings ORDER BY key')).rows;
      const result = await setup({ ...fixture.config, contentDir: path.join(fixture.root, 'missing-content'), adminsFile: path.join(fixture.root, 'missing-admins') });
      assert.equal(result.imported, null);
      assert.deepEqual((await fixture.pool.query('SELECT key, value FROM labroute_settings ORDER BY key')).rows, settings);
      assert.equal((await fixture.pool.query("SELECT body FROM labroute_documents WHERE path = 'ads.json'")).rows[0].body.operatorEdit, true);
      assert.equal(await importDatabase({ pool: fixture.pool, config: {}, initializeOnly: true }), null);
    });

    await t.test('an incomplete import can be retried without replacing existing database document edits', async () => {
      await fixture.pool.query("DELETE FROM labroute_settings WHERE key = 'data_import_complete'");
      const result = await setup();
      assert.equal(result.imported.documents, 0);
      assert.equal((await fixture.pool.query("SELECT body FROM labroute_documents WHERE path = 'ads.json'")).rows[0].body.operatorEdit, true);
    });

    await t.test('missing or empty admin seeds never mark an initial database ready', async () => {
      await fixture.pool.query("DELETE FROM labroute_settings WHERE key = 'data_import_complete'");
      const empty = path.join(fixture.root, 'empty-admins.json');
      await fs.writeFile(empty, '{"admins":[]}');
      await assert.rejects(setup({ ...fixture.config, adminsFile: empty }), /admin\/content seeds are missing or empty/);
      assert.equal((await fixture.pool.query("SELECT key FROM labroute_settings WHERE key = 'data_import_complete'")).rows.length, 0);
      await setup();
    });

    await t.test('runtime readiness checks required tables and columns, not just SELECT 1', async () => {
      await fixture.pool.query('ALTER TABLE labroute_moments RENAME COLUMN contributor TO missing_contributor_for_test');
      try {
        await assert.rejects(verifyRuntimeDatabase(fixture.databaseUrl), (error) => error.code === '42703');
      } finally {
        await fixture.pool.query('ALTER TABLE labroute_moments RENAME COLUMN missing_contributor_for_test TO contributor');
      }
      await fixture.pool.query('DROP TABLE labroute_notifications');
      await assert.rejects(verifyRuntimeDatabase(fixture.databaseUrl), (error) => error.code === '42P01');
    });
  } finally { await fixture.close(); }
});

test('two concurrent initializers apply migrations safely and only one commits the initial seed', { timeout: 120000 }, async () => {
  const fixture = await postgresFixture({ initialize: false });
  try {
    const results = await Promise.all([1, 2].map(() => setupDatabase({ pool: fixture.pool,
      config: fixture.config, initializeOnly: true, log() {} })));
    assert.equal(results.filter((result) => result.imported !== null).length, 1);
    assert.equal(results.flatMap((result) => result.applied).length, 1);
    assert.equal(Number((await fixture.pool.query('SELECT count(*) FROM labroute_admins')).rows[0].count), 1);
    assert.equal(Number((await fixture.pool.query('SELECT count(*) FROM labroute_moments')).rows[0].count), 8);
    assert.equal(Number((await fixture.pool.query('SELECT count(*) FROM labroute_schema_migrations')).rows[0].count), 1);
    assert.equal((await fixture.pool.query("SELECT key FROM labroute_settings WHERE key = 'data_import_complete'")).rows.length, 1);
    await verifyRuntimeDatabase(fixture.databaseUrl);
  } finally { await fixture.close(); }
});
