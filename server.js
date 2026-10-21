'use strict';

const fs = require('fs');
const fsp = fs.promises;
const http = require('http');
const path = require('path');

const adminAuth = require('./lib/admin-auth');
const { loadConfig, storageStatus } = require('./lib/config');
const { loadEnvFile } = require('./lib/env');
const { loadAdminEmails, logNotification, notifyMomentUpload, resolveProvider } = require('./lib/email');
const { GalleryStore } = require('./lib/gallery-store');
const { MomentsService } = require('./lib/moments-service');
const { PendingStore } = require('./lib/pending-store');
const { RateLimitStore } = require('./lib/rate-limit');
const { blobDiagnostics, createBlobStorage } = require('./lib/blob-storage');
const {
  HttpError,
  getClientIp,
  hmac,
  isSecureRequest,
  parseCookies,
  randomToken,
  requestOrigin,
  safeEqual,
  serializeCookie,
  toPositiveInt
} = require('./lib/util');

const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain',
  '.xml': 'application/xml',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.map': 'application/json'
};

const CHARSET_EXTENSIONS = new Set(['.html', '.css', '.js', '.mjs', '.json', '.svg', '.txt', '.xml', '.map']);
const BLOCKED_STATIC_ROOTS = new Set([
  '.git',
  '.env',
  'api',
  'lib',
  'node_modules',
  'package-lock.json',
  'package.json',
  'server.js',
  'tests',
  'vercel.json'
]);

const apiNoStore = { 'Cache-Control': 'no-store' };

function sendJson(res, status, payload, headers = {}) {
  if (res.headersSent) {
    res.end();
    return;
  }

  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    ...apiNoStore,
    ...headers
  });
  res.end(body);
}

function sendMethodNotAllowed(res, allowed) {
  sendJson(
    res,
    405,
    {
      ok: false,
      error: 'method_not_allowed',
      message: 'This request method is not supported for that endpoint.'
    },
    { Allow: allowed.join(', ') }
  );
}

function sendError(res, error) {
  if (res.headersSent) {
    res.destroy();
    return;
  }

  if (error instanceof HttpError) {
    const headers = { ...apiNoStore };
    if (error.status === 429 && error.extra?.retryAfterSeconds) {
      headers['Retry-After'] = String(error.extra.retryAfterSeconds);
    }

    sendJson(
      res,
      error.status,
      {
        ok: false,
        error: error.code,
        message: error.message,
        ...error.extra
      },
      headers
    );
    return;
  }

  console.error('[labroute] Unhandled request error:', error);
  sendJson(res, 500, {
    ok: false,
    error: 'server_error',
    message: 'Something went wrong while handling that request. Please try again.'
  });
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declaredLength = Number(req.headers['content-length'] || 0);

    if (Number.isFinite(declaredLength) && declaredLength > limit) {
      req.resume();
      reject(
        new HttpError(
          413,
          'payload_too_large',
          'That upload is too large. Please choose a smaller photo.'
        )
      );
      return;
    }

    let total = 0;
    let settled = false;
    const chunks = [];

    function finish(callback, value) {
      if (settled) return;
      settled = true;
      callback(value);
    }

    req.on('data', (chunk) => {
      total += chunk.length;

      if (total > limit) {
        chunks.length = 0;
        req.removeAllListeners('data');
        req.removeAllListeners('end');
        req.removeAllListeners('error');
        req.on('error', () => {});
        req.resume();
        finish(
          reject,
          new HttpError(
            413,
            'payload_too_large',
            'That upload is too large. Please choose a smaller photo.'
          )
        );
        return;
      }

      chunks.push(chunk);
    });

    req.on('end', () => finish(resolve, Buffer.concat(chunks)));
    req.on('error', (error) => finish(reject, error));
  });
}

function assertJsonObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'invalid_json', 'The request body must be a JSON object.');
  }
  return value;
}

