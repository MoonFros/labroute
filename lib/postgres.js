'use strict';

const crypto = require('node:crypto');
const { Pool } = require('pg');
const { attachDatabasePool } = require('@vercel/functions');
const { GalleryStore, publicItem } = require('./gallery-store');
const { RateLimitStore } = require('./rate-limit');
const { HttpError } = require('./util');

function databaseUrl(value, { direct = false } = {}) {
  let url;
  try {
    url = new URL(String(value || '').replace(/&amp;/g, '&'));
  } catch {
    throw new Error('Set DATABASE_URL to a valid PostgreSQL connection string.');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error('DATABASE_URL must use the postgres:// or postgresql:// protocol.');
  }
  if (direct && url.hostname.endsWith('.neon.tech')) {
    url.hostname = url.hostname.replace('-pooler.', '.');
  }
  return url;
}

function createPostgresPool(connectionString, options = {}) {
  const url = databaseUrl(connectionString);
  const sslMode = url.searchParams.get('sslmode');
  const channelBinding = url.searchParams.get('channel_binding');
  const neonHost = url.hostname.endsWith('.neon.tech');
  const tls = neonHost || (sslMode && sslMode !== 'disable');
  // Set TLS explicitly; do not depend on changing pg sslmode=require semantics.
  url.searchParams.delete('sslmode');
  url.searchParams.delete('channel_binding');
  const pool = new Pool({
    connectionString: url.toString(),
    ...(tls ? { ssl: { rejectUnauthorized: true } } : {}),
    enableChannelBinding: neonHost || channelBinding === 'require',
    max: options.max || 5,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 10000,
    statement_timeout: 20000,
    application_name: 'labroute',
    allowExitOnIdle: true
  });
  // Log codes only: connection errors must never disclose credentials.
  pool.on('error', (error) => console.error('[labroute] PostgreSQL pool error:', error.code || error.name));
  if (options.serverless) attachDatabasePool(pool);
  return pool;
}

const MOMENT_COLUMNS = `id, status, caption, contributor, image_path, ext, mime,
  width, height, bytes, tall, uploaded, uploaded_at, approved_at`;
const GALLERY_ORDER = `COALESCE(approved_at, uploaded_at) DESC NULLS LAST,
  publication_order DESC NULLS LAST, archive_order ASC, id ASC`;

function momentEntry(row) {
  if (!row) return null;
  return {
    id: row.id,
    caption: row.caption,
    contributor: row.contributor,
    image: row.image_path,
    ext: row.ext,
    mime: row.mime,
    width: row.width,
    height: row.height,
    bytes: row.bytes,
    tall: row.tall,
    uploaded: row.uploaded,
    uploadedAt: row.uploaded_at ? new Date(row.uploaded_at).toISOString() : null,
    approvedAt: row.approved_at ? new Date(row.approved_at).toISOString() : null
  };
}

function unavailable(error) {
  if (error instanceof HttpError) return error;
  console.error('[labroute] PostgreSQL operation failed:', error.code || error.name || 'unknown');
  return new HttpError(503, 'database_unavailable',
    'The database is temporarily unavailable. Nothing was saved to temporary storage. Please try again.');
}

class PostgresDatabase {
  constructor(config, pool = null) {
    this.config = config;
    this.pool = pool || createPostgresPool(config.databaseUrl, { serverless: config.isServerless });
    this.ready = null;
  }

  async query(text, values = [], client = this.pool) {
    try {
      return await client.query(text, values);
    } catch (error) {
      throw unavailable(error);
    }
  }

  async transaction(work) {
    let client;
    try {
      client = await this.pool.connect();
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      throw unavailable(error);
    } finally {
      if (client) client.release();
    }
  }

