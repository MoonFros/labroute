'use strict';

const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { createApp } = require('../server');
const { STATE_PATHS, createMemoryBlobStorage } = require('../lib/blob-storage');
const { storageStatus } = require('../lib/config');
const { GalleryStore } = require('../lib/gallery-store');
const { sha256 } = require('../lib/util');

const ONE_PIXEL_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z3X0AAAAASUVORK5CYII=';

const imgDataUrl = (base64 = ONE_PIXEL_PNG, mime = 'image/png') =>
  `data:${mime};base64,${base64}`;

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

    if (!value || /Max-Age=0/i.test(cookie)) {
      delete next[name];
    } else {
      next[name] = value;
    }
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

  return {
    response,
    status: response.status,
    json,
    text,
    jar: mergeCookieJar(jar, response)
  };
}

test('LabRoute moments review API', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'labroute-test-'));
  const contentDir = path.join(root, 'content');
  const dataDir = path.join(root, 'data');
  const uploadDir = path.join(root, 'uploads');
  const pendingDir = path.join(dataDir, 'pending');

  await fsp.mkdir(contentDir, { recursive: true });
  await fsp.mkdir(dataDir, { recursive: true });

  const originalGallery = [
    {
      id: 'gal-old-1',
      image: 'assets/gallery/old-one.jpeg',
      caption: 'Original first image',
      tall: true
    },
    {
      id: 'gal-old-2',
      image: 'assets/gallery/old-two.jpeg',
      caption: 'Original second image',
      tall: true
    },
    {
      id: 'gal-old-3',
      image: 'assets/gallery/old-three.jpeg',
      caption: 'Original third image',
      tall: true
    }
  ];

  await fsp.writeFile(
    path.join(contentDir, 'gallery.json'),
    JSON.stringify(originalGallery, null, 2)
  );
  await fsp.writeFile(
    path.join(dataDir, 'admins.json'),
    JSON.stringify(
      {
        admins: [
          {
            email: 'admin@example.com',
            passwordCrypt: sha256('correct-horse')
          }
        ]
      },
      null,
      2
    )
  );

  const app = createApp({
    rootDir: root,
    contentDir,
    dataDir,
    runtimeDir: path.join(dataDir, 'runtime'),
    uploadDir,
    pendingDir,
    galleryFile: path.join(contentDir, 'gallery.json'),
    adminsFile: path.join(dataDir, 'admins.json'),
    secret: 'test-secret-that-is-long-enough-for-hmac',
    // Pin disk storage so the run never depends on Blob credentials in the
    // environment (this suite asserts the durable, local mode).
    storage: 'local',
    email: { provider: 'none' },
    trustProxy: false,
    cooldownMinutes: 30,
    maxUploadBytes: 100 * 1024
  });

  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${app.server.address().port}`;

  try {
    await t.test('health and public gallery are available', async () => {
      const health = await jsonRequest(baseUrl, '/api/health');
      assert.equal(health.status, 200);
      assert.equal(health.json.ok, true);
      assert.equal(health.json.cooldownMinutes, 30);
      assert.equal(health.json.emailProvider, 'none');
      assert.equal(health.json.storage, 'local');
      // A real disk is durable: no warning should be shown to the admin.
      assert.equal(health.json.durable, true);
      assert.equal(health.json.warning, null);
      assert.equal(typeof health.json.blob.sdkAvailable, 'boolean');

      const gallery = await jsonRequest(baseUrl, '/api/gallery');
      assert.equal(gallery.status, 200);
      assert.equal(gallery.json.gallery.length, 3);
      assert.equal(gallery.json.source, 'storage');
      assert.equal(gallery.json.gallery[0].id, 'gal-old-1');
      assert.equal(gallery.json.gallery[0].uploaded, false);
    });

    let visitorOne = {};
    let firstMomentId = '';

    await t.test('an upload is stored as pending, not published', async () => {
      const status = await jsonRequest(
        baseUrl,
        '/api/moments/status',
        { headers: { 'X-Labroute-Device': 'device-one-12345' } },
        visitorOne
      );
      assert.equal(status.status, 200);
      assert.equal(status.json.canUpload, true);
      visitorOne = status.jar;
      assert.ok(visitorOne.labroute_visitor);

      const upload = await jsonRequest(
        baseUrl,
        '/api/moments',
        {
          method: 'POST',
          headers: { 'X-Labroute-Device': 'device-one-12345' },
          body: JSON.stringify({
            image: imgDataUrl(),
            caption: 'A new moment at the electronics bench',
            contributor: 'Ada',
            consent: true,
            website: ''
          })
        },
        visitorOne
      );

      assert.equal(upload.status, 201);
      assert.equal(upload.json.ok, true);
      assert.equal(upload.json.pending, true);
      assert.equal(upload.json.pendingCount, 1);
      assert.equal(upload.json.canUpload, false);
      assert.ok(upload.json.retryAfterSeconds >= 1700);
      assert.match(upload.json.message, /review/i);
      visitorOne = upload.jar;

      firstMomentId = upload.json.moment.id;
      assert.equal(upload.json.moment.image, `/api/admin/pending/${firstMomentId}/image`);

      // The public gallery must be untouched until approval.
      const gallery = await jsonRequest(baseUrl, '/api/gallery');
      assert.equal(gallery.json.gallery.length, 3);
      assert.equal(gallery.json.gallery[0].id, 'gal-old-1');

      const diskGallery = JSON.parse(
        await fsp.readFile(path.join(contentDir, 'gallery.json'), 'utf8')
      );
      assert.equal(diskGallery.length, 3);

      // The photo lives in the private pending folder.
      const pendingFiles = await fsp.readdir(pendingDir);
      assert.ok(pendingFiles.includes(`${firstMomentId}.png`));
      assert.ok(pendingFiles.includes('pending.json'));

      const manifest = JSON.parse(
        await fsp.readFile(path.join(pendingDir, 'pending.json'), 'utf8')
      );
      assert.equal(manifest.length, 1);
      assert.equal(manifest[0].caption, 'A new moment at the electronics bench');
    });

    await t.test('pending files are not reachable over the static server', async () => {
      const manifest = await fetch(`${baseUrl}/data/pending/pending.json`);
      assert.equal(manifest.status, 404);

      const image = await fetch(`${baseUrl}/data/pending/${firstMomentId}.png`);
      assert.equal(image.status, 404);
    });

    await t.test('the same visitor is held to a 30 minute cooldown', async () => {
      const upload = await jsonRequest(
        baseUrl,
        '/api/moments',
        {
          method: 'POST',
          headers: { 'X-Labroute-Device': 'device-one-12345' },
          body: JSON.stringify({
            image: imgDataUrl(),
            caption: 'Trying again too soon',
            consent: true
          })
        },
        visitorOne
      );

      assert.equal(upload.status, 429);
      assert.equal(upload.json.error, 'cooldown_active');
      assert.ok(upload.json.retryAfterSeconds > 0);
      assert.ok(Number(upload.response.headers.get('retry-after')) > 0);
    });

    await t.test('clearing the visitor cookie does not reset the device cooldown', async () => {
      const upload = await jsonRequest(
        baseUrl,
        '/api/moments',
        {
          method: 'POST',
          headers: { 'X-Labroute-Device': 'device-one-12345' },
          body: JSON.stringify({
            image: imgDataUrl(),
            caption: 'A new cookie will not help',
            consent: true
          })
        },
        {}
      );

      assert.equal(upload.status, 429);
      assert.equal(upload.json.error, 'cooldown_active');
    });

    let visitorTwo = {};
    let secondMomentId = '';

    await t.test('another visitor is not affected by the first cooldown', async () => {
      const upload = await jsonRequest(
        baseUrl,
        '/api/moments',
        {
          method: 'POST',
          headers: { 'X-Labroute-Device': 'device-two-67890' },
          body: JSON.stringify({
            image: imgDataUrl(),
            caption: 'A different student at the workshop',
            contributor: 'Bola',
            consent: true
          })
        },
        visitorTwo
      );

      assert.equal(upload.status, 201);
      assert.equal(upload.json.pendingCount, 2);
      assert.notEqual(upload.json.moment.id, firstMomentId);
      secondMomentId = upload.json.moment.id;
      visitorTwo = upload.jar;
      assert.ok(visitorTwo.labroute_visitor);
    });

    await t.test('invalid contributions are rejected', async () => {
      const noConsent = await jsonRequest(
        baseUrl,
        '/api/moments',
        {
          method: 'POST',
          body: JSON.stringify({
            image: imgDataUrl(),
            caption: 'No consent given'
          })
        },
        {}
      );
      assert.equal(noConsent.status, 400);
      assert.equal(noConsent.json.error, 'consent_required');

      const shortCaption = await jsonRequest(
        baseUrl,
        '/api/moments',
        {
          method: 'POST',
          body: JSON.stringify({
            image: imgDataUrl(),
            caption: 'x',
            consent: true
          })
        },
        {}
      );
      assert.equal(shortCaption.status, 400);
      assert.equal(shortCaption.json.error, 'caption_required');

      const fakeImage = await jsonRequest(
        baseUrl,
        '/api/moments',
        {
          method: 'POST',
          body: JSON.stringify({
            image: imgDataUrl(Buffer.from('not really an image').toString('base64')),
            caption: 'A fake photo',
            consent: true
          })
        },
        {}
      );
      assert.equal(fakeImage.status, 415);

      const tooLarge = Buffer.alloc(200 * 1024, 1).toString('base64');
      const hugeImage = await jsonRequest(
        baseUrl,
        '/api/moments',
        {
          method: 'POST',
          body: JSON.stringify({
            image: imgDataUrl(tooLarge),
            caption: 'A huge photo',
            consent: true
          })
        },
        {}
      );
      assert.equal(hugeImage.status, 413);
    });

    let adminJar = {};

    await t.test('admins can list and preview pending photos', async () => {
      const unauthorised = await jsonRequest(baseUrl, '/api/admin/pending');
      assert.equal(unauthorised.status, 401);

      const imageUnauthorised = await fetch(
        `${baseUrl}/api/admin/pending/${firstMomentId}/image`
      );
      assert.equal(imageUnauthorised.status, 401);

      const wrong = await jsonRequest(baseUrl, '/api/admin/login', {
        method: 'POST',
        body: JSON.stringify({ email: 'admin@example.com', password: 'nope' })
      });
      assert.equal(wrong.status, 401);

      const login = await jsonRequest(baseUrl, '/api/admin/login', {
        method: 'POST',
        body: JSON.stringify({ email: 'admin@example.com', password: 'correct-horse' })
      });
      assert.equal(login.status, 200);
      assert.equal(login.json.email, 'admin@example.com');
      adminJar = login.jar;
      assert.ok(adminJar.labroute_admin);

      const session = await jsonRequest(baseUrl, '/api/admin/session', {}, adminJar);
      assert.equal(session.json.authenticated, true);

      const pending = await jsonRequest(baseUrl, '/api/admin/pending', {}, adminJar);
      assert.equal(pending.status, 200);
      assert.equal(pending.json.count, 2);
      assert.equal(pending.json.liveCount, 3);
      assert.equal(pending.json.pending.length, 2);
      assert.equal(pending.json.pending[0].caption, 'A different student at the workshop');
      assert.equal(pending.json.pending[1].caption, 'A new moment at the electronics bench');
      assert.equal(pending.json.pending[0].image, `/api/admin/pending/${secondMomentId}/image`);
      // The dashboard needs to know whether approving will actually persist.
      assert.equal(pending.json.storage.mode, 'local');
      assert.equal(pending.json.storage.durable, true);

      const image = await fetch(`${baseUrl}/api/admin/pending/${firstMomentId}/image`, {
        headers: { Cookie: cookieHeader(adminJar) }
      });
      assert.equal(image.status, 200);
      assert.equal(image.headers.get('content-type'), 'image/png');
      assert.equal((await image.arrayBuffer()).byteLength > 0, true);
    });

    await t.test('an admin can download the photo and its JSON record', async () => {
      const download = await fetch(
        `${baseUrl}/api/admin/pending/${firstMomentId}/download`,
        { headers: { Cookie: cookieHeader(adminJar) } }
      );

      assert.equal(download.status, 200);
      assert.equal(download.headers.get('content-type'), 'image/png');
      assert.match(
        download.headers.get('content-disposition') || '',
        new RegExp(`attachment; filename=\"${firstMomentId}\\.png\"`)
      );
      assert.ok((await download.arrayBuffer()).byteLength > 0);

      const metadata = await fetch(
        `${baseUrl}/api/admin/pending/${firstMomentId}/metadata`,
        { headers: { Cookie: cookieHeader(adminJar) } }
      );

      assert.equal(metadata.status, 200);
      assert.match(metadata.headers.get('content-disposition') || '', /attachment; filename=/);

      const record = JSON.parse(await metadata.text());
      assert.equal(record.id, firstMomentId);
      // The record is exactly what belongs in content/gallery.json, so the
      // downloaded file can be committed without editing.
      assert.equal(record.image, `assets/gallery/moments/${firstMomentId}.png`);
      assert.equal(record.caption, 'A new moment at the electronics bench');
      assert.equal(record.contributor, 'Ada');

      const anonymous = await fetch(`${baseUrl}/api/admin/pending/${firstMomentId}/download`);
      assert.equal(anonymous.status, 401);
    });

    await t.test('a committed photo can be cleared from the queue', async () => {
      const publish = await jsonRequest(
        baseUrl,
        `/api/admin/pending/${secondMomentId}/publish`,
        { method: 'POST' },
        adminJar
      );

      assert.equal(publish.status, 200);
      // Only this photo leaves the queue; the other one is still waiting.
      assert.equal(publish.json.pendingCount, 1);
      assert.equal(publish.json.item.image, `assets/gallery/moments/${secondMomentId}.png`);

      // Nothing was added to the live gallery: the repository is the source.
      const gallery = await jsonRequest(baseUrl, '/api/gallery');
      assert.equal(gallery.json.gallery.length, 3);

      const pendingFiles = await fsp.readdir(pendingDir);
      assert.equal(pendingFiles.includes(`${secondMomentId}.png`), false);

      const again = await jsonRequest(
        baseUrl,
        `/api/admin/pending/${secondMomentId}/publish`,
        { method: 'POST' },
        adminJar
      );
      assert.equal(again.status, 404);
    });

    await t.test('approving moves the photo into the gallery as image 1', async () => {
      const approve = await jsonRequest(
        baseUrl,
        `/api/admin/pending/${firstMomentId}/approve`,
        { method: 'POST' },
        adminJar
      );

      assert.equal(approve.status, 200);
      assert.equal(approve.json.pendingCount, 0);
      assert.equal(approve.json.galleryCount, 4);
      assert.equal(approve.json.gallery[0].id, firstMomentId);
      assert.equal(approve.json.gallery[1].id, 'gal-old-1');
      assert.equal(approve.json.gallery[2].id, 'gal-old-2');
      assert.equal(approve.json.gallery[3].id, 'gal-old-3');
      assert.equal(approve.json.moment.image, `assets/gallery/moments/${firstMomentId}.png`);
      assert.equal(approve.json.durable, true);
      assert.equal(approve.json.storage.durable, true);

      const diskGallery = JSON.parse(
        await fsp.readFile(path.join(contentDir, 'gallery.json'), 'utf8')
      );
      assert.equal(diskGallery.length, 4);
      assert.equal(diskGallery[0].id, firstMomentId);
      assert.equal(diskGallery[1].id, 'gal-old-1');

      // The photo is now served from the public gallery folder, not pending.
      const image = await fetch(`${baseUrl}/assets/gallery/moments/${firstMomentId}.png`);
      assert.equal(image.status, 200);
      assert.equal(image.headers.get('content-type'), 'image/png');

      const pendingFiles = await fsp.readdir(pendingDir);
      assert.equal(pendingFiles.includes(`${firstMomentId}.png`), false);
      assert.ok((await fsp.stat(path.join(uploadDir, `${firstMomentId}.png`))).isFile());

      const gallery = await jsonRequest(baseUrl, '/api/gallery');
      assert.equal(gallery.json.gallery.length, 4);
      assert.equal(gallery.json.gallery[0].caption, 'A new moment at the electronics bench');

      const recent = await jsonRequest(baseUrl, '/api/moments/recent?limit=10');
      assert.equal(recent.json.moments.length, 1);

      const repeated = await jsonRequest(
        baseUrl,
        `/api/admin/pending/${firstMomentId}/approve`,
        { method: 'POST' },
        adminJar
      );
      assert.equal(repeated.status, 404);
    });

    await t.test('declining removes a pending photo without touching the gallery', async () => {
      // A third photo exists only so this test has something to decline.
      const visitorThree = await jsonRequest(
        baseUrl,
        '/api/moments/status',
        { headers: { 'X-Labroute-Device': 'device-three-24680' } },
        {}
      );
      const upload = await jsonRequest(
        baseUrl,
        '/api/moments',
        {
          method: 'POST',
          headers: { 'X-Labroute-Device': 'device-three-24680' },
          body: JSON.stringify({
            image: imgDataUrl(),
            caption: 'A photo that will be declined',
            consent: true
          })
        },
        visitorThree.jar
      );
      assert.equal(upload.status, 201);
      const declinedId = upload.json.moment.id;

      const decline = await jsonRequest(
        baseUrl,
        `/api/admin/pending/${declinedId}/reject`,
        { method: 'POST' },
        adminJar
      );

      assert.equal(decline.status, 200);
      assert.equal(decline.json.pendingCount, 0);

      const pendingFiles = await fsp.readdir(pendingDir);
      assert.equal(pendingFiles.includes(`${declinedId}.png`), false);

      const gallery = await jsonRequest(baseUrl, '/api/gallery');
      assert.equal(gallery.json.gallery.length, 4);

      const pending = await jsonRequest(baseUrl, '/api/admin/pending', {}, adminJar);
      assert.equal(pending.json.count, 0);
      assert.equal(pending.json.liveCount, 4);
    });

    await t.test('logout ends the admin session', async () => {
      const logout = await jsonRequest(
        baseUrl,
        '/api/admin/logout',
        { method: 'POST' },
        adminJar
      );
      assert.equal(logout.status, 200);
      adminJar = logout.jar;

      const afterLogout = await jsonRequest(baseUrl, '/api/admin/pending', {}, adminJar);
      assert.equal(afterLogout.status, 401);
    });

    await t.test('static source files are not exposed', async () => {
      const serverFile = await fetch(`${baseUrl}/server.js`);
      assert.equal(serverFile.status, 404);

      const runtimeState = await fetch(`${baseUrl}/data/runtime/rate-limits.json`);
      assert.equal(runtimeState.status, 404);
    });
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('storageStatus flags temporary serverless storage as non-durable', () => {
  const ephemeral = storageStatus({ storageMode: 'ephemeral' });
  assert.equal(ephemeral.durable, false);
  assert.match(ephemeral.message, /temporary/i);
  assert.match(ephemeral.hint, /Blob/);

  for (const mode of ['vercel-blob', 'local']) {
    const status = storageStatus({ storageMode: mode });
    assert.equal(status.durable, true);
    assert.equal(status.message, null);
    assert.equal(status.hint, null);
  }

  // Defensive: an unknown/absent mode must not be advertised as durable.
  assert.equal(storageStatus({}).durable, true); // defaults to local
});

