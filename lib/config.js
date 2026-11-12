'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { toPositiveInt } = require('./util');
const { blobDiagnostics, hasBlobCredentials } = require('./blob-storage');

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
  if (['auto', 'postgres', 'blob', 'local'].includes(mode)) return mode;
  return 'auto';
}

/**
 * Whether an approved photo actually survives a restart.
 *
 * - `postgres` — image bytes, rows, and signing keys survive cold starts.
 * - `vercel-blob` — a connected Blob store: durable on Vercel.
 * - `local` — a Node host's real disk: durable.
 * - `ephemeral` — Vercel's per-instance `/tmp`: the photo is live until that
 *   Function instance is recycled or the project is redeployed. That is the
 *   "approved image disappeared after a while" failure, and it must never be
 *   reported to an admin as a successful, permanent approval.
 */
function storageStatus(config, diagnostics = null) {
  const mode = (config && config.storageMode) || 'local';
  const durable = mode !== 'ephemeral';

  if (durable) {
    return { mode, durable, message: null, hint: null };
  }

  const blob = diagnostics || blobDiagnostics();
  let hint;

  if (!blob.credentials) {
    // Be specific: a store can be attached (BLOB_STORE_ID is injected) while
    // the Function still has no credential the SDK can authenticate with.
    // Telling that operator to "connect a store" sends them in circles.
    hint = blob.hasStoreId
      ? 'A Blob store is attached (BLOB_STORE_ID is set) but the Function has no usable credential: BLOB_READ_WRITE_TOKEN and VERCEL_OIDC_TOKEN are both missing. Add the store token as BLOB_READ_WRITE_TOKEN for Production (Storage → your store → .env / Connect), or enable OIDC for the project, then redeploy.'
      : 'No Blob store is attached to this environment. Vercel dashboard → Storage → Create → Blob, connect it to Production, then redeploy.';
  } else if (!blob.sdkAvailable) {
    hint = 'Blob credentials are present but @vercel/blob did not install into the Function. Run npm install so the dependency is deployed, then redeploy.';
  } else {
    hint = 'Blob credentials were detected but the API is still on /tmp. Check /api/health after the next deployment.';
  }

  return {
    mode,
    durable,
    message: 'Only temporary serverless storage is available. New uploads are paused until durable storage is configured; temporary files cannot survive restarts or redeploys.',
    hint: 'Recommended: set DATABASE_URL to the pooled Neon connection string, run npm run db:migrate, and redeploy. ' + hint
  };
}

function loadConfig(overrides = {}) {
  const rootDir = path.resolve(overrides.rootDir || path.join(__dirname, '..'));
  const contentDir = path.resolve(overrides.contentDir || path.join(rootDir, 'content'));

  // On Vercel the deployment filesystem is read-only: writing to assets/,
  // content/ or data/ fails. The only writable location is the OS temp dir,
  // which is per-instance and ephemeral. PostgreSQL bypasses all disk state;
  // the paths below remain for legacy imports and explicit local development.
  const isServerless =
    overrides.serverless !== undefined
      ? Boolean(overrides.serverless)
      : Boolean(process.env.VERCEL || process.env.VERCEL_ENV);
  const writableRoot = path.join(os.tmpdir(), 'labroute');

  const requestedStorage = normaliseStorageMode(
    overrides.storage ?? process.env.MOMENTS_STORAGE
  );
  const databaseUrl = overrides.databaseUrl ?? process.env.DATABASE_URL ?? '';
  const usePostgres = requestedStorage === 'postgres' ||
    (requestedStorage === 'auto' && Boolean(databaseUrl || overrides.database));
  const useBlob = !usePostgres && (
    Boolean(overrides.blobStorage) ||
    requestedStorage === 'blob' ||
    (requestedStorage === 'auto' && hasBlobCredentials()));
  const storageMode = usePostgres ? 'postgres' : useBlob ? 'vercel-blob' : isServerless ? 'ephemeral' : 'local';
  if (usePostgres && !databaseUrl && !overrides.database) {
    throw new Error('MOMENTS_STORAGE=postgres requires DATABASE_URL. No temporary-storage fallback is allowed.');
  }

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
  // Legacy admin seed data is used by the importer/local mode only. The Neon
  // app authenticates against labroute_admins, never this file. An explicit
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
    secret: usePostgres
      ? String(overrides.secret || process.env.MOMENTS_SECRET || crypto.randomBytes(32).toString('hex'))
      : loadSecret(runtimeDir, overrides.secret),
    // Without MOMENTS_SECRET each serverless instance mints its own secret,
    // which silently invalidates visitor cookies and admin sessions made by
    // other instances. Surface that in /api/health instead of hiding it.
    secretConfigured,
    secretIsEphemeral: isServerless && !secretConfigured && !usePostgres,
    isServerless,
    storageMode,
    databaseUrl,
    // Only test fixtures / legacy recovery can opt into throwaway uploads.
    allowEphemeralUploads: overrides.allowEphemeralUploads === true,
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

module.exports = {
  loadConfig,
  parseEmailList,
  storageStatus,
  SERVERLESS_MAX_UPLOAD_BYTES
};