async function readJsonBody(req, limit) {
  const contentType = String(req.headers['content-type'] || '')
    .split(';')[0]
    .trim()
    .toLowerCase();

  // Some serverless platforms (Vercel's Node helpers) parse the JSON body
  // before the handler runs and consume the request stream. Use that parsed
  // body when present; on the plain Node server `req.body` is undefined and
  // the stream path below runs exactly as before. The Vercel entrypoint also
  // exports `config.api.bodyParser = false`, so this is belt and braces.
  // Note the helpers' parser is a lazy getter that throws on invalid JSON.
  let preParsed;
  if (contentType === 'application/json' && 'body' in req) {
    try {
      preParsed = req.body;
    } catch {
      throw new HttpError(400, 'invalid_json', 'The request body was not valid JSON.');
    }
  }
  if (preParsed !== undefined && preParsed !== null && preParsed !== '') {
    if (typeof preParsed === 'object' && !Buffer.isBuffer(preParsed)) {
      return assertJsonObject(preParsed);
    }

    const rawPreParsed = Buffer.isBuffer(preParsed) ? preParsed : Buffer.from(String(preParsed));
    if (rawPreParsed.length > limit) {
      throw new HttpError(
        413,
        'payload_too_large',
        'That upload is too large. Please choose a smaller photo.'
      );
    }

    try {
      return assertJsonObject(JSON.parse(rawPreParsed.toString('utf8')));
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, 'invalid_json', 'The request body was not valid JSON.');
    }
  }

  const raw = await readBody(req, limit);

  if (!raw.length) {
    throw new HttpError(400, 'empty_body', 'The request body was empty.');
  }

  if (contentType !== 'application/json') {
    throw new HttpError(415, 'unsupported_content_type', 'Expected an application/json request.');
  }

  let parsed;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid_json', 'The request body was not valid JSON.');
  }

  return assertJsonObject(parsed);
}

function getVisitorIdentity(req, config) {
  const cookies = parseCookies(req.headers.cookie);
  const rawCookie = cookies[config.visitorCookieName] || '';

  let visitorId = null;
  const separator = rawCookie.lastIndexOf('.');
  if (separator > 0) {
    const candidate = rawCookie.slice(0, separator);
    const signature = rawCookie.slice(separator + 1);
    const expected = hmac(`visitor|${candidate}`, config.secret).slice(0, 32);

    if (/^[A-Za-z0-9_-]{8,64}$/.test(candidate) && safeEqual(signature, expected)) {
      visitorId = candidate;
    }
  }

  const isNewVisitor = !visitorId;
  if (!visitorId) visitorId = randomToken(18);

  const rawDevice = String(req.headers['x-labroute-device'] || '');
  const deviceId = /^[A-Za-z0-9_-]{8,128}$/.test(rawDevice) ? rawDevice : '';

  const ip = getClientIp(req, config.trustProxy);
  const userAgent = `${String(req.headers['user-agent'] || '').slice(0, 300)}|${String(
    req.headers['accept-language'] || ''
  ).slice(0, 80)}`;

  return { visitorId, isNewVisitor, deviceId, ip, userAgent };
}

function visitorCookie(config, identity, req) {
  const value = `${identity.visitorId}.${hmac(
    `visitor|${identity.visitorId}`,
    config.secret
  ).slice(0, 32)}`;

  return serializeCookie(config.visitorCookieName, value, {
    maxAge: config.visitorCookieMaxAge,
    secure: isSecureRequest(req),
    httpOnly: true,
    sameSite: 'Lax'
  });
}

function adminSession(req, config) {
  const cookies = parseCookies(req.headers.cookie);
  return adminAuth.verifyToken(config, cookies[config.adminCookieName]);
}

function requireAdmin(req, config) {
  const session = adminSession(req, config);
  if (!session) {
    throw new HttpError(401, 'admin_auth_required', 'Please sign in to the admin dashboard again.');
  }
  return session;
}

function loginAttemptCheck(attempts, key, now) {
  if (attempts.size > 2000) {
    for (const [attemptKey, value] of attempts) {
      if (value.resetAt <= now) attempts.delete(attemptKey);
    }
  }

  const existing = attempts.get(key);

  if (!existing || existing.resetAt <= now) {
    attempts.set(key, { count: 1, resetAt: now + 15 * 60 * 1000 });
    return { allowed: true };
  }

  existing.count += 1;
  if (existing.count > 10) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000))
    };
  }

  return { allowed: true };
}

