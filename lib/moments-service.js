'use strict';

const { HttpError, Mutex, cleanText, hmac, randomHex } = require('./util');
const { decodeImageDataUrl } = require('./image');
const { isSafeImagePath, publicItem } = require('./gallery-store');

/**
 * Owns the upload review workflow:
 *   1. validate the visitor's contribution,
 *   2. enforce the per-visitor and per-network cooldowns,
 *   3. store the photo in the private pending folder for an admin decision,
 *   4. on approval, move it into the public gallery and shift every photo right.
 *
 * The mutex makes each check-and-write sequence atomic inside the Node process.
 */
class MomentsService {
  constructor({ config, galleryStore, rateLimits, pendingStore }) {
    this.config = config;
    this.galleryStore = galleryStore;
    this.rateLimits = rateLimits;
    this.pendingStore = pendingStore;
    this.mutex = new Mutex();

    // Blob-backed deployments have no pending folder to create (and the
    // deployment filesystem is read-only anyway).
    if (!pendingStore.blob) {
      try {
        require('fs').mkdirSync(config.pendingDir, { recursive: true });
      } catch (error) {
        console.warn(`[labroute] Could not create the pending folder: ${error.message}`);
      }
    }
  }

  identityKeys(identity) {
    const secret = this.config.secret;
    const keys = [
      `visitor:${hmac(`visitor|${identity.visitorId}`, secret).slice(0, 32)}`
    ];

    if (identity.deviceId) {
      keys.push(`device:${hmac(`device|${identity.deviceId}`, secret).slice(0, 32)}`);
    } else {
      // Browser storage and cookies can both be wiped. Falling back to a
      // hashed network + browser signature keeps the cooldown meaningful.
      keys.push(
        `fingerprint:${hmac(
          `fingerprint|${identity.ip}|${identity.userAgent}`,
          secret
        ).slice(0, 32)}`
      );
    }

    const ipKey = identity.ip
      ? `ip:${hmac(`ip|${identity.ip}`, secret).slice(0, 32)}`
      : null;

    return { keys, ipKey };
  }

  cooldownPayload(status, now = Date.now()) {
    const nextAllowedAt = status.nextAllowedAt || null;

    return {
      canUpload: status.allowed,
      reason: status.reason || null,
      cooldownMinutes: this.config.cooldownMinutes,
      cooldownSeconds: Math.round(this.config.rateLimit.cooldownMs / 1000),
      nextAllowedAt: nextAllowedAt ? new Date(nextAllowedAt).toISOString() : null,
      retryAfterSeconds: status.retryAfterSeconds || 0,
      maxUploadBytes: this.config.maxUploadBytes,
      captionMaxLength: this.config.captionMaxLength
    };
  }

  async getStatus(identity, now = Date.now()) {
    return this.mutex.run(async () => {
      await this.rateLimits.load();
      const { keys, ipKey } = this.identityKeys(identity);
      const status = this.rateLimits.check(keys, ipKey, now);
      return this.cooldownPayload(status, now);
    });
  }

  pendingItem(entry, index = 0) {
    return {
      id: entry.id,
      caption: entry.caption,
      contributor: entry.contributor || '',
      uploadedAt: entry.uploadedAt || null,
      width: entry.width || null,
      height: entry.height || null,
      bytes: entry.bytes || 0,
      image: `/api/admin/pending/${encodeURIComponent(entry.id)}/image`,
      position: index + 1
    };
  }

  async listPending() {
    const items = await this.pendingStore.list();
    return items.map((entry, index) => this.pendingItem(entry, index));
  }

  async getPendingFile(id) {
    const entry = await this.pendingStore.get(id);
    if (!entry) {
      throw new HttpError(404, 'pending_not_found', 'That pending photo no longer exists.');
    }

    const buffer = await this.pendingStore.readImage(entry).catch(() => null);
    if (!buffer) {
      throw new HttpError(404, 'pending_not_found', 'That pending photo no longer exists.');
    }

    return { buffer, mime: entry.mime || 'application/octet-stream' };
  }

  /** Approved photo bytes for public serving (Blob / ephemeral disk). */
  async getUploadedFile(filename) {
    const buffer = await this.pendingStore.readUploadedImage(filename).catch(() => null);
    if (!buffer) return null;

    const ext = String(filename).split('.').pop().toLowerCase();
    const mime =
      ext === 'png'
        ? 'image/png'
        : ext === 'webp'
          ? 'image/webp'
          : ext === 'gif'
            ? 'image/gif'
            : ext === 'bmp'
              ? 'image/bmp'
              : 'image/jpeg';
    return { buffer, mime };
  }

  /**
   * The exact record to commit to `content/gallery.json`.
   *
   * This is the manual-publish path: the admin downloads the photo and this
   * JSON, commits both to the repository, and the next deployment serves the
   * image as a normal static file. No Blob store, no /tmp, nothing to expire.
   */
  publishedItem(entry) {
    const filename = this.pendingStore.filenameFor(entry);

    return {
      id: entry.id,
      image: `assets/gallery/moments/${filename}`,
      caption: entry.caption,
      contributor: entry.contributor || '',
      uploadedAt: entry.uploadedAt || null,
      tall: true
    };
  }

