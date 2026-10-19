'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { createApp } = require('../server');
const { loadConfig, SERVERLESS_MAX_UPLOAD_BYTES } = require('../lib/config');
const { createVercelHandler } = require('../lib/vercel-handler');
const { createBlobStorage, createMemoryBlobStorage } = require('../lib/blob-storage');
const { isSafeImagePath } = require('../lib/gallery-store');
const { PendingStore } = require('../lib/pending-store');
const { sha256 } = require('../lib/util');

const ONE_PIXEL_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z3X0AAAAASUVORK5CYII=';
const imgDataUrl = () => `data:image/png;base64,${ONE_PIXEL_PNG}`;

function setCookies(response) {
  if (typeof response.headers.getSetCookie === 'function') {
    return response.headers.getSetCookie();
  }
  const raw = response.headers.get('set-cookie');
  return raw ? [raw] : [];
}

function mergeCookieJar(jar, response) {
  const next = { ...jar };
  for (const cookie of setCookies(response)) {
    const pair = cookie.split(';')[0];
    const separator = pair.indexOf('=');
    if (separator <= 0) continue;
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (!value || /Max-Age=0/i.test(cookie)) delete next[name];
    else next[name] = value;
  }
  return next;
}

function cookieHeader(jar) {
  return Object.entries(jar)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

async function jsonRequest(baseUrl, pathname, options = {}, jar = {}) {
  const headers = {
    Accept: 'application/json',
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...(Object.keys(jar).length ? { Cookie: cookieHeader(jar) } : {}),
    ...(options.headers || {})
  };

  const response = await fetch(`${baseUrl}${pathname}`, { ...options, headers });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  return { response, status: response.status, json, text, jar: mergeCookieJar(jar, response) };
}

async function makeFixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'labroute-vercel-test-'));
  const contentDir = path.join(root, 'content');
  const dataDir = path.join(root, 'data');

  await fsp.mkdir(contentDir, { recursive: true });
  await fsp.mkdir(dataDir, { recursive: true });
  await fsp.writeFile(
    path.join(contentDir, 'gallery.json'),
    JSON.stringify(
      [
        { id: 'gal-old-1', image: 'assets/gallery/old-one.jpeg', caption: 'Original first', tall: true },
        { id: 'gal-old-2', image: 'assets/gallery/old-two.jpeg', caption: 'Original second', tall: true }
      ],
      null,
      2
    )
  );
  await fsp.writeFile(
    path.join(dataDir, 'admins.json'),
    JSON.stringify({
      admins: [{ email: 'admin@example.com', passwordCrypt: sha256('correct-horse') }]
    })
  );

  const overrides = {
    rootDir: root,
    contentDir,
    dataDir,
    runtimeDir: path.join(dataDir, 'runtime'),
    uploadDir: path.join(root, 'uploads'),
    pendingDir: path.join(dataDir, 'pending'),
    galleryFile: path.join(contentDir, 'gallery.json'),
    adminsFile: path.join(dataDir, 'admins.json'),
    secret: 'test-secret-that-is-long-enough-for-hmac',
    email: { provider: 'none' },
    trustProxy: false,
    cooldownMinutes: 30,
    maxUploadBytes: 100 * 1024
  };

  return { root, contentDir, dataDir, overrides };
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