async function handleAdminApi(req, res, pathname, url, ctx) {
  const { config, galleryStore } = ctx;
  const method = req.method || 'GET';

  if (pathname === '/api/admin/login') {
    if (method !== 'POST') return sendMethodNotAllowed(res, ['POST']);

    const body = await readJsonBody(req, 32 * 1024);
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');

    if (!email || !password) {
      throw new HttpError(400, 'credentials_required', 'Enter your admin email and password.');
    }

    const ip = getClientIp(req, config.trustProxy);
    const attempt = loginAttemptCheck(ctx.loginAttempts, `${ip}|${email}`, Date.now());

    if (!attempt.allowed) {
      throw new HttpError(
        429,
        'login_rate_limited',
        'Too many sign-in attempts. Please wait a few minutes and try again.',
        { retryAfterSeconds: attempt.retryAfterSeconds }
      );
    }

    const admin = await adminAuth.verifyCredentials(config, email, password);
    if (!admin) {
      throw new HttpError(401, 'invalid_credentials', 'Incorrect institutional email or security key.');
    }

    ctx.loginAttempts.delete(`${ip}|${email}`);
    const token = adminAuth.createToken(config, admin.email);

    res.setHeader(
      'Set-Cookie',
      serializeCookie(config.adminCookieName, token, {
        maxAge: Math.floor(config.adminSessionTtlMs / 1000),
        secure: isSecureRequest(req),
        httpOnly: true,
        sameSite: 'Lax'
      })
    );

    return sendJson(res, 200, { ok: true, email: admin.email });
  }

  if (pathname === '/api/admin/logout') {
    if (method !== 'POST') return sendMethodNotAllowed(res, ['POST']);

    res.setHeader(
      'Set-Cookie',
      serializeCookie(config.adminCookieName, '', {
        maxAge: 0,
        secure: isSecureRequest(req),
        httpOnly: true,
        sameSite: 'Lax'
      })
    );

    return sendJson(res, 200, { ok: true });
  }

  if (pathname === '/api/admin/session') {
    if (method !== 'GET') return sendMethodNotAllowed(res, ['GET']);

    const session = adminSession(req, config);
    return sendJson(res, 200, {
      ok: true,
      authenticated: Boolean(session),
      email: session?.email || null
    });
  }

  if (pathname === '/api/admin/pending') {
    if (method !== 'GET') return sendMethodNotAllowed(res, ['GET']);

    const session = requireAdmin(req, config);
    const pending = await ctx.moments.listPending();
    const gallery = await galleryStore.publicGallery();

    return sendJson(res, 200, {
      ok: true,
      admin: session.email,
      count: pending.length,
      pending,
      liveCount: gallery.length,
      // The dashboard turns this into a warning banner: approving while
      // `durable` is false stores the photo in a throwaway /tmp.
      storage: storageStatus(config)
    });
  }

  const pendingImage = /^\/api\/admin\/pending\/([A-Za-z0-9_-]{4,80})\/image$/.exec(pathname);
  if (pendingImage) {
    if (method !== 'GET') return sendMethodNotAllowed(res, ['GET']);

    requireAdmin(req, config);
    const file = await ctx.moments.getPendingFile(pendingImage[1]);

    res.writeHead(200, {
      'Content-Type': file.mime,
      'Content-Length': file.buffer.length,
      'Cache-Control': 'no-store'
    });
    res.end(file.buffer);
    return undefined;
  }

  // Manual publish: hand the admin the exact bytes and the exact JSON record,
  // so the photo can be committed to the repository instead of stored in Blob.
  const pendingDownload = /^\/api\/admin\/pending\/([A-Za-z0-9_-]{4,80})\/(download|metadata)$/.exec(
    pathname
  );
  if (pendingDownload) {
    if (method !== 'GET') return sendMethodNotAllowed(res, ['GET']);

    requireAdmin(req, config);
    const [, id, kind] = pendingDownload;

    if (kind === 'download') {
      const file = await ctx.moments.getPendingFile(id);
      const entry = (await ctx.pendingStore.get(id)) || {};
      const ext = String(entry.ext || mimeExtension(file.mime)).replace(/^\./, '');
      const filename = `${id}.${ext}`;

      res.writeHead(200, {
        'Content-Type': file.mime,
        'Content-Length': file.buffer.length,
        // A real download, not a preview: "Save as" gets a usable filename.
        'Content-Disposition': attachmentHeader(filename),
        'Cache-Control': 'no-store'
      });
      res.end(file.buffer);
      return undefined;
    }

    const entry = await ctx.pendingStore.get(id);
    if (!entry) {
      throw new HttpError(404, 'pending_not_found', 'That pending photo no longer exists.');
    }

    const body = Buffer.from(
      `${JSON.stringify(ctx.moments.publishedItem(entry), null, 2)}\n`,
      'utf8'
    );

    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': body.length,
      'Content-Disposition': attachmentHeader(`${id}.json`),
      'Cache-Control': 'no-store'
    });
    res.end(body);
    return undefined;
  }

  const pendingAction = /^\/api\/admin\/pending\/([A-Za-z0-9_-]{4,80})\/(approve|reject|publish)$/.exec(pathname);
  if (pendingAction) {
    if (method !== 'POST') return sendMethodNotAllowed(res, ['POST']);

    const session = requireAdmin(req, config);
    const [, id, action] = pendingAction;

    if (action === 'approve') {
      const result = await ctx.moments.approvePending(id);
      const storage = storageStatus(config);

      return sendJson(res, 200, {
        ok: true,
        admin: session.email,
        message: storage.durable
          ? 'Approved. The photo is now image 1 in the gallery.'
          : 'Approved into temporary storage. This photo will disappear on the next restart or deploy — connect a Vercel Blob store to keep it.',
        durable: storage.durable,
        storage,
        ...result
      });
    }

    if (action === 'publish') {
      const result = await ctx.moments.publishPending(id);
      return sendJson(res, 200, {
        ok: true,
        admin: session.email,
        message:
          'Marked as published. Commit the downloaded photo and its JSON to the repository to make it live.',
        ...result
      });
    }

    const result = await ctx.moments.rejectPending(id);
    return sendJson(res, 200, {
      ok: true,
      admin: session.email,
      message: 'Declined. The photo was removed.',
      ...result
    });
  }

  return sendJson(res, 404, {
    ok: false,
    error: 'not_found',
    message: 'Unknown admin endpoint.'
  });
}