  async initialize() {
    if (!this.ready) {
      this.ready = (async () => {
        const imported = await this.query("SELECT value FROM labroute_settings WHERE key = 'data_import_complete'");
        if (!imported.rows.length) {
          throw new HttpError(503, 'database_not_initialized', 'The database import is not complete. Run npm run db:migrate before accepting uploads.');
        }
        if (!this.config.secretConfigured) {
          // One DB-backed signing key for every cold start. An env override wins.
          await this.query(`INSERT INTO labroute_settings (key, value) VALUES ('cookie_secret', $1)
            ON CONFLICT (key) DO NOTHING`, [crypto.randomBytes(32).toString('hex')]);
          const { rows } = await this.query(`SELECT value FROM labroute_settings WHERE key = 'cookie_secret'`);
          this.config.secret = rows[0].value;
        } else {
          await this.query('SELECT 1 FROM labroute_settings LIMIT 1');
        }
        this.config.secretConfigured = true;
        this.config.secretIsEphemeral = false;
      })().catch((error) => { this.ready = null; throw error; });
    }
    return this.ready;
  }

  async health() {
    await this.query('SELECT 1 AS connected');
    return { connected: true };
  }

  async readAdmins() {
    const { rows } = await this.query('SELECT email, password_hash FROM labroute_admins ORDER BY email');
    return rows.map((row) => ({ email: row.email, passwordCrypt: row.password_hash }));
  }

  async readDocument(documentPath) {
    const { rows } = await this.query('SELECT body FROM labroute_documents WHERE path = $1', [documentPath]);
    return rows.length ? rows[0].body : null;
  }

  async logNotification(entry) {
    await this.query('INSERT INTO labroute_notifications (body) VALUES ($1::jsonb)', [JSON.stringify(entry)]);
  }

  async loginAttempt(key, now) {
    const { rows } = await this.query(`INSERT INTO labroute_login_attempts (key, count, reset_at)
      VALUES ($1, 1, $2)
      ON CONFLICT (key) DO UPDATE SET
        count = CASE WHEN labroute_login_attempts.reset_at <= $3 THEN 1 ELSE labroute_login_attempts.count + 1 END,
        reset_at = CASE WHEN labroute_login_attempts.reset_at <= $3 THEN $2 ELSE labroute_login_attempts.reset_at END
      RETURNING count, reset_at`, [key, now + 15 * 60 * 1000, now]);
    await this.query('DELETE FROM labroute_login_attempts WHERE reset_at < $1', [now]);
    return {
      allowed: rows[0].count <= 10,
      retryAfterSeconds: Math.max(1, Math.ceil((Number(rows[0].reset_at) - now) / 1000))
    };
  }

  async clearLoginAttempt(key) {
    await this.query('DELETE FROM labroute_login_attempts WHERE key = $1', [key]);
  }

  async rateStatus(keys, ipKey, now, client = this.pool) {
    const allKeys = [...new Set([...keys, ...(ipKey ? [ipKey] : [])])];
    const { rows } = await this.query(`SELECT key, occurred_at FROM labroute_rate_events
      WHERE key = ANY($1::text[]) AND occurred_at > $2 ORDER BY occurred_at`,
    [allKeys, now - Math.max(this.config.rateLimit.cooldownMs, this.config.rateLimit.windowMs)], client);
    const limiter = new RateLimitStore(null, this.config.rateLimit);
    for (const row of rows) {
      if (!limiter.entries[row.key]) limiter.entries[row.key] = [];
      limiter.entries[row.key].push(Number(row.occurred_at));
    }
    return limiter.check(keys, ipKey, now);
  }

