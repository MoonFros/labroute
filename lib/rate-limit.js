'use strict';

const { atomicWriteJson, readJson } = require('./util');
const { STATE_PATHS } = require('./blob-storage');

/**
 * Persistent, privacy-friendly rate limiting.
 *
 * Keys are already hashed by the moments service before they reach this class,
 * so no raw IP addresses or visitor identifiers are written to disk.
 */
class RateLimitStore {
  constructor(file, options = {}, blobStorage = null) {
    this.file = file;
    this.blob = blobStorage || options.blobStorage || null;
    this.cooldownMs = options.cooldownMs || 30 * 60 * 1000;
    this.windowMs = options.windowMs || this.cooldownMs;
    this.ipLimit = options.ipLimit || 8;
    this.retentionMs = options.retentionMs || 24 * 60 * 60 * 1000;
    this.maxKeys = options.maxKeys || 5000;
    this.entries = {};
    this.loaded = false;
  }

  async load() {
    // Shared Blob state must be re-read per request: another Function
    // instance may have recorded an upload since this instance last looked.
    if (this.blob) {
      // Let Blob read errors fail the request rather than resetting (and
      // later overwriting) everyone's cooldown state.
      const data = await this.blob.getJson(STATE_PATHS.rateLimits);
      this.entries = data && typeof data.entries === 'object' && data.entries ? data.entries : {};
      this.loaded = true;
      return;
    }

    if (this.loaded) return;

    try {
      const data = await readJson(this.file, {});
      this.entries = data && typeof data.entries === 'object' && data.entries ? data.entries : {};
    } catch (error) {
      console.warn(`[labroute] Could not read rate-limit state (${error.message}); resetting it.`);
      this.entries = {};
    }

    this.loaded = true;
  }

  prune(now) {
    const cutoff = now - this.retentionMs;

    for (const [key, events] of Object.entries(this.entries)) {
      if (!Array.isArray(events)) {
        delete this.entries[key];
        continue;
      }

      const fresh = events.filter((timestamp) => Number.isFinite(timestamp) && timestamp >= cutoff);
      if (fresh.length) {
        this.entries[key] = fresh;
      } else {
        delete this.entries[key];
      }
    }

    const keys = Object.keys(this.entries);
    if (keys.length > this.maxKeys) {
      keys
        .sort((a, b) => {
          const aLast = this.entries[a][this.entries[a].length - 1] || 0;
          const bLast = this.entries[b][this.entries[b].length - 1] || 0;
          return aLast - bLast;
        })
        .slice(0, keys.length - this.maxKeys)
        .forEach((key) => delete this.entries[key]);
    }
  }

  check(keys, ipKey, now = Date.now()) {
    this.prune(now);

    let nextAllowedAt = null;
    let reason = null;

    for (const key of keys) {
      const events = this.entries[key];
      if (!events || !events.length) continue;

      const last = events[events.length - 1];
      if (now - last < this.cooldownMs) {
        const candidate = last + this.cooldownMs;
        if (nextAllowedAt === null || candidate > nextAllowedAt) nextAllowedAt = candidate;
        reason = 'visitor';
      }
    }

    if (ipKey) {
      const events = this.entries[ipKey];
      if (events) {
        const recent = events.filter((timestamp) => now - timestamp < this.windowMs);
        if (recent.length >= this.ipLimit) {
          const candidate = recent[0] + this.windowMs;
          if (nextAllowedAt === null || candidate > nextAllowedAt) nextAllowedAt = candidate;
          reason = reason || 'network';
        }
      }
    }

    if (nextAllowedAt !== null) {
      return {
        allowed: false,
        reason,
        nextAllowedAt,
        retryAfterSeconds: Math.max(1, Math.ceil((nextAllowedAt - now) / 1000))
      };
    }

    return { allowed: true, reason: null, nextAllowedAt: null, retryAfterSeconds: 0 };
  }

  record(keys, ipKey, now = Date.now()) {
    for (const key of new Set(keys)) {
      if (!this.entries[key]) this.entries[key] = [];
      this.entries[key].push(now);
    }

    if (ipKey) {
      if (!this.entries[ipKey]) this.entries[ipKey] = [];
      this.entries[ipKey].push(now);
    }
  }

  async save() {
    const payload = {
      version: 1,
      updatedAt: new Date().toISOString(),
      entries: this.entries
    };

    if (this.blob) {
      await this.blob.putJson(STATE_PATHS.rateLimits, payload);
      return;
    }

    await atomicWriteJson(this.file, payload);
  }
}

module.exports = { RateLimitStore };