async function handleApi(req, res, pathname, url, ctx) {
  const { config, galleryStore, moments } = ctx;
  const method = req.method || 'GET';

  if (pathname === '/api/health') {
    if (method !== 'GET') return sendMethodNotAllowed(res, ['GET']);

    const storage = storageStatus(config);
    const blob = blobDiagnostics();

    return sendJson(res, 200, {
      ok: true,
      service: 'labroute-moments',
      cooldownMinutes: config.cooldownMinutes,
      maxUploadBytes: config.maxUploadBytes,
      emailProvider: resolveProvider(config) || 'none',
      storage: config.storageMode,
      serverless: config.isServerless,
      // false means approved photos are only in an ephemeral /tmp: they will
      // vanish on the next cold start or deploy.
      durable: storage.durable,
      warning: storage.message,
      hint: storage.hint,
      // Booleans only (never the credential values). This is how you tell a
      // missing Blob store apart from one connected to the wrong environment.
      blob,
      // Lets an operator verify production is durable without logging in:
      // storage should be "vercel-blob" and secretConfigured true on Vercel.
      secretConfigured: config.secretConfigured
    });
  }

  if (pathname === '/api/gallery') {
    if (method !== 'GET') return sendMethodNotAllowed(res, ['GET']);

    const { gallery, source } = await galleryStore.publicGalleryState();
    // `source: "seed"` means storage held no gallery manifest and the site is
    // showing content/gallery.json as committed — approved photos are absent
    // from storage, they are not just missing from the rendered page.
    return sendJson(res, 200, { ok: true, gallery, count: gallery.length, source });
  }

  if (pathname === '/api/moments/status') {
    if (method !== 'GET') return sendMethodNotAllowed(res, ['GET']);

    const identity = getVisitorIdentity(req, config);
    if (identity.isNewVisitor) {
      res.setHeader('Set-Cookie', visitorCookie(config, identity, req));
    }

    const status = await moments.getStatus(identity);
    return sendJson(res, 200, { ok: true, ...status });
  }

  if (pathname === '/api/moments/recent') {
    if (method !== 'GET') return sendMethodNotAllowed(res, ['GET']);

    const limit = Math.min(24, toPositiveInt(url.searchParams.get('limit'), 8));
    const recent = await galleryStore.recentMoments(limit);
    return sendJson(res, 200, { ok: true, moments: recent, count: recent.length });
  }

  if (pathname === '/api/moments') {
    if (method !== 'POST') return sendMethodNotAllowed(res, ['POST']);

    const identity = getVisitorIdentity(req, config);
    if (identity.isNewVisitor) {
      res.setHeader('Set-Cookie', visitorCookie(config, identity, req));
    }

    const body = await readJsonBody(req, config.maxJsonBytes);
    const result = await moments.createMoment(body, identity);
    const origin = requestOrigin(req, config.publicBaseUrl);
    const links = {
      dashboardUrl: `${origin}/dashboard.html#pending`
    };

    const notification = await notifyMomentUpload({
      config,
      moment: result.moment,
      contributor: result.moment.contributor,
      links
    });

    await logNotification(config, {
      momentId: result.moment.id,
      caption: result.moment.caption,
      contributor: result.moment.contributor || 'Anonymous contributor',
      provider: notification.provider,
      status: notification.status,
      error: notification.error || null,
      recipients: notification.recipients,
      reason: notification.reason || null
    });

    return sendJson(res, 201, {
      ok: true,
      message:
        'Your photo was sent to the admin team for review. Once approved, it becomes image 1 in the gallery.',
      pending: true,
      moment: result.moment,
      pendingCount: result.pendingCount,
      notification: {
        provider: notification.provider,
        status: notification.status
      },
      ...result.cooldown
    });
  }

  if (pathname === '/api/admin' || pathname.startsWith('/api/admin/')) {
    return handleAdminApi(req, res, pathname, url, ctx);
  }

  return sendJson(res, 404, {
    ok: false,
    error: 'not_found',
    message: 'Unknown API endpoint.'
  });
}