test('serverless config avoids the read-only deployment filesystem', async () => {
  const saved = {
    blobToken: process.env.BLOB_READ_WRITE_TOKEN,
    blobStore: process.env.BLOB_STORE_ID,
    oidc: process.env.VERCEL_OIDC_TOKEN,
    momentsStorage: process.env.MOMENTS_STORAGE,
    momentsSecret: process.env.MOMENTS_SECRET
  };
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_STORE_ID;
  delete process.env.VERCEL_OIDC_TOKEN;
  delete process.env.MOMENTS_STORAGE;
  delete process.env.MOMENTS_SECRET;

  const runtimeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'labroute-runtime-'));

  try {
    const config = loadConfig({
      rootDir: '/srv/labroute',
      serverless: true,
      runtimeDir,
      maxUploadBytes: 8 * 1024 * 1024
    });

    assert.equal(config.isServerless, true);
    assert.equal(config.storageMode, 'ephemeral');
    assert.ok(config.uploadDir.startsWith(os.tmpdir()), config.uploadDir);
    assert.ok(config.pendingDir.startsWith(os.tmpdir()), config.pendingDir);
    assert.equal(config.gallerySeedFile, path.join('/srv/labroute', 'content', 'gallery.json'));
    assert.notEqual(config.galleryFile, config.gallerySeedFile);
    assert.equal(config.maxUploadBytes, SERVERLESS_MAX_UPLOAD_BYTES);
    assert.equal(config.secretIsEphemeral, true);
    assert.equal(config.secretConfigured, false);

    const withSecret = loadConfig({
      rootDir: '/srv/labroute',
      serverless: true,
      runtimeDir,
      secret: 'a-configured-secret-that-is-long-enough-1234'
    });
    assert.equal(withSecret.secretIsEphemeral, false);
    assert.equal(withSecret.secretConfigured, true);
  } finally {
    await fsp.rm(runtimeDir, { recursive: true, force: true });
    if (saved.blobToken !== undefined) process.env.BLOB_READ_WRITE_TOKEN = saved.blobToken;
    if (saved.blobStore !== undefined) process.env.BLOB_STORE_ID = saved.blobStore;
    if (saved.oidc !== undefined) process.env.VERCEL_OIDC_TOKEN = saved.oidc;
    if (saved.momentsStorage !== undefined) process.env.MOMENTS_STORAGE = saved.momentsStorage;
    if (saved.momentsSecret !== undefined) process.env.MOMENTS_SECRET = saved.momentsSecret;
  }
});

