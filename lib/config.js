'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { toPositiveInt } = require('./util');
const { hasBlobCredentials } = require('./blob-storage');

const DEFAULT_FORM_ENDPOINT = 'https://formspree.io/f/xvkoraeq';

/**
 * Vercel Functions reject request bodies over 4.5 MB before any code runs.
 * Uploads travel as base64 inside JSON (+~33%), so a 3 MiB photo produces a
 * ~4 MiB request and stays safely under the platform limit.
 */
const SERVERLESS_MAX_UPLOAD_BYTES = 3 * 1024 * 1024;

function parseEmailList(value) {
  if (Array.isArray(value)) {
    return value.map((email) => String(email).trim().toLowerCase()).filter(Boolean);
  }

  return String(value ?? '')
    .split(/[,;\s]+/)
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

function loadSecret(runtimeDir, override) {
  if (override) return String(override);
  if (process.env.MOMENTS_SECRET) return process.env.MOMENTS_SECRET;

  const secretFile = path.join(runtimeDir, 'secret.key');

  try {
    const existing = fs.readFileSync(secretFile, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch {
    // A first run (or an ephemeral disk) simply gets a fresh secret.
  }

  const secret = crypto.randomBytes(32).toString('hex');

  try {
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(secretFile, secret, { mode: 0o600 });
  } catch (error) {
    console.warn(`[labroute] Could not persist the cookie secret: ${error.message}`);
  }

  return secret;
}

function normaliseEmailProvider(value) {
  const provider = String(value || 'auto').trim().toLowerCase();
  if (['auto', 'resend', 'webhook', 'formspree', 'none'].includes(provider)) return provider;
  return 'auto';
}

function normaliseStorageMode(value) {
  const mode = String(value || 'auto').trim().toLowerCase();
  if (['auto', 'blob', 'local'].includes(mode)) return mode;
  return 'auto';
}

function loadConfig(overrides = {}) {
  const rootDir = path.resolve(overrides.rootDir || path.join(__dirname, '..'));
  const contentDir = path.resolve(overrides.contentDir || path.join(rootDir, 'content'));

  // On Vercel the deployment filesystem is read-only: writing to assets/,
  // content/ or data/ fails. The only writable location is the OS temp dir,
  // which is per-instance and ephemeral — fine as a fallback, but durable
  // uploads need a connected Vercel Blob store (see storageMode below).
  const isServerless =
    overrides.serverless !== undefined
      ? Boolean(overrides.serverless)
      : Boolean(process.env.VERCEL || process.env.VERCEL_ENV);
  const writableRoot = path.join(os.tmpdir(), 'labroute');

  const requestedStorage = normaliseStorageMode(
    overrides.storage ?? process.env.MOMENTS_STORAGE
  );
  const useBlob =
    Boolean(overrides.blobStorage) ||
    requestedStorage === 'blob' ||
    (requestedStorage === 'auto' && hasBlobCredentials());
  const storageMode = useBlob ? 'vercel-blob' : isServerless ? 'ephemeral' : 'local';

  const dataDir = path.resolve(
    overrides.dataDir || (isServerless ? path.join(writableRoot, 'data') : path.join(rootDir, 'data'))
  );
  const runtimeDir = path.resolve(overrides.runtimeDir || path.join(dataDir, 'runtime'));
  const uploadDir = path.resolve(
    overrides.uploadDir ||
      (isServerless
        ? path.join(writableRoot, 'uploads')
        : path.join(rootDir, 'assets', 'gallery', 'moments'))
  );
  const pendingDir = path.resolve(overrides.pendingDir || path.join(dataDir, 'pending'));

  // The committed gallery is the seed. On a read-only filesystem the writable
  // copy (which approvals update) has to live elsewhere; the gallery store
  // falls back to the seed until the first approval creates the copy.
  const gallerySeedFile = path.resolve(path.join(contentDir, 'gallery.json'));
  const galleryFile = path.resolve(
    overrides.galleryFile ||
      (isServerless ? path.join(writableRoot, 'content', 'gallery.json') : gallerySeedFile)
  );
  // Admins are committed seed data, so on serverless they must be read from
  // the repo, not from the (temporary) writable data dir. An explicit
  // dataDir override keeps the historical adminsFile location.
  const adminsFile = path.resolve(
    overrides.adminsFile ||
      (overrides.dataDir ? path.join(dataDir, 'admins.json') : path.join(rootDir, 'data', 'admins.json'))
  );

  const cooldownMinutes = toPositiveInt(
    overrides.cooldownMinutes ?? process.env.MOMENTS_COOLDOWN_MINUTES,
    30
  );
  const requestedMaxUploadBytes = toPositiveInt(
    overrides.maxUploadBytes ?? process.env.MOMENTS_MAX_UPLOAD_BYTES,
    8 * 1024 * 1024
  );
  const maxUploadBytes = isServerless
    ? Math.min(requestedMaxUploadBytes, SERVERLESS_MAX_UPLOAD_BYTES)
    : requestedMaxUploadBytes;

  const emailOverrides = overrides.email || {};
  const envFormEndpoint =
    process.env.MOMENTS_FORM_ENDPOINT === undefined
      ? DEFAULT_FORM_ENDPOINT
      : process.env.MOMENTS_FORM_ENDPOINT.trim();
  const formEndpoint =
    emailOverrides.formEndpoint !== undefined
      ? emailOverrides.formEndpoint
      : envFormEndpoint && envFormEndpoint.toLowerCase() !== 'off'
        ? envFormEndpoint
        : null;

  const email = {
    provider: normaliseEmailProvider(
      emailOverrides.provider ?? process.env.MOMENTS_EMAIL_PROVIDER
    ),
    resendApiKey: emailOverrides.resendApiKey ?? process.env.RESEND_API_KEY ?? '',
    resendFrom:
      emailOverrides.resendFrom ??
      process.env.RESEND_FROM ??
      'LabRoute <onboarding@resend.dev>',
    adminEmails: parseEmailList(
      emailOverrides.adminEmails ?? process.env.MOMENTS_ADMIN_EMAILS
    ),
    webhookUrl: emailOverrides.webhookUrl ?? process.env.MOMENTS_WEBHOOK_URL ?? '',
    formEndpoint,
    timeoutMs: toPositiveInt(emailOverrides.timeoutMs, 7000)
  };

  const secretConfigured = Boolean(overrides.secret || process.env.MOMENTS_SECRET);
  const blobAccessRaw = String(
    overrides.blobAccess ?? process.env.BLOB_ACCESS ?? process.env.MOMENTS_BLOB_ACCESS ?? ''
  )
    .trim()
    .toLowerCase();

  return {
    rootDir,
    contentDir,
    dataDir,
    runtimeDir,
    uploadDir,
    pendingDir,
    galleryFile,
    gallerySeedFile,
    adminsFile,
    pendingFile: path.join(pendingDir, 'pending.json'),
    notificationsFile: path.join(runtimeDir, 'notifications.jsonl'),
    rateLimitFile: path.join(runtimeDir, 'rate-limits.json'),
    secret: loadSecret(runtimeDir, overrides.secret),
    // Without MOMENTS_SECRET each serverless instance mints its own secret,
    // which silently invalidates visitor cookies and admin sessions made by
    // other instances. Surface that in /api/health instead of hiding it.
    secretConfigured,
    secretIsEphemeral: isServerless && !secretConfigured,
    isServerless,
    storageMode,
    // null when not set: the Blob client tries private first, then public,
    // and remembers whichever matches the connected store.
    blobAccess:
      blobAccessRaw === 'public' ? 'public' : blobAccessRaw === 'private' ? 'private' : null,

    port: toPositiveInt(overrides.port ?? process.env.PORT, 3000),
    host: overrides.host || process.env.HOST || '0.0.0.0',
    publicBaseUrl:
      overrides.publicBaseUrl ??
      process.env.PUBLIC_BASE_URL ??
      (process.env.VERCEL_PROJECT_PRODUCTION_URL
        ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
        : ''),
    trustProxy:
      overrides.trustProxy !== undefined
        ? Boolean(overrides.trustProxy)
        : process.env.TRUST_PROXY !== 'false',

    publicUploadPrefix: '/assets/gallery/moments',
    visitorCookieName: 'labroute_visitor',
    adminCookieName: 'labroute_admin',
    visitorCookieMaxAge: 365 * 24 * 60 * 60,
    adminSessionTtlMs: 8 * 60 * 60 * 1000,

    cooldownMinutes,
    maxUploadBytes,
    maxJsonBytes: Math.ceil(maxUploadBytes * 1.45) + 64 * 1024,
    maxImageDimension: 10000,
    maxImagePixels: 40 * 1000 * 1000,
    captionMaxLength: 160,
    contributorMaxLength: 60,

    rateLimit: {
      cooldownMs: cooldownMinutes * 60 * 1000,
      windowMs: cooldownMinutes * 60 * 1000,
      ipLimit: toPositiveInt(overrides.ipLimit ?? process.env.MOMENTS_IP_LIMIT, 50),
      retentionMs: 24 * 60 * 60 * 1000,
      maxKeys: 5000
    },

    email
  };
}

module.exports = { loadConfig, parseEmailList, SERVERLESS_MAX_UPLOAD_BYTES };