function mimeExtension(mime) {
  switch (String(mime || '').toLowerCase()) {
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
    case 'image/gif':
      return 'gif';
    default:
      return 'jpg';
  }
}

/** RFC 6266 attachment header; ASCII names only (ids are [A-Za-z0-9_-]). */
function attachmentHeader(filename) {
  return `attachment; filename="${filename}"`;
}

function cacheControlFor(file, isUpload) {
  if (isUpload) return 'public, max-age=31536000, immutable';

  const extension = path.extname(file).toLowerCase();
  if (['.html', '.json', '.js', '.mjs', '.css'].includes(extension)) return 'no-cache';
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.ico', '.woff', '.woff2'].includes(extension)) {
    return 'public, max-age=86400';
  }
  return 'no-cache';
}

function resolveStaticFile(pathname, config) {
  if (pathname === '/') {
    return { file: path.join(config.rootDir, 'index.html'), isUpload: false };
  }

  const uploadPrefix = `${config.publicUploadPrefix}/`;
  if (pathname.startsWith(uploadPrefix)) {
    const name = pathname.slice(uploadPrefix.length);
    if (!name || name !== path.basename(name) || !/^[A-Za-z0-9._-]+$/.test(name)) return null;

    return { file: path.join(config.uploadDir, name), isUpload: true };
  }

  const withoutLeadingSlash = pathname.replace(/^\/+/, '');
  if (!withoutLeadingSlash || withoutLeadingSlash.includes('\\') || withoutLeadingSlash.includes('\0')) {
    return null;
  }

  const normalized = path.posix.normalize(withoutLeadingSlash);
  if (normalized.startsWith('..') || path.posix.isAbsolute(normalized)) return null;

  const segments = normalized.split('/');
  if (BLOCKED_STATIC_ROOTS.has(segments[0]) || BLOCKED_STATIC_ROOTS.has(normalized)) return null;
  if (normalized === 'data/runtime' || normalized.startsWith('data/runtime/')) return null;
  if (normalized === 'data/private' || normalized.startsWith('data/private/')) return null;
  if (normalized === 'data/pending' || normalized.startsWith('data/pending/')) return null;

  const root = path.resolve(config.rootDir);
  const file = path.resolve(root, normalized);
  if (file !== root && !file.startsWith(root + path.sep)) return null;

  return { file, isUpload: false };
}