test('the temporary-storage hint names the exact missing piece', () => {
  const saved = {
    token: process.env.BLOB_READ_WRITE_TOKEN,
    store: process.env.BLOB_STORE_ID,
    oidc: process.env.VERCEL_OIDC_TOKEN
  };

  try {
    delete process.env.BLOB_READ_WRITE_TOKEN;
    delete process.env.BLOB_STORE_ID;
    delete process.env.VERCEL_OIDC_TOKEN;

    // Nothing connected at all.
    assert.match(storageStatus({ storageMode: 'ephemeral' }).hint, /No Blob store is attached/);

    // Store attached, but no credential the SDK can use — the exact state the
    // production deployment reported (hasStoreId true, no token, no OIDC).
    process.env.BLOB_STORE_ID = 'store_example';
    const attached = storageStatus({ storageMode: 'ephemeral' });
    assert.equal(attached.durable, false);
    assert.match(attached.hint, /BLOB_STORE_ID is set/);
    assert.match(attached.hint, /BLOB_READ_WRITE_TOKEN/);

    // A credential is present: stop blaming the store connection.
    process.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_example';
    const credentialed = storageStatus({ storageMode: 'ephemeral' });
    assert.doesNotMatch(credentialed.hint, /No Blob store is attached/);
    assert.match(credentialed.hint, /did not install|next deployment/);
  } finally {
    if (saved.token === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
    else process.env.BLOB_READ_WRITE_TOKEN = saved.token;
    if (saved.store === undefined) delete process.env.BLOB_STORE_ID;
    else process.env.BLOB_STORE_ID = saved.store;
    if (saved.oidc === undefined) delete process.env.VERCEL_OIDC_TOKEN;
    else process.env.VERCEL_OIDC_TOKEN = saved.oidc;
  }
});

test('a lost gallery write is reported as a failure, not a successful approval', async () => {
  // A Blob store whose reads never see what was written (the "photo shows up
  // now, gone later" failure mode). The store must throw instead of telling
  // the admin the photo is live.
  const writes = [];
  const lossyBlob = {
    async getJson() {
      return null;
    },
    async putJson(pathname) {
      writes.push(pathname);
    },
    async getBytes() {
      return null;
    },
    async putBytes(pathname) {
      return { url: `https://memory-store.private.blob.vercel-storage.com/${pathname}` };
    },
    async copyBytes() {
      return null;
    },
    async delete() {}
  };

  const store = new GalleryStore(
    {
      galleryFile: path.join(os.tmpdir(), 'labroute-missing-gallery.json'),
      gallerySeedFile: path.join(os.tmpdir(), 'labroute-missing-seed.json'),
      uploadDir: os.tmpdir()
    },
    lossyBlob
  );

  await assert.rejects(
    () =>
      store.add({
        id: 'moment-lost',
        image: 'assets/gallery/moments/moment-lost.png',
        caption: 'Should not be reported as saved'
      }),
    /read back|could not be saved/
  );

  assert.ok(writes.includes(STATE_PATHS.gallery));
});

test('a verified gallery write is visible to the next request', async () => {
  const blob = createMemoryBlobStorage({ access: 'private' });
  const store = new GalleryStore(
    {
      galleryFile: path.join(os.tmpdir(), 'labroute-memory-gallery.json'),
      gallerySeedFile: path.join(os.tmpdir(), 'labroute-memory-seed.json'),
      uploadDir: os.tmpdir()
    },
    blob
  );

  const item = {
    id: 'moment-kept',
    image: 'assets/gallery/moments/moment-kept.png',
    caption: 'Survives a new instance'
  };

  const next = await store.add(item);
  assert.equal(next[0].id, 'moment-kept');
  assert.equal(await blob.getJson(STATE_PATHS.gallery).then((rows) => rows[0].id), 'moment-kept');

  // A fresh GalleryStore (cold start) reads the same state back.
  const coldStart = new GalleryStore(
    {
      galleryFile: path.join(os.tmpdir(), 'unused.json'),
      gallerySeedFile: path.join(os.tmpdir(), 'unused-seed.json'),
      uploadDir: os.tmpdir()
    },
    blob
  );
  const gallery = await coldStart.publicGallery();
  assert.equal(gallery.length, 1);
  assert.equal(gallery[0].caption, 'Survives a new instance');
});

test('the gallery reports whether it came from storage or the committed seed', async () => {
  const blob = createMemoryBlobStorage({ access: 'private' });
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'labroute-source-'));
  const seedFile = path.join(dir, 'gallery.json');

  await fsp.writeFile(
    seedFile,
    JSON.stringify([{ id: 'gal-seed', image: 'assets/gallery/seed.jpeg', caption: 'Seed photo' }])
  );

  const store = new GalleryStore(
    { galleryFile: path.join(dir, 'unused.json'), gallerySeedFile: seedFile, uploadDir: dir },
    blob
  );

  // No manifest in storage yet: the committed seed is what visitors see.
  const before = await store.publicGalleryState();
  assert.equal(before.source, 'seed');
  assert.equal(before.gallery[0].id, 'gal-seed');

  await store.add({
    id: 'moment-live',
    image: 'assets/gallery/moments/moment-live.png',
    caption: 'Stored in Blob'
  });

  // After a successful approval the manifest exists in storage, so the site
  // must stop reporting (and stop serving) the seed.
  const after = await store.publicGalleryState();
  assert.equal(after.source, 'storage');
  assert.equal(after.gallery[0].id, 'moment-live');
  assert.equal(after.gallery[1].id, 'gal-seed');

  await fsp.rm(dir, { recursive: true, force: true });
});

