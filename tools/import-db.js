#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { GalleryStore, isSafeImagePath, orderGallery, isMomentItem } = require('../lib/gallery-store');
const { PendingStore } = require('../lib/pending-store');
const { createBlobStorage, STATE_PATHS } = require('../lib/blob-storage');
const { detectImageType } = require('../lib/image');
const { readJson, readJsonLines } = require('../lib/util');

async function contentDocuments(dir, prefix = '') {
  const documents = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) documents.push(...await contentDocuments(path.join(dir, entry.name), relative));
    else if (entry.isFile() && entry.name.endsWith('.json') && relative !== 'gallery.json') {
      documents.push([relative, JSON.parse(await fs.readFile(path.join(dir, entry.name), 'utf8'))]);
    }
  }
  return documents;
}

async function readOptional(file) {
  try { return await fs.readFile(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

/**
 * Non-destructive, transactional, repeatable import. Sources are NEVER removed.
 * Content is refreshed deliberately; existing admin credentials and photo review
 * decisions in PostgreSQL win over stale local/Blob copies, even on a retry.
 */
async function importDatabase({ pool, config, blobStorage = null, refreshContent = true, initializeOnly = false }) {
  if (initializeOnly && blobStorage) {
    throw new Error('Production build initialization only imports repository seeds, not legacy Blob storage.');
  }
  if (initializeOnly) {
    const { rows } = await pool.query("SELECT 1 FROM labroute_settings WHERE key = 'data_import_complete'");
    // Do not even read stale seed files after successful initialization.
    if (rows.length) return null;
  }
  const galleryStore = new GalleryStore(config, blobStorage);
  const pendingStore = new PendingStore(config, blobStorage);
  const gallery = orderGallery(await (initializeOnly ? galleryStore.readSeed() : galleryStore.read()));
  const pending = initializeOnly ? [] : await pendingStore.list();
  const documents = await contentDocuments(config.contentDir);
  const adminData = await readJson(config.adminsFile, { admins: [] });
  const admins = Array.isArray(adminData) ? adminData : adminData.admins || [];
  const rateData = initializeOnly ? null : blobStorage
    ? await blobStorage.getJson(STATE_PATHS.rateLimits)
    : await readJson(config.rateLimitFile, {});
  const notifications = initializeOnly ? [] : await readJsonLines(config.notificationsFile, 0);
  const secret = initializeOnly ? null : await readOptional(path.join(config.runtimeDir, 'secret.key'));
  if (initializeOnly && (!admins.length || !documents.length)) {
    throw new Error('Repository admin/content seeds are missing or empty; refusing to mark an unusable database initialized.');
  }

  const counts = { admins: 0, documents: 0, gallery: 0, pending: 0, rateEvents: 0, notifications: 0 };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('labroute:import', 0))");
    if (initializeOnly) {
      // Another production build may have initialized while we read the seeds.
      const { rows } = await client.query("SELECT 1 FROM labroute_settings WHERE key = 'data_import_complete'");
      if (rows.length) {
        await client.query('COMMIT');
        return null;
      }
    }
    await client.query(`INSERT INTO labroute_settings (key, value) VALUES ('cookie_secret', $1)
      ON CONFLICT (key) DO NOTHING`,
    [config.secretConfigured ? config.secret : secret?.toString().trim() || crypto.randomBytes(32).toString('hex')]);

    for (const admin of admins) {
      const result = await client.query(`INSERT INTO labroute_admins (email, password_hash) VALUES ($1, $2)
        ON CONFLICT (email) DO NOTHING`, [String(admin.email).trim().toLowerCase(), String(admin.passwordCrypt).toLowerCase()]);
      counts.admins += result.rowCount;
    }
    for (const [documentPath, body] of documents) {
      const result = await client.query(`INSERT INTO labroute_documents (path, body) VALUES ($1, $2::jsonb)
        ON CONFLICT (path) ${refreshContent && !initializeOnly ? 'DO UPDATE SET body = EXCLUDED.body, updated_at = now()' : 'DO NOTHING'}`,
      [documentPath, JSON.stringify(body)]);
      counts.documents += result.rowCount;
    }

    for (const [index, item] of gallery.entries()) {
      if (!item?.id || !isSafeImagePath(item.image)) throw new Error('Invalid gallery item; import stopped without deleting any source data.');
      // Do not read expired legacy images if a previous import already saved them.
      const exists = await client.query('SELECT id FROM labroute_moments WHERE id = $1', [item.id]);
      if (exists.rows.length) continue;
      let buffer = null;
      let imagePath = item.image;
      let type = null;
      const community = isMomentItem(item);
      if (community) {
        if (blobStorage) {
          const blobPath = item.image.startsWith('https://')
            ? new URL(item.image).pathname.replace(/^\/+/, '')
            : `labroute/gallery/${path.basename(item.image)}`;
          buffer = await blobStorage.getBytes(blobPath);
        }
        if (!buffer && item.image.startsWith('assets/')) {
          const filename = path.basename(item.image);
          buffer = await readOptional(path.join(config.uploadDir, filename)) ||
            await readOptional(path.join(config.rootDir, item.image));
        }
        if (!buffer) throw new Error(`Missing approved photo ${item.id}. Restore its source image and retry; nothing was deleted.`);
        type = detectImageType(buffer);
        if (!type) throw new Error(`Unsupported approved image ${item.id}.`);
        imagePath = `assets/gallery/moments/${item.id}.${type.ext}`;
      }
      const result = await client.query(`INSERT INTO labroute_moments
        (id, status, caption, contributor, image_path, image_data, ext, mime,
         width, height, bytes, tall, uploaded, uploaded_at, approved_at, archive_order)
        VALUES ($1, 'approved', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        ON CONFLICT DO NOTHING`,
      [item.id, item.caption || item.title || 'LabRoute archive', item.contributor || '', imagePath,
        buffer, type?.ext || null, type?.mime || null, item.width || null, item.height || null,
        buffer?.length || item.bytes || 0, item.tall !== false, community,
        item.uploadedAt || null, item.approvedAt || null, index]);
      counts.gallery += result.rowCount;
    }

    for (const item of pending) {
      if (!/^[A-Za-z0-9_-]{4,80}$/.test(item.id) || !/^(png|jpg|jpeg|webp|gif|bmp|avif)$/.test(item.ext)) {
        throw new Error('Unsafe pending image filename; import stopped.');
      }
      const exists = await client.query('SELECT id FROM labroute_moments WHERE id = $1', [item.id]);
      if (exists.rows.length) continue;
      const buffer = await pendingStore.readImage(item);
      if (!buffer) throw new Error(`Missing pending photo ${item.id}. Recover the file before migrating; nothing was deleted.`);
      const type = detectImageType(buffer);
      if (!type) throw new Error(`Unsupported pending image ${item.id}.`);
      const result = await client.query(`INSERT INTO labroute_moments
        (id, status, caption, contributor, image_data, ext, mime, width, height, bytes, uploaded, uploaded_at)
        VALUES ($1, 'pending', $2, $3, $4, $5, $6, $7, $8, $9, true, $10) ON CONFLICT DO NOTHING`,
      [item.id, item.caption, item.contributor || '', buffer, type.ext, type.mime,
        item.width || null, item.height || null, buffer.length, item.uploadedAt || new Date().toISOString()]);
      counts.pending += result.rowCount;
    }

    const cutoff = Date.now() - config.rateLimit.retentionMs;
    for (const [key, events] of Object.entries(rateData?.entries || {})) {
      if (!Array.isArray(events)) continue;
      for (const [index, timestamp] of events.entries()) {
        if (!Number.isFinite(timestamp) || timestamp < cutoff) continue;
        const result = await client.query(`INSERT INTO labroute_rate_events (key, occurred_at, event_id)
          VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [key, timestamp, `legacy:${timestamp}:${index}`]);
        counts.rateEvents += result.rowCount;
      }
    }
    for (const [index, entry] of notifications.entries()) {
      const sourceKey = crypto.createHash('sha256').update(`${index}|${JSON.stringify(entry)}`).digest('hex');
      const result = await client.query(`INSERT INTO labroute_notifications (source_key, created_at, body)
        VALUES ($1, $2, $3::jsonb) ON CONFLICT DO NOTHING`,
      [sourceKey, entry.at || new Date().toISOString(), JSON.stringify(entry)]);
      counts.notifications += result.rowCount;
    }
    await client.query(`INSERT INTO labroute_settings (key, value) VALUES ('data_import_complete', $1)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [new Date().toISOString()]);
    await client.query('COMMIT');
    return counts;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

function legacyBlob() {
  const blob = createBlobStorage();
  if (!blob) throw new Error('Legacy Blob import requires @vercel/blob and BLOB_READ_WRITE_TOKEN.');
  return blob;
}

module.exports = { importDatabase, legacyBlob, contentDocuments };

if (require.main === module) {
  require('./migrate-db').run({ importOnly: true }).catch(require('./migrate-db').reportFailure);
}