async function serveStatic(req, res, pathname, ctx) {
  const { config } = ctx;

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendMethodNotAllowed(res, ['GET', 'HEAD']);
  }

  const resolved = resolveStaticFile(pathname, config);
  if (!resolved) return sendNotFound(req, res);

  // Approved photos in Blob storage are not files in the deployment, so the
  // CDN cannot serve them. Stream them from storage instead. (In local and
  // ephemeral modes they are real files under config.uploadDir, below.)
  if (resolved.isUpload && config.storageMode === 'vercel-blob') {
    const name = path.basename(resolved.file);
    const uploaded = await ctx.moments.getUploadedFile(name);

    if (uploaded) {
      res.writeHead(200, {
        'Content-Type': uploaded.mime,
        'Content-Length': uploaded.buffer.length,
        'Cache-Control': cacheControlFor(resolved.file, true)
      });
      if (req.method !== 'HEAD') res.write(uploaded.buffer);
      res.end();
      return undefined;
    }

    // Not in Blob — but it may be a photo committed to the repository by the
    // manual publish workflow, which is a real file on disk. (On Vercel the
    // filesystem is checked before this rewrite, so those requests never
    // reach here; this covers Node hosts that also have Blob configured.)
    const committed = path.join(config.rootDir, 'assets', 'gallery', 'moments', name);
    try {
      const committedStat = await fsp.stat(committed);
      if (!committedStat.isFile()) return sendNotFound(req, res);
      resolved.file = committed;
    } catch {
      return sendNotFound(req, res);
    }
  }

  let { file } = resolved;
  let stat;

  try {
    stat = await fsp.stat(file);
  } catch {
    stat = null;
  }

  // Friendly extensionless routes such as /upload or /about.
  if ((!stat || stat.isDirectory()) && !path.extname(file) && !resolved.isUpload) {
    const htmlCandidate = `${file}.html`;
    try {
      const htmlStat = await fsp.stat(htmlCandidate);
      if (htmlStat.isFile()) {
        file = htmlCandidate;
        stat = htmlStat;
      }
    } catch {
      // Keep the original 404.
    }
  }

  if (!stat || !stat.isFile()) return sendNotFound(req, res);

  const extension = path.extname(file).toLowerCase();
  let contentType = MIME_TYPES[extension] || 'application/octet-stream';
  if (CHARSET_EXTENSIONS.has(extension)) contentType += '; charset=utf-8';

  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': stat.size,
    'Cache-Control': cacheControlFor(file, resolved.isUpload),
    'Last-Modified': stat.mtime.toUTCString()
  });

  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  const stream = fs.createReadStream(file);
  stream.on('error', (error) => {
    console.error(`[labroute] Could not stream ${file}:`, error.message);
    res.destroy();
  });
  stream.pipe(res);
}

