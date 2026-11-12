'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { test } = require('node:test');
const { createApp } = require('../server');
const { loadConfig } = require('../lib/config');
const { databaseUrl } = require('../lib/postgres');
const { migrate } = require('../lib/postgres-migrations');
const { importDatabase, contentDocuments } = require('../tools/import-db');
const { createMemoryBlobStorage, STATE_PATHS, pendingImagePath, galleryImagePath } = require('../lib/blob-storage');
const { createVercelHandler } = require('../lib/vercel-handler');
const { postgresFixture, listen, closeApp, request, uploadBody, PNG } = require('./postgres-fixture');

test('PostgreSQL storage (real PostgreSQL, no SQL mocks)', { timeout: 120000 }, async (t) => {
  const fixture = await postgresFixture();
  const apps = [];
  const newApp = async (overrides = {}) => {
    const app = createApp({ ...fixture.overrides, ...overrides });
    apps.push(app);
    return { app, base: await listen(app) };
  };
  const { app: appA, base: baseA } = await newApp();
  const { app: appB, base: baseB } = await newApp({ runtimeDir: path.join(fixture.root, 'different-instance') });
  let adminCookie;
  let upload;
  let second;
  try {
    await t.test('versioned migrations and seeds are repeatable; all content and admins are in PostgreSQL', async () => {
      assert.deepEqual(fixture.applied, ['001_neon_storage.sql']);
      assert.deepEqual(await migrate(fixture.pool), []);
      assert.equal(fixture.imported.admins, 1);
      const expected = await contentDocuments(fixture.config.contentDir);
      assert.equal(fixture.imported.documents, expected.length);
      const importedAgain = await importDatabase({ pool: fixture.pool, config: fixture.config });
      assert.equal(importedAgain.gallery, 0);
      assert.equal(importedAgain.admins, 0);
      const health = await request(baseA, '/api/health');
      assert.equal(health.status, 200);
      assert.equal(health.json.storage, 'postgres');
      assert.equal(health.json.durable, true);
      assert.equal(health.json.database.connected, true);
      const reports = await request(baseA, '/content/reports/index.json');
      assert.equal(reports.status, 200);
      assert.ok(reports.json.length > 0);
      const products = await request(baseA, '/content/products.json');
      assert.equal(products.status, 200);
      const ads = await request(baseA, '/content/ads.json');
      assert.equal(ads.status, 200);
      assert.equal(await request(baseA, '/content/reports/does-not-exist.json').then((r) => r.status), 404);
    });

    await t.test('server-side admin login; hashes, env files, and pending data are never static assets', async () => {
      for (const file of ['/data/admins.json', '/.env.local', '/.neon', '/lib/postgres.js', '/tools/migrate-db.js', '/migrations/001_neon_storage.sql', '/neon.ts']) {
        assert.equal((await request(baseA, file)).status, 404, file);
      }
      assert.equal((await request(baseA, '/api/admin/pending')).status, 401);
      assert.equal((await request(baseA, '/api/admin/login', { method: 'POST', body: { ...fixture.admin, password: 'incorrect' } })).status, 401);
      const login = await request(baseA, '/api/admin/login', { method: 'POST', body: fixture.admin });
      assert.equal(login.status, 200);
      adminCookie = login.cookie;
      assert.ok(adminCookie.startsWith('labroute_admin='));
    });

    await t.test('admin login throttling is shared by independent instances', async () => {
      const statuses = [];
      for (let n = 0; n < 11; n++) {
        statuses.push((await request(n % 2 ? baseA : baseB, '/api/admin/login', {
          method: 'POST', body: { email: 'unknown@labroute.invalid', password: 'wrong' }, ip: '192.0.2.91'
        })).status);
      }
      assert.deepEqual(statuses, [...Array(10).fill(401), 429]);
      const stored = (await fixture.pool.query('SELECT key FROM labroute_login_attempts')).rows;
      assert.ok(stored.every((row) => /^[a-f0-9]{64}$/.test(row.key)));
    });

    await t.test('database documents are authoritative, not a copy silently read from disk', async () => {
      const original = (await fixture.pool.query("SELECT body FROM labroute_documents WHERE path = 'ads.json'")).rows[0].body;
      try {
        await fixture.pool.query("UPDATE labroute_documents SET body = $1::jsonb WHERE path = 'ads.json'", [JSON.stringify({ enabled: false, sourceTest: 'postgres-only' })]);
        assert.equal((await request(baseA, '/content/ads.json')).json.sourceTest, 'postgres-only');
      } finally {
        await fixture.pool.query("UPDATE labroute_documents SET body = $1::jsonb WHERE path = 'ads.json'", [JSON.stringify(original)]);
      }
    });

    await t.test('upload stores image bytes and metadata together; pending stays private', async () => {
      upload = await request(baseA, '/api/moments', { method: 'POST', body: uploadBody(), device: 'device-pg-one' });
      assert.equal(upload.status, 201, upload.text);
      assert.equal(upload.json.pending, true);
      assert.equal(upload.json.canUpload, false);
      const id = upload.json.moment.id;
      const { rows } = await fixture.pool.query('SELECT status, image_data, bytes FROM labroute_moments WHERE id = $1', [id]);
      assert.equal(rows[0].status, 'pending');
      assert.deepEqual(rows[0].image_data, PNG);
      assert.equal(rows[0].bytes, PNG.length);
      assert.equal((await request(baseA, `/api/admin/pending/${id}/image`)).status, 401);
      assert.equal((await fetch(`${baseA}/assets/gallery/moments/${id}.png`)).status, 404);
      const gallery = await request(baseA, '/api/gallery');
      assert.equal(gallery.json.source, 'postgres');
      assert.ok(!gallery.json.gallery.some((item) => item.id === id));
      const image = await fetch(`${baseA}/api/admin/pending/${id}/image`, { headers: { Cookie: adminCookie } });
      assert.equal(image.status, 200);
      assert.deepEqual(Buffer.from(await image.arrayBuffer()), PNG);
      assert.ok((await fixture.pool.query('SELECT body FROM labroute_notifications')).rows.some((row) => row.body.momentId === id));
      for (const dir of [fixture.overrides.pendingDir, fixture.overrides.runtimeDir, fixture.overrides.uploadDir]) {
        await assert.rejects(fs.access(dir), { code: 'ENOENT' });
      }
    });

    await t.test('a matching legacy file on disk cannot bypass PostgreSQL moderation', async () => {
      const shadowRoot = path.join(fixture.root, 'shadow-site');
      const id = upload.json.moment.id;
      await fs.mkdir(path.join(shadowRoot, 'assets', 'gallery', 'moments'), { recursive: true });
      await fs.writeFile(path.join(shadowRoot, 'assets', 'gallery', 'moments', `${id}.png`), PNG);
      const { base } = await newApp({ rootDir: shadowRoot });
      assert.equal((await fetch(`${base}/assets/gallery/moments/${id}.png`)).status, 404);
    });

    await t.test('fresh independent instance retains pending images, cookies, and per-visitor cooldowns', async () => {
      const queue = await request(baseB, '/api/admin/pending', { cookie: adminCookie });
      assert.equal(queue.status, 200);
      assert.ok(queue.json.pending.some((item) => item.id === upload.json.moment.id));
      assert.equal(appA.config.secret, appB.config.secret);
      const status = await request(baseB, '/api/moments/status', { cookie: upload.cookie, device: 'device-pg-one' });
      assert.equal(status.json.canUpload, false);
      const again = await request(baseB, '/api/moments', { method: 'POST', body: uploadBody(), cookie: upload.cookie, device: 'device-pg-one' });
      assert.equal(again.status, 429);
    });

    await t.test('Approve immediately publishes first, even when an older upload is reviewed last', async () => {
      const id = upload.json.moment.id;
      await fixture.pool.query("UPDATE labroute_moments SET uploaded_at = now() - interval '4 days' WHERE id = $1", [id]);
      second = await request(baseB, '/api/moments', { method: 'POST', body: uploadBody('A more recent submission'), device: 'device-pg-two' });
      assert.equal(second.status, 201);
      assert.equal((await request(baseB, `/api/admin/pending/${second.json.moment.id}/approve`, { method: 'POST', cookie: adminCookie })).status, 200);
      const approval = await request(baseA, `/api/admin/pending/${id}/approve`, { method: 'POST', cookie: adminCookie });
      assert.equal(approval.status, 200, approval.text);
      assert.equal(approval.json.source, 'postgres');
      assert.equal(approval.json.durable, true);
      const gallery = await request(baseB, '/api/gallery');
      assert.equal(gallery.json.gallery[0].id, id);
      assert.equal(gallery.json.gallery[1].id, second.json.moment.id);
      assert.ok(gallery.json.gallery[0].approvedAt);
      const bytes = await fetch(`${baseB}/${gallery.json.gallery[0].image}`);
      assert.equal(bytes.status, 200);
      assert.deepEqual(Buffer.from(await bytes.arrayBuffer()), PNG);
      const head = await fetch(`${baseB}/${gallery.json.gallery[0].image}`, { method: 'HEAD' });
      assert.equal(Number(head.headers.get('content-length')), PNG.length);
      assert.equal((await request(baseB, `/api/admin/pending/${id}/image`, { cookie: adminCookie })).status, 404);
      const retry = await request(baseB, `/api/admin/pending/${id}/approve`, { method: 'POST', cookie: adminCookie });
      assert.equal(retry.status, 200);
      assert.equal(retry.json.gallery.filter((item) => item.id === id).length, 1);
      const sandbox = { document: { addEventListener() {} }, window: {}, console };
      vm.runInNewContext(await fs.readFile(path.join(__dirname, '..', 'js/app.js'), 'utf8'), sandbox);
      assert.equal(sandbox.orderGallery(gallery.json.gallery)[0].id, id, 'browser ordering must not undo approval ordering');
      const oldPublish = await request(baseA, `/api/admin/pending/${id}/publish`, { method: 'POST', cookie: adminCookie });
      assert.equal(oldPublish.status, 410);
    });

    await t.test('Reject removes the bytes, keeps the gallery unchanged, and cannot be undone by reimport', async () => {
      const pending = await request(baseB, '/api/moments', { method: 'POST', body: uploadBody('Please reject this test'), device: 'device-pg-reject' });
      const id = pending.json.moment.id;
      const rejected = await request(baseA, `/api/admin/pending/${id}/reject`, { method: 'POST', cookie: adminCookie });
      assert.equal(rejected.status, 200);
      const stored = (await fixture.pool.query('SELECT status, image_data FROM labroute_moments WHERE id = $1', [id])).rows[0];
      assert.equal(stored.status, 'rejected');
      assert.equal(stored.image_data, null);
      assert.equal((await request(baseA, `/api/admin/pending/${id}/image`, { cookie: adminCookie })).status, 404);
      assert.equal((await fetch(`${baseA}/assets/gallery/moments/${id}.png`)).status, 404);
      assert.equal((await request(baseA, `/api/admin/pending/${id}/approve`, { method: 'POST', cookie: adminCookie })).status, 404);
      const blob = createMemoryBlobStorage();
      await blob.putJson(STATE_PATHS.pending, [{ id, ext: 'png', caption: 'Stale source', uploadedAt: new Date().toISOString() }]);
      await blob.putBytes(pendingImagePath(`${id}.png`), PNG);
      await importDatabase({ pool: fixture.pool, config: fixture.config, blobStorage: blob });
      assert.equal((await fixture.pool.query('SELECT status FROM labroute_moments WHERE id = $1', [id])).rows[0].status, 'rejected');
      assert.deepEqual(await blob.getBytes(pendingImagePath(`${id}.png`)), PNG);
    });

    await t.test('concurrent uploads across two instances cannot bypass a shared cooldown', async () => {
      const results = await Promise.all([baseA, baseB].map((base) => request(base, '/api/moments', {
        method: 'POST', body: uploadBody('Concurrent cooldown'), device: 'device-concurrent-pg', ip: '192.0.2.20'
      })));
      assert.deepEqual(results.map((result) => result.status).sort(), [201, 429]);
    });

    await t.test('network limits count distinct uploads even in the exact same millisecond', async () => {
      const { app } = await newApp({ ipLimit: 2 });
      await app.ctx.database.initialize();
      const now = Date.now();
      const identity = (n) => ({ visitorId: `network-visitor-${n}`, deviceId: `network-device-${n}`, ip: '192.0.2.74', userAgent: 'test' });
      const results = await Promise.all([1, 2].map((n) => app.ctx.moments.createMoment(uploadBody('Same millisecond'), identity(n), now)));
      assert.equal(results.length, 2);
      await assert.rejects(app.ctx.moments.createMoment(uploadBody('Network limit'), identity(3), now),
        (error) => error.status === 429 && error.extra.reason === 'network');
    });

    await t.test('concurrent approvals do not overwrite each other, and approve/reject races have one winner', async () => {
      const received = await Promise.all([0, 1, 2].map((n) => request(baseA, '/api/moments', {
        method: 'POST', body: uploadBody(`Parallel review ${n}`), device: `device-pg-parallel-${n}`
      })));
      for (const result of received) assert.equal(result.status, 201, result.text);
      const ids = received.map((result) => result.json.moment.id);
      const approved = await Promise.all(ids.slice(0, 2).map((id, i) => request(i ? baseA : baseB,
        `/api/admin/pending/${id}/approve`, { method: 'POST', cookie: adminCookie })));
      assert.ok(approved.every((result) => result.status === 200));
      const gallery = (await request(baseB, '/api/gallery')).json.gallery;
      assert.ok(ids.slice(0, 2).every((id) => gallery.some((item) => item.id === id)));
      const race = await Promise.all(['approve', 'reject'].map((action, i) => request(i ? baseA : baseB,
        `/api/admin/pending/${ids[2]}/${action}`, { method: 'POST', cookie: adminCookie })));
      assert.deepEqual(race.map((result) => result.status).sort(), [200, 404]);
      const state = (await fixture.pool.query('SELECT status, image_data FROM labroute_moments WHERE id = $1', [ids[2]])).rows[0];
      assert.ok(['approved', 'rejected'].includes(state.status));
      assert.equal(Boolean(state.image_data), state.status === 'approved');
    });

    await t.test('a failed cooldown write rolls back the image and metadata instead of acknowledging a partial upload', async () => {
      const before = (await fixture.pool.query('SELECT count(*) FROM labroute_moments')).rows[0].count;
      await fixture.pool.query(`CREATE FUNCTION labroute_test_fail_rate() RETURNS trigger LANGUAGE plpgsql AS
        $$ BEGIN RAISE EXCEPTION 'injected rate write failure'; END $$;
        CREATE TRIGGER labroute_test_fail_rate BEFORE INSERT ON labroute_rate_events
        FOR EACH ROW EXECUTE FUNCTION labroute_test_fail_rate()`);
      try {
        const failed = await request(baseA, '/api/moments', { method: 'POST', body: uploadBody('Transaction rollback'), device: 'device-pg-rollback' });
        assert.equal(failed.status, 503);
        assert.equal((await fixture.pool.query('SELECT count(*) FROM labroute_moments')).rows[0].count, before);
      } finally {
        await fixture.pool.query('DROP TRIGGER labroute_test_fail_rate ON labroute_rate_events; DROP FUNCTION labroute_test_fail_rate()');
      }
    });

    await t.test('legacy Blob import copies pending and approved bytes without deleting sources or duplicating rows', async () => {
      const blob = createMemoryBlobStorage();
      const pendingId = 'moment-legacy-pending';
      const approvedId = 'moment-legacy-approved';
      await blob.putJson(STATE_PATHS.pending, [{ id: pendingId, ext: 'png', mime: 'image/png', caption: 'Legacy pending', uploadedAt: '2026-10-01T00:00:00Z' }]);
      await blob.putBytes(pendingImagePath(`${pendingId}.png`), PNG);
      await blob.putJson(STATE_PATHS.gallery, [{ id: approvedId, uploaded: true, image: `assets/gallery/moments/${approvedId}.png`, caption: 'Legacy approved', uploadedAt: '2026-09-01T00:00:00Z' }]);
      await blob.putBytes(galleryImagePath(`${approvedId}.png`), PNG);
      const imported = await importDatabase({ pool: fixture.pool, config: fixture.config, blobStorage: blob });
      assert.equal(imported.pending, 1);
      assert.equal(imported.gallery, 1);
      assert.equal((await importDatabase({ pool: fixture.pool, config: fixture.config, blobStorage: blob })).pending, 0);
      assert.ok(await blob.getBytes(pendingImagePath(`${pendingId}.png`)));
      const queued = await request(baseB, '/api/admin/pending', { cookie: adminCookie });
      assert.ok(queued.json.pending.some((item) => item.id === pendingId));
      assert.deepEqual(Buffer.from(await (await fetch(`${baseA}/assets/gallery/moments/${approvedId}.png`)).arrayBuffer()), PNG);
      await blob.putJson(STATE_PATHS.pending, [{ id: 'moment-missing-legacy', ext: 'png', caption: 'Missing source' }]);
      await assert.rejects(importDatabase({ pool: fixture.pool, config: fixture.config, blobStorage: blob }), /Missing pending photo/);
      assert.equal((await fixture.pool.query("SELECT id FROM labroute_moments WHERE id = 'moment-missing-legacy'")).rows.length, 0);
    });

    await t.test('Vercel rewrites serve database content and approved image bytes through the same API', async () => {
      const handler = createVercelHandler(fixture.overrides);
      const server = http.createServer(handler);
      const base = await listen({ server });
      try {
        const reports = await request(base, '/api?__labroute_path=content/reports/index.json');
        assert.equal(reports.status, 200);
        const gallery = await request(base, '/api?__labroute_path=gallery');
        const item = gallery.json.gallery.find((value) => value.id === upload.json.moment.id);
        const response = await fetch(`${base}/api?__labroute_path=moment-image/${path.basename(item.image)}`);
        assert.equal(response.status, 200);
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), PNG);
      } finally { await new Promise((resolve) => server.close(resolve)); await handler.close(); }
    });

    await t.test('new process-style instance still reads approvals after prior app instances are closed', async () => {
      for (const app of apps.splice(0)) await closeApp(app);
      const { base } = await newApp();
      const gallery = await request(base, '/api/gallery');
      assert.ok(gallery.json.gallery.some((item) => item.id === upload.json.moment.id));
      assert.equal((await request(base, '/api/admin/pending', { cookie: adminCookie })).status, 200);
    });

    await t.test('an incomplete migration/import refuses traffic and recovers after completion', async () => {
      const previous = (await fixture.pool.query("DELETE FROM labroute_settings WHERE key = 'data_import_complete' RETURNING value")).rows[0].value;
      const { base } = await newApp();
      try {
        const response = await request(base, '/api/gallery');
        assert.equal(response.status, 503);
        assert.equal(response.json.error, 'database_not_initialized');
      } finally {
        await fixture.pool.query("INSERT INTO labroute_settings (key, value) VALUES ('data_import_complete', $1)", [previous]);
      }
      assert.equal((await request(base, '/api/gallery')).status, 200);
    });

    await t.test('database errors fail closed with 503, not an empty queue or the committed gallery seed', async () => {
      const { app, base } = await newApp();
      await app.ctx.database.initialize();
      await app.ctx.database.close();
      for (const endpoint of ['/api/health', '/api/gallery', '/api/admin/pending', '/content/reports/index.json']) {
        const result = await request(base, endpoint, { cookie: adminCookie });
        assert.equal(result.status, 503, endpoint);
        assert.equal(result.json.error, 'database_unavailable');
      }
      const result = await request(base, '/api/moments', { method: 'POST', body: uploadBody(), device: 'device-pg-unavailable' });
      assert.equal(result.status, 503);
      assert.ok(!result.text.includes('postgresql://'));
      await new Promise((resolve) => app.server.close(resolve));
      apps.splice(apps.indexOf(app), 1);
    });
  } finally {
    for (const app of apps) await closeApp(app);
    await fixture.close();
  }
});

test('PostgreSQL is preferred automatically, URL HTML entities are normalized, direct migrations bypass the pooler', () => {
  const url = 'postgresql://owner:test-only@example-pooler.neon.tech/db?sslmode=require&amp;channel_binding=require';
  const config = loadConfig({ storage: 'auto', databaseUrl: url });
  assert.equal(config.storageMode, 'postgres');
  assert.equal(databaseUrl(url).searchParams.get('channel_binding'), 'require');
  assert.equal(databaseUrl(url, { direct: true }).hostname, 'example.neon.tech');
  assert.throws(() => loadConfig({ storage: 'postgres', databaseUrl: '' }), /requires DATABASE_URL/);
});

test('serverless without durable storage rejects new uploads rather than losing them in /tmp', async () => {
  const app = createApp({ storage: 'local', serverless: true, secret: 'ephemeral-test-only-secret', email: { provider: 'none' } });
  const base = await listen(app);
  try {
    const result = await request(base, '/api/moments', { method: 'POST', body: uploadBody() });
    assert.equal(result.status, 503);
    assert.equal(result.json.error, 'durable_storage_required');
  } finally { await closeApp(app); }
});
