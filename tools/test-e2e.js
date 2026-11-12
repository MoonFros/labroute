#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const path = require('node:path');
const { postgresFixture, freePort, request, uploadBody, PNG } = require('../tests/postgres-fixture');

async function startApp(databaseUrl, port) {
  const child = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATABASE_URL: databaseUrl, DATABASE_URL_UNPOOLED: databaseUrl,
      MOMENTS_STORAGE: 'postgres', MOMENTS_EMAIL_PROVIDER: 'none', MOMENTS_SECRET: '',
      PORT: String(port), HOST: '0.0.0.0', VERCEL: '', VERCEL_ENV: '' },
    stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`App startup timed out. ${output}`)); }, 20000);
    const read = (chunk) => {
      output = (output + chunk.toString()).slice(-5000);
      if (output.includes('Bind:')) { clearTimeout(timer); resolve(); }
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`App exited (${code}): ${output}`)); });
  });
  return { base: `http://127.0.0.1:${port}`, async stop() {
    if (child.exitCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    try { await exited; } finally { clearTimeout(timer); }
  } };
}

async function main() {
  console.log('E2E target: isolated real PostgreSQL (not live Neon; no production data is touched).');
  const fixture = await postgresFixture();
  const port = await freePort();
  let app;
  try {
    console.log(`PASS migrations + import: ${fixture.imported.gallery} gallery records, ${fixture.imported.documents} content documents, ${fixture.imported.admins} test admin`);
    app = await startApp(fixture.databaseUrl, port);
    console.log('PASS app started on 0.0.0.0');
    const health = await request(app.base, '/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.json.storage, 'postgres');
    assert.equal(health.json.durable, true);
    assert.equal(health.json.database.connected, true);
    console.log('PASS GET /api/health -> 200; storage=postgres, durable=true, database.connected=true');
    assert.equal((await fetch(app.base)).status, 200);
    const reports = await request(app.base, '/content/reports/index.json');
    assert.equal(reports.status, 200);
    assert.ok(reports.json.length);
    const report = reports.json[0];
    assert.equal((await request(app.base, `/content/reports/${report.file || report.id + '.json'}`)).status, 200);
    assert.equal((await request(app.base, '/content/products.json')).status, 200);
    assert.equal((await request(app.base, '/content/ads.json')).status, 200);
    console.log('PASS report index, report detail, products and ads read from PostgreSQL');
    const visitor = await request(app.base, '/api/moments', { method: 'POST', body: uploadBody('End-to-end durable review'), device: 'e2e-visitor-one' });
    assert.equal(visitor.status, 201, visitor.text);
    const id = visitor.json.moment.id;
    assert.equal((await request(app.base, `/api/admin/pending/${id}/image`)).status, 401);
    assert.equal((await fetch(`${app.base}/assets/gallery/moments/${id}.png`)).status, 404);
    console.log('PASS upload -> 201; pending image private (401 admin API / 404 public path)');
    const login = await request(app.base, '/api/admin/login', { method: 'POST', body: fixture.admin });
    assert.equal(login.status, 200);
    const adminCookie = login.cookie;
    console.log('PASS database-backed admin login -> 200');

    await app.stop();
    app = null;
    await fixture.pool.end();
    await fixture.cluster.stop();
    await fixture.cluster.start();
    app = await startApp(fixture.databaseUrl, port);
    const pending = await request(app.base, '/api/admin/pending', { cookie: adminCookie });
    assert.equal(pending.status, 200, pending.text);
    assert.ok(pending.json.pending.some((item) => item.id === id));
    const preview = await fetch(`${app.base}/api/admin/pending/${id}/image`, { headers: { Cookie: adminCookie } });
    assert.equal(preview.status, 200);
    assert.deepEqual(Buffer.from(await preview.arrayBuffer()), PNG);
    const cooldown = await request(app.base, '/api/moments/status', { cookie: visitor.cookie, device: 'e2e-visitor-one' });
    assert.equal(cooldown.json.canUpload, false);
    console.log('PASS app process AND PostgreSQL restarted: pending bytes, admin session and cooldown survived');

    const approval = await request(app.base, `/api/admin/pending/${id}/approve`, { method: 'POST', cookie: adminCookie });
    assert.equal(approval.status, 200, approval.text);
    const gallery = await request(app.base, '/api/gallery');
    assert.equal(gallery.json.gallery[0].id, id);
    assert.equal(gallery.json.source, 'postgres');
    const published = await fetch(`${app.base}/${gallery.json.gallery[0].image}`);
    assert.equal(published.status, 200);
    assert.deepEqual(Buffer.from(await published.arrayBuffer()), PNG);
    console.log('PASS Approve -> 200; image is gallery[0] immediately; public image bytes match upload');

    await app.stop();
    app = await startApp(fixture.databaseUrl, port);
    assert.equal((await request(app.base, '/api/gallery')).json.gallery[0].id, id);
    console.log('PASS approved photo survives another app process restart');
    const rejectionUpload = await request(app.base, '/api/moments', { method: 'POST', body: uploadBody('End-to-end rejection'), device: 'e2e-visitor-two' });
    assert.equal(rejectionUpload.status, 201);
    const rejectedId = rejectionUpload.json.moment.id;
    const rejection = await request(app.base, `/api/admin/pending/${rejectedId}/reject`, { method: 'POST', cookie: adminCookie });
    assert.equal(rejection.status, 200);
    assert.equal((await request(app.base, `/api/admin/pending/${rejectedId}/image`, { cookie: adminCookie })).status, 404);
    assert.equal((await fetch(`${app.base}/assets/gallery/moments/${rejectedId}.png`)).status, 404);
    assert.ok(!(await request(app.base, '/api/gallery')).json.gallery.some((item) => item.id === rejectedId));
    console.log('PASS Reject -> 200; pending and public image -> 404; gallery unchanged');
    console.log('E2E PASS');
  } finally {
    if (app) await app.stop();
    await fixture.close();
  }
}

main().catch((error) => { console.error('E2E FAILED:', error.message); process.exitCode = 1; });