  async createMoment(entry, buffer, keys, ipKey, now) {
    return this.transaction(async (client) => {
      const allKeys = [...new Set([...keys, ...(ipKey ? [ipKey] : [])])].sort();
      // Transaction-scoped locks work through PgBouncer and across instances.
      // A fixed sort order prevents deadlocks for overlapping visitor/network keys.
      for (const key of allKeys) {
        await this.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key], client);
      }
      const status = await this.rateStatus(keys, ipKey, now, client);
      if (!status.allowed) return { status };

      await this.query(`INSERT INTO labroute_moments
        (id, status, caption, contributor, image_data, ext, mime, width, height, bytes, uploaded, uploaded_at)
        VALUES ($1, 'pending', $2, $3, $4, $5, $6, $7, $8, $9, true, $10)`,
      [entry.id, entry.caption, entry.contributor, buffer, entry.ext, entry.mime,
        entry.width, entry.height, buffer.length, entry.uploadedAt], client);
      await this.query(`INSERT INTO labroute_rate_events (key, occurred_at, event_id)
        SELECT unnest($1::text[]), $2::bigint, $3::text ON CONFLICT DO NOTHING`, [allKeys, now, entry.id], client);
      await this.query('DELETE FROM labroute_rate_events WHERE occurred_at < $1',
        [now - this.config.rateLimit.retentionMs], client);
      const { rows } = await this.query(`SELECT count(*)::integer AS count FROM labroute_moments WHERE status = 'pending'`, [], client);
      return { status: { allowed: true }, pendingCount: rows[0].count };
    });
  }

  async approve(id) {
    const { rows } = await this.query(`UPDATE labroute_moments SET status = 'approved',
      image_path = 'assets/gallery/moments/' || id || '.' || ext,
      approved_at = clock_timestamp(), publication_order = nextval('labroute_publication_order')
      WHERE id = $1 AND status = 'pending' AND image_data IS NOT NULL
      RETURNING ${MOMENT_COLUMNS}`, [id]);
    if (rows.length) return momentEntry(rows[0]);
    // Safe retry after a lost response; do not reorder an already-approved item.
    const existing = await this.query(`SELECT ${MOMENT_COLUMNS} FROM labroute_moments WHERE id = $1 AND status = 'approved'`, [id]);
    if (existing.rows.length) return momentEntry(existing.rows[0]);
    throw new HttpError(404, 'pending_not_found', 'That pending photo no longer exists.');
  }

  async reject(id) {
    const { rows } = await this.query(`UPDATE labroute_moments
      SET status = 'rejected', image_data = NULL, image_path = NULL
      WHERE id = $1 AND status = 'pending' RETURNING id`, [id]);
    if (!rows.length) {
      throw new HttpError(404, 'pending_not_found', 'That pending photo no longer exists.');
    }
  }

  async close() { await this.pool.end(); }
}

class PostgresGalleryStore extends GalleryStore {
  constructor(config, database) { super(config); this.database = database; }

  async readState() {
    const { rows } = await this.database.query(`SELECT ${MOMENT_COLUMNS} FROM labroute_moments
      WHERE status = 'approved' ORDER BY ${GALLERY_ORDER}`);
    return { gallery: rows.map(momentEntry), source: 'postgres' };
  }

  async recentMoments(limit = 8) {
    const { rows } = await this.database.query(`SELECT ${MOMENT_COLUMNS} FROM labroute_moments
      WHERE status = 'approved' AND uploaded = true ORDER BY ${GALLERY_ORDER} LIMIT $1`, [limit]);
    return rows.map(momentEntry).map(publicItem);
  }
}

class PostgresPendingStore {
  constructor(database) { this.database = database; }
  filenameFor(entry) { return `${entry.id}.${entry.ext}`; }

  async list() {
    const { rows } = await this.database.query(`SELECT ${MOMENT_COLUMNS} FROM labroute_moments
      WHERE status = 'pending' ORDER BY uploaded_at DESC, id DESC`);
    return rows.map(momentEntry);
  }

  async get(id) {
    const { rows } = await this.database.query(`SELECT ${MOMENT_COLUMNS} FROM labroute_moments
      WHERE status = 'pending' AND id = $1`, [id]);
    return momentEntry(rows[0]);
  }

  async readImage(entry) {
    const { rows } = await this.database.query(`SELECT image_data FROM labroute_moments
      WHERE id = $1 AND status = 'pending'`, [entry.id]);
    return rows[0]?.image_data || null;
  }

  async readUploadedImage(filename) {
    if (!/^[A-Za-z0-9_-]+\.(png|jpg|jpeg|gif|webp|bmp|avif)$/.test(filename)) return null;
    const { rows } = await this.database.query(`SELECT image_data FROM labroute_moments
      WHERE image_path = $1 AND status = 'approved'`, [`assets/gallery/moments/${filename}`]);
    return rows[0]?.image_data || null;
  }
}

module.exports = {
  createPostgresPool, databaseUrl, PostgresDatabase, PostgresGalleryStore, PostgresPendingStore
};