test('the Vercel handler serves the moments API (the reported 404)', async () => {
  const { root, overrides } = await makeFixture();
  const handler = createVercelHandler(overrides);
  assert.equal(handler.config.api.bodyParser, false);

  const server = http.createServer(handler);
  const baseUrl = await listen(server);

  try {
    const status = await jsonRequest(
      baseUrl,
      '/api/moments/status',
      { headers: { 'X-Labroute-Device': 'device-vercel-12345' } },
      {}
    );
    assert.equal(status.status, 200);
    assert.equal(status.json.ok, true);
    assert.equal(status.json.canUpload, true);

    const upload = await jsonRequest(
      baseUrl,
      '/api/moments',
      {
        method: 'POST',
        headers: { 'X-Labroute-Device': 'device-vercel-12345' },
        body: JSON.stringify({
          image: imgDataUrl(),
          caption: 'Uploaded through the Vercel handler',
          contributor: 'Ada',
          consent: true,
          website: ''
        })
      },
      status.jar
    );
    assert.equal(upload.status, 201);
    assert.equal(upload.json.pending, true);
    assert.equal(upload.json.pendingCount, 1);
  } finally {
    await close(server);
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('a body pre-parsed by the platform is accepted', async () => {
  const { root, overrides } = await makeFixture();
  const handler = createVercelHandler(overrides);

  try {
    const result = await new Promise((resolve, reject) => {
      const req = new EventEmitter();
      req.method = 'POST';
      req.url = '/api/admin/login';
      req.headers = { 'content-type': 'application/json', host: 'labroute.vercel.app' };
      req.socket = { remoteAddress: '127.0.0.1' };
      // Vercel Node helpers may hand us the parsed object instead of a stream.
      req.body = { email: 'admin@example.com', password: 'correct-horse' };

      const timer = setTimeout(() => reject(new Error('handler never responded')), 5000);
      const res = new EventEmitter();
      res.headersSent = false;
      res.setHeader = () => {};
      res.writeHead = (status) => {
        res.statusCode = status;
        res.headersSent = true;
      };
      res.end = (body) => {
        clearTimeout(timer);
        resolve({ status: res.statusCode, json: JSON.parse(body.toString('utf8')) });
      };

      handler(req, res);
    });

    assert.equal(result.status, 200);
    assert.equal(result.json.email, 'admin@example.com');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('a throwing platform body parser becomes a clean 400, not a 500', async () => {
  const { root, overrides } = await makeFixture();
  const handler = createVercelHandler(overrides);

  try {
    const result = await new Promise((resolve, reject) => {
      const req = new EventEmitter();
      req.method = 'POST';
      req.url = '/api/admin/login';
      req.headers = { 'content-type': 'application/json', host: 'labroute.vercel.app' };
      req.socket = { remoteAddress: '127.0.0.1' };
      // Vercel's Node helpers expose req.body as a lazy getter that throws
      // its own ApiError when the payload is not valid JSON.
      Object.defineProperty(req, 'body', {
        get() {
          throw new Error('Invalid JSON');
        }
      });

      const timer = setTimeout(() => reject(new Error('handler never responded')), 5000);
      const res = new EventEmitter();
      res.headersSent = false;
      res.setHeader = () => {};
      res.writeHead = (status) => {
        res.statusCode = status;
        res.headersSent = true;
      };
      res.end = (body) => {
        clearTimeout(timer);
        resolve({ status: res.statusCode, json: JSON.parse(body.toString('utf8')) });
      };

      handler(req, res);
    });

    assert.equal(result.status, 400);
    assert.equal(result.json.error, 'invalid_json');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('the Blob SDK wrapper recovers when the store access level differs', async () => {
  const { Readable } = require('node:stream');
  const stored = new Map();
  const fakeSdk = {
    async put(pathname, buffer, options) {
      if (options.access !== 'public') throw new Error('access does not match this store');
      stored.set(pathname, Buffer.from(buffer));
      return { url: `https://fake.public.blob.vercel-storage.com/${pathname}`, pathname };
    },
    async get(pathname, options) {
      if (options.access !== 'public' || !stored.has(pathname)) return null;
      return { statusCode: 200, stream: Readable.from([stored.get(pathname)]) };
    },
    async del(pathname) {
      stored.delete(pathname);
    }
  };

  // Deliberately configured with the wrong (default private) access level.
  const blob = createBlobStorage({ sdk: fakeSdk, access: 'private' });
  assert.ok(blob);

  await blob.putJson('labroute/state/test.json', { hello: 'world' });
  assert.equal(blob.access, 'public');
  assert.deepEqual(await blob.getJson('labroute/state/test.json'), { hello: 'world' });
  assert.equal(await blob.getJson('labroute/state/missing.json'), null);
});

test('public Blob stores produce direct gallery image URLs', async () => {
  const blob = createMemoryBlobStorage({ access: 'public' });
  const store = new PendingStore(
    { pendingDir: '/tmp/unused', pendingFile: '/tmp/unused/pending.json', uploadDir: '/tmp/unused' },
    blob
  );
  const entry = { id: 'moment-test-1', ext: 'png', mime: 'image/png' };

  await store.writeImage(entry, Buffer.from('fake-png-bytes'));
  const moved = await store.moveToUploadDir(entry, '/tmp/unused');

  assert.match(moved.image, /^https:\/\/memory-store\.public\.blob\.vercel-storage\.com\//);
  assert.equal(isSafeImagePath(moved.image), true);
  assert.equal(await store.readImage(entry), null);
  assert.ok(await store.readUploadedImage('moment-test-1.png'));
});

test('Blob-backed uploads survive across app instances (cold starts)', async () => {
  const { root, contentDir, overrides } = await makeFixture();
  const blobStorage = createMemoryBlobStorage({ access: 'private' });
  const blobOverrides = { ...overrides, serverless: true, blobStorage };

  let momentId = '';
  let visitorJar = {};

  // Instance 1: a visitor uploads a photo.
  const appOne = createApp(blobOverrides);
  assert.equal(appOne.config.storageMode, 'vercel-blob');
  const baseOne = await listen(appOne.server);
  try {
    const upload = await jsonRequest(
      baseOne,
      '/api/moments',
      {
        method: 'POST',
        headers: { 'X-Labroute-Device': 'device-blob-12345' },
        body: JSON.stringify({
          image: imgDataUrl(),
          caption: 'A moment that outlives its instance',
          contributor: 'Bola',
          consent: true
        })
      },
      {}
    );
    assert.equal(upload.status, 201);
    momentId = upload.json.moment.id;
    visitorJar = upload.jar;

    // State is in Blob, not on the instance's disk.
    assert.ok(blobStorage.blobs.has('labroute/state/pending.json'));
    assert.ok(blobStorage.blobs.has(`labroute/pending/${momentId}.png`));
    const diskGallery = JSON.parse(await fsp.readFile(path.join(contentDir, 'gallery.json'), 'utf8'));
    assert.equal(diskGallery.length, 2);
  } finally {
    await close(appOne.server);
  }

  // Instance 2 (a "cold start"): an admin reviews and approves the photo.
  const appTwo = createApp(blobOverrides);
  const baseTwo = await listen(appTwo.server);
  try {
    const health = await jsonRequest(baseTwo, '/api/health');
    assert.equal(health.json.storage, 'vercel-blob');
    assert.equal(health.json.secretConfigured, true);

    const login = await jsonRequest(baseTwo, '/api/admin/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'admin@example.com', password: 'correct-horse' })
    });
    assert.equal(login.status, 200);

    const pending = await jsonRequest(baseTwo, '/api/admin/pending', {}, login.jar);
    assert.equal(pending.status, 200);
    assert.equal(pending.json.count, 1);
    assert.equal(pending.json.pending[0].caption, 'A moment that outlives its instance');

    const preview = await fetch(`${baseTwo}/api/admin/pending/${momentId}/image`, {
      headers: { Cookie: cookieHeader(login.jar) }
    });
    assert.equal(preview.status, 200);
    assert.ok((await preview.arrayBuffer()).byteLength > 0);

    const approve = await jsonRequest(
      baseTwo,
      `/api/admin/pending/${momentId}/approve`,
      { method: 'POST' },
      login.jar
    );
    assert.equal(approve.status, 200);
    assert.equal(approve.json.gallery[0].id, momentId);
    // Private store: the gallery keeps the site-relative path and the
    // Function streams the bytes.
    assert.equal(approve.json.moment.image, `assets/gallery/moments/${momentId}.png`);

    const photo = await fetch(`${baseTwo}/assets/gallery/moments/${momentId}.png`);
    assert.equal(photo.status, 200);
    assert.equal(photo.headers.get('content-type'), 'image/png');
    assert.ok((await photo.arrayBuffer()).byteLength > 0);
  } finally {
    await close(appTwo.server);
  }

  // Instance 3: the gallery order and the visitor cooldown both persisted.
  const appThree = createApp(blobOverrides);
  const baseThree = await listen(appThree.server);
  try {
    const gallery = await jsonRequest(baseThree, '/api/gallery');
    assert.equal(gallery.json.gallery.length, 3);
    assert.equal(gallery.json.gallery[0].id, momentId);
    assert.equal(gallery.json.gallery[1].id, 'gal-old-1');

    const status = await jsonRequest(
      baseThree,
      '/api/moments/status',
      { headers: { 'X-Labroute-Device': 'device-blob-12345' } },
      visitorJar
    );
    assert.equal(status.status, 200);
    assert.equal(status.json.canUpload, false);
    assert.ok(status.json.retryAfterSeconds > 0);
  } finally {
    await close(appThree.server);
    await fsp.rm(root, { recursive: true, force: true });
  }
});
