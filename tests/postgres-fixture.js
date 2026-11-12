'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { createPostgresPool } = require('../lib/postgres');
const { loadConfig } = require('../lib/config');
const { migrate } = require('../lib/postgres-migrations');
const { importDatabase } = require('../tools/import-db');
const { sha256 } = require('../lib/util');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z3X0AAAAASUVORK5CYII=', 'base64');
const image = `data:image/png;base64,${PNG.toString('base64')}`;

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function postgresFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'labroute-postgres-'));
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const port = await freePort();
  const password = crypto.randomBytes(24).toString('hex');
  const logs = [];
  const cluster = new EmbeddedPostgres({ databaseDir: path.join(root, 'db'),
    port, user: 'labroute_test', password, authMethod: 'scram-sha-256', persistent: true,
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    postgresFlags: ['-c', 'listen_addresses=127.0.0.1', '-c', `unix_socket_directories=${root}`],
    onLog: (message) => logs.push(String(message)), onError: (message) => logs.push(String(message)) });
  try {
    await cluster.initialise();
    await cluster.start();
    const databaseUrl = `postgresql://labroute_test:${password}@127.0.0.1:${port}/postgres?sslmode=disable`;
    const pool = createPostgresPool(databaseUrl);
    const admin = { email: 'e2e@labroute.invalid', password: crypto.randomBytes(24).toString('hex') };
    const dataDir = path.join(root, 'legacy-data');
    await fs.mkdir(dataDir, { recursive: true });
    const adminsFile = path.join(dataDir, 'admins.json');
    await fs.writeFile(adminsFile, JSON.stringify({ admins: [{ email: admin.email, passwordCrypt: sha256(admin.password) }] }));
    const config = loadConfig({ rootDir: path.join(__dirname, '..'), databaseUrl,
      storage: 'postgres', serverless: false, dataDir, adminsFile,
      email: { provider: 'none' } });
    const applied = await migrate(pool);
    const imported = await importDatabase({ pool, config });
    return { root, cluster, databaseUrl, pool, config, admin, applied, imported,
      overrides: { rootDir: config.rootDir, databaseUrl, storage: 'postgres',
        serverless: true, email: { provider: 'none' }, trustProxy: true,
        dataDir: path.join(root, 'unused-instance-data'),
        runtimeDir: path.join(root, 'unused-runtime'),
        pendingDir: path.join(root, 'unused-pending'), uploadDir: path.join(root, 'unused-uploads') },
      async close() { if (!pool.ended) await pool.end(); await cluster.stop(); await fs.rm(root, { recursive: true, force: true }); }
    };
  } catch (error) {
    await cluster.stop().catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
    // No credentials are included in postgres init logs; only show on failure.
    throw new Error(`Local PostgreSQL fixture failed: ${error.message}\n${logs.slice(-15).join('\n')}`);
  }
}

async function listen(app) {
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${app.server.address().port}`;
}

async function closeApp(app) {
  await new Promise((resolve) => app.server.close(resolve));
  if (app.ctx.database) await app.ctx.database.close();
}

async function request(base, pathname, { method = 'GET', body, cookie, device, ip, headers = {} } = {}) {
  const response = await fetch(`${base}${pathname}`, { method, headers: {
    Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}),
    ...(cookie ? { Cookie: cookie } : {}), ...(device ? { 'X-Labroute-Device': device } : {}),
    ...(ip ? { 'X-Forwarded-For': ip } : {}), ...headers
  }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  const cookies = response.headers.getSetCookie();
  return { status: response.status, json, response, text,
    cookie: cookies.map((value) => value.split(';')[0]).join('; ') || cookie || '' };
}

const uploadBody = (caption = 'PostgreSQL persistence test') => ({ image, caption, contributor: 'Integration test', consent: true });
module.exports = { postgresFixture, freePort, listen, closeApp, request, uploadBody, PNG };