  async createMoment(input, identity, now = Date.now()) {
    if (cleanText(input?.website || '', 80)) {
      throw new HttpError(400, 'spam_rejected', 'This submission could not be accepted.');
    }

    if (input?.consent !== true) {
      throw new HttpError(
        400,
        'consent_required',
        'Please confirm that you have permission to share this photo.'
      );
    }

    const caption = cleanText(input?.caption || '', this.config.captionMaxLength);
    if (caption.length < 3) {
      throw new HttpError(
        400,
        'caption_required',
        'Please add a short caption so visitors know what the moment shows.'
      );
    }

    const contributor = cleanText(
      input?.contributor || '',
      this.config.contributorMaxLength
    );

    const image = decodeImageDataUrl(input?.image, this.config);
    // Unguessable enough to sit in object storage pending review.
    const id = `moment-${Date.now().toString(36)}-${randomHex(8)}`;
    const uploadedAt = new Date(now).toISOString();

    const entry = {
      id,
      ext: image.ext,
      mime: image.mime,
      caption,
      contributor,
      uploadedAt,
      width: image.width,
      height: image.height,
      bytes: image.bytes
    };

    return this.mutex.run(async () => {
      await this.rateLimits.load();

      const { keys, ipKey } = this.identityKeys(identity);
      const limit = this.rateLimits.check(keys, ipKey, now);

      if (!limit.allowed) {
        throw new HttpError(
          429,
          'cooldown_active',
          limit.reason === 'network'
            ? 'Too many moments were shared from this network recently. Please try again shortly.'
            : 'You have already shared a moment. Please wait before uploading another one.',
          this.cooldownPayload(limit, now)
        );
      }

      try {
        await this.pendingStore.writeImage(entry, image.buffer);
      } catch (error) {
        throw new HttpError(
          503,
          'storage_unavailable',
          'The photo could not be saved right now. Please try again in a moment.'
        );
      }

      try {
        await this.pendingStore.add(entry);
      } catch (error) {
        await this.pendingStore.deleteFile(entry).catch(() => {});
        throw new HttpError(
          503,
          'storage_unavailable',
          'The photo could not be saved right now. Please try again in a moment.'
        );
      }

      this.rateLimits.record(keys, ipKey, now);
      try {
        await this.rateLimits.save();
      } catch (error) {
        // The in-memory limiter still protects this process. A read-only disk
        // should not turn a successfully received photo into an error.
        console.warn(`[labroute] Could not persist rate-limit state: ${error.message}`);
      }

      const after = this.rateLimits.check(keys, ipKey, now);
      const pending = await this.listPending();

      return {
        moment: this.pendingItem(entry, 0),
        pendingCount: pending.length,
        cooldown: this.cooldownPayload(
          after.allowed
            ? {
                allowed: false,
                reason: 'visitor',
                nextAllowedAt: now + this.config.rateLimit.cooldownMs,
                retryAfterSeconds: Math.ceil(this.config.rateLimit.cooldownMs / 1000)
              }
            : after,
          now
        )
      };
    });
  }

  async approvePending(id, now = Date.now()) {
    return this.mutex.run(async () => {
      const entry = await this.pendingStore.get(id);

      if (!entry) {
        throw new HttpError(404, 'pending_not_found', 'That pending photo no longer exists.');
      }

      let moved;
      try {
        moved = await this.pendingStore.moveToUploadDir(entry, this.config.uploadDir);
      } catch (error) {
        throw new HttpError(
          503,
          'storage_unavailable',
          'The photo could not be moved into the gallery. Please try again.'
        );
      }

      const relativeImage =
        (moved && typeof moved === 'object' && moved.image) ||
        `${this.config.publicUploadPrefix.replace(/^\/+/, '')}/${this.pendingStore.filenameFor(entry)}`;
      const galleryItem = {
        id: entry.id,
        image: relativeImage,
        caption: entry.caption,
        contributor: entry.contributor || '',
        uploaded: true,
        uploadedAt: entry.uploadedAt || new Date(now).toISOString(),
        approvedAt: new Date(now).toISOString(),
        width: entry.width || null,
        height: entry.height || null,
        bytes: entry.bytes || 0,
        tall: true
      };

      let gallery;
      try {
        const next = await this.galleryStore.add(galleryItem);
        gallery = next
          .filter((item) => item && isSafeImagePath(item.image))
          .map(publicItem);
      } catch (error) {
        await this.pendingStore.moveBack(entry, this.config.uploadDir);
        throw new HttpError(
          503,
          'gallery_unavailable',
          'The gallery could not be updated right now. Please try again.'
        );
      }

      await this.pendingStore.remove(id);
      const pending = await this.listPending();

      return {
        moment: publicItem(galleryItem, 0),
        gallery,
        galleryCount: gallery.length,
        pendingCount: pending.length
      };
    });
  }

  /**
   * The admin has committed the photo to the repository themselves: drop it
   * from the review queue without writing anything to the live gallery (the
   * repository is now the source of truth for that photo).
   */
  async publishPending(id) {
    return this.mutex.run(async () => {
      const entry = await this.pendingStore.get(id);

      if (!entry) {
        throw new HttpError(404, 'pending_not_found', 'That pending photo no longer exists.');
      }

      const item = this.publishedItem(entry);
      await this.pendingStore.deleteFile(entry);
      await this.pendingStore.remove(id);

      const pending = await this.listPending();

      return {
        id,
        item,
        pendingCount: pending.length
      };
    });
  }

  async rejectPending(id) {
    return this.mutex.run(async () => {
      const entry = await this.pendingStore.get(id);

      if (!entry) {
        throw new HttpError(404, 'pending_not_found', 'That pending photo no longer exists.');
      }

      await this.pendingStore.deleteFile(entry);
      await this.pendingStore.remove(id);

      const pending = await this.listPending();

      return {
        id,
        pendingCount: pending.length
      };
    });
  }
}

module.exports = { MomentsService };