test('publish-moment turns the dashboard downloads into a commit-ready change', async () => {
  const { publishMoment } = require('../tools/publish-moment');

  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'labroute-publish-'));
  const downloads = await fsp.mkdtemp(path.join(os.tmpdir(), 'labroute-downloads-'));

  await fsp.mkdir(path.join(root, 'content'), { recursive: true });
  await fsp.writeFile(
    path.join(root, 'content', 'gallery.json'),
    JSON.stringify([{ id: 'gal-1', image: 'assets/gallery/group1.jpeg', caption: 'Original' }])
  );

  const photo = path.join(downloads, 'moment-abc123.png');
  await fsp.writeFile(photo, Buffer.from(ONE_PIXEL_PNG, 'base64'));

  const metadataFile = path.join(downloads, 'moment-abc123.json');
  await fsp.writeFile(
    metadataFile,
    JSON.stringify({
      id: 'moment-abc123',
      image: 'assets/gallery/moments/moment-abc123.png',
      caption: 'Students at the electronics bench',
      contributor: 'Ada',
      uploadedAt: '2026-10-20T10:00:00.000Z',
      tall: true
    })
  );

  try {
    const result = await publishMoment({
      root,
      imagePath: photo,
      metadata: metadataFile
    });

    assert.equal(result.written, true);
    assert.equal(result.id, 'moment-abc123');
    assert.equal(result.galleryCount, 2);

    // The photo is now a real file the deployment can serve directly.
    const committed = await fsp.readFile(
      path.join(root, 'assets', 'gallery', 'moments', 'moment-abc123.png')
    );
    assert.equal(committed.length > 0, true);

    // It is first in the gallery, ahead of the originals.
    const gallery = JSON.parse(await fsp.readFile(path.join(root, 'content', 'gallery.json'), 'utf8'));
    assert.equal(gallery.length, 2);
    assert.equal(gallery[0].id, 'moment-abc123');
    assert.equal(gallery[0].image, 'assets/gallery/moments/moment-abc123.png');
    assert.equal(gallery[0].caption, 'Students at the electronics bench');
    assert.equal(gallery[0].uploadedAt, '2026-10-20T10:00:00.000Z');
    assert.equal(gallery[1].id, 'gal-1');

    // Running it twice must not duplicate the entry.
    await publishMoment({ root, imagePath: photo, metadata: metadataFile, force: true });
    const twice = JSON.parse(await fsp.readFile(path.join(root, 'content', 'gallery.json'), 'utf8'));
    assert.equal(twice.length, 2);

    // Without --force an existing file is protected.
    await assert.rejects(
      () => publishMoment({ root, imagePath: photo, metadata: metadataFile }),
      /already exists/
    );

    // A caption is mandatory when no metadata file is supplied.
    await assert.rejects(
      () => publishMoment({ root, imagePath: photo, id: 'moment-nocaption' }),
      /caption is required/i
    );

    // Non-images are rejected before anything is written.
    const textFile = path.join(downloads, 'notes.txt');
    await fsp.writeFile(textFile, 'not a photo');
    await assert.rejects(
      () => publishMoment({ root, imagePath: textFile, caption: 'Nope' }),
      /Unsupported image type/
    );

    // A dry run reports but never touches the repository.
    const dry = await publishMoment({
      root,
      imagePath: photo,
      metadata: metadataFile,
      id: 'moment-dryrun',
      dryRun: true
    });
    assert.equal(dry.written, false);
    const untouched = JSON.parse(await fsp.readFile(path.join(root, 'content', 'gallery.json'), 'utf8'));
    assert.equal(untouched.length, 2);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
    await fsp.rm(downloads, { recursive: true, force: true });
  }
});