function sendNotFound(req, res) {
  if (res.headersSent) {
    res.end();
    return;
  }

  const acceptsHtml = String(req.headers.accept || '').includes('text/html');
  const body = acceptsHtml
    ? `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Page not found — LabRoute</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#faf8ff;color:#1a1b22;font-family:system-ui,sans-serif}main{text-align:center;padding:2rem}h1{font-family:Georgia,serif;color:#002147;font-size:2.5rem;margin:0 0 .75rem}p{color:#535665;margin:0 0 1.5rem}a{display:inline-block;background:#002147;color:#fff;text-decoration:none;padding:.75rem 1.4rem;border-radius:999px;font-weight:600}</style></head><body><main><p style="letter-spacing:.12em;font-size:.75rem;color:#0043ae">LABROUTE · 404</p><h1>This page is not on the bench.</h1><p>The link may be old, or the page may have moved.</p><a href="/index.html">Return to the archive</a></main></body></html>`
    : 'Not found';

  res.writeHead(404, {
    'Content-Type': acceptsHtml ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

async function handleRequest(req, res, ctx) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  let url;
  try {
    url = new URL(req.url || '/', 'http://localhost');
  } catch {
    return sendJson(res, 400, { ok: false, error: 'bad_request', message: 'Invalid request URL.' });
  }

  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return sendJson(res, 400, { ok: false, error: 'bad_request', message: 'Invalid request path.' });
  }

  if (pathname === '/api' || pathname.startsWith('/api/')) {
    return handleApi(req, res, pathname, url, ctx);
  }

  return serveStatic(req, res, pathname, ctx);
}

function resolveBlobStorage(overrides, config) {
  if (overrides.blobStorage) return overrides.blobStorage;
  if (config.storageMode !== 'vercel-blob') return null;

  const blobStorage = createBlobStorage({ access: config.blobAccess });
  if (!blobStorage) {
    // Blob was requested but the SDK is unavailable (e.g. `npm start`
    // without `npm install`). Degrade to disk rather than failing every
    // request; /api/health reports the mode that is actually in use.
    config.storageMode = config.isServerless ? 'ephemeral' : 'local';
    return null;
  }
  return blobStorage;
}

function createApp(overrides = {}) {
  const config = loadConfig(overrides);
  const blobStorage = resolveBlobStorage(overrides, config);
  const galleryStore = new GalleryStore(config, blobStorage);
  const rateLimits = new RateLimitStore(config.rateLimitFile, config.rateLimit, blobStorage);
  const pendingStore = new PendingStore(config, blobStorage);
  const moments = new MomentsService({ config, galleryStore, rateLimits, pendingStore });
  const ctx = {
    config,
    galleryStore,
    rateLimits,
    pendingStore,
    moments,
    blobStorage,
    loginAttempts: new Map()
  };

  // The same handler powers the long-running Node server (local / Node
  // hosts) and the Vercel Function in api/[...path].js.
  const handler = (req, res) => {
    handleRequest(req, res, ctx).catch((error) => sendError(res, error));
  };

  const storage = storageStatus(config);
  if (!storage.durable) {
    console.warn(
      '[labroute] Temporary storage in use: approvals live in /tmp and will be lost when this instance recycles. /api/health reports durable:false.'
    );
  }

  const server = http.createServer(handler);

  server.headersTimeout = 25 * 1000;
  server.requestTimeout = 60 * 1000;
  server.on('clientError', (error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  return { server, handler, config, ctx };
}

function start() {
  loadEnvFile(path.join(__dirname, '.env'));

  const { server, config } = createApp();
  const provider = resolveProvider(config);

  server.on('error', (error) => {
    console.error(`[labroute] Server could not start: ${error.message}`);
    process.exitCode = 1;
  });

  server.listen(config.port, config.host, async () => {
    const admins = await loadAdminEmails(config);

    console.log('');
    console.log('  LabRoute · Lab Moments');
    console.log(`  ────────────────────────────────────────────`);
    console.log(`  Local:     http://localhost:${config.port}`);
    console.log(`  Bind:      ${config.host}:${config.port}`);
    console.log(`  Uploads:   ${Math.round(config.maxUploadBytes / (1024 * 1024))} MB max · ${config.cooldownMinutes} min cooldown`);
    console.log(
      `  Storage:   ${config.storageMode}${config.storageMode === 'vercel-blob' ? '' : ` (${config.uploadDir})`}`
    );
    console.log(
      `  Email:     ${provider || 'not configured'}${admins.length ? ` → ${admins.length} admin(s)` : ''}`
    );
    console.log('');

    const storage = storageStatus(config);
    if (!storage.durable) {
      console.warn('');
      console.warn('  WARNING · temporary storage');
      console.warn(`  ${storage.message}`);
      console.warn(`  ${storage.hint}`);
      console.warn('');
    }
  });

  const shutdown = (signal) => {
    console.log(`[labroute] ${signal} received; shutting down.`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

if (require.main === module) {
  start();
}

module.exports = { createApp };
