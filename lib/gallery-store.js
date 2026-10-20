'use strict';

const path = require('path');
const { atomicWriteJson, readJson } = require('./util');
const { STATE_PATHS, galleryImagePath } = require('./blob-storage');

const FALLBACK_CAPTION = 'A moment from the LabRoute engineering archive';
const BLOB_IMAGE_URL =
  /^https:\/\/[A-Za-z0-9.-]+\.blob\.vercel-storage\.com\/[A-Za-z0-9/._%~-]+$/;

const VERIFY_ATTEMPTS = 3;
const VERIFY_DELAY_MS = 150;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function galleryList(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.gallery)) return data.gallery;
  return null;
}

function isSafeImagePath(value) {
  if (typeof value !== 'string' || !value) return false;
  // Approved photos in a *public* Blob store are served straight from Blob.
  if (BLOB_IMAGE_URL.test(value)) return true;
  if (value.startsWith('assets/')) return !value.includes('..') && !value.includes('\\');
  return false;
}

function publicItem(item, index) {
  const caption =
    typeof item.caption === 'string' && item.caption.trim()
      ? item.caption.trim()
      : typeof item.title === 'string' && item.title.trim()
        ? item.title.trim()
        : FALLBACK_CAPTION;

  return {
    id: typeof item.id === 'string' && item.id ? item.id : `gallery-${index + 1}`,
    image: isSafeImagePath(item.image) ? item.image : '',
    caption,
    contributor: typeof item.contributor === 'string' ? item.contributor.trim() : '',
    uploadedAt: typeof item.uploadedAt === 'string' ? item.uploadedAt : null,
    uploaded: Boolean(item.uploaded || item.uploadedAt),
    tall: item.tall !== false
  };
}

class GalleryStore {
  constructor(config, blobStorage = null) {
    this.file = config.galleryFile;
    this.seedFile = config.gallerySeedFile || config.galleryFile;
    this.uploadDir = config.uploadDir;
    this.blob = blobStorage;
  }

  async readSeed() {
    const data = await readJson(this.seedFile, []);

    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.gallery)) return data.gallery;

    throw new Error('content/gallery.json must contain an array of gallery items.');
  }

  /**
   * Read the gallery plus where it came from.
   *
   * `source` is the fastest way to spot a silent fallback: when it is `seed`
   * the site is showing the photos committed to the repository, and any
   * approved photo is missing from storage — not merely hidden by the client.
   */
  async readState() {
    if (this.blob) {
      const stored = await this.blob.getJson(STATE_PATHS.gallery);
      // Until the first approval writes the Blob copy, serve the gallery
      // that is committed to the repository.
      if (stored === null || stored === undefined) {
        return { gallery: await this.readSeed(), source: 'seed' };
      }

      const storedList = galleryList(stored);
      if (!storedList) {
        throw new Error('The stored gallery must contain an array of gallery items.');
      }

      return { gallery: storedList, source: 'storage' };
    }

    // readJson returns the fallback only when the file is missing, which is
    // exactly the serverless first-run case (writable copy not created yet).
    const data = await readJson(this.file, null);
    if (data === null || data === undefined) {
      if (this.file === this.seedFile) return { gallery: [], source: 'empty' };
      return { gallery: await this.readSeed(), source: 'seed' };
    }

    const diskList = galleryList(data);
    if (!diskList) {
      throw new Error('content/gallery.json must contain an array of gallery items.');
    }

    return { gallery: diskList, source: 'storage' };
  }

  async read() {
    return (await this.readState()).gallery;
  }

  async add(item) {
    const gallery = await this.read();
    const withoutDuplicate = gallery.filter((entry) => entry && entry.id !== item.id);
    const next = [item, ...withoutDuplicate];

    if (!this.blob) {
      await atomicWriteJson(this.file, next);
      return next;
    }

    await this.blob.putJson(STATE_PATHS.gallery, next);

    // Read the state back before reporting success. An approval must never
    // claim the photo is live when the next request would not see it (a
    // silent Blob write failure is exactly how a photo "disappears later").
    let lastError = null;

    for (let attempt = 0; attempt < VERIFY_ATTEMPTS; attempt += 1) {
      try {
        const stored = galleryList(await this.blob.getJson(STATE_PATHS.gallery));
        if (stored && stored.some((entry) => entry && entry.id === item.id)) return next;
        lastError = new Error('The gallery state was written but could not be read back.');
      } catch (error) {
        lastError = error;
      }

      if (attempt < VERIFY_ATTEMPTS - 1) await sleep(VERIFY_DELAY_MS * (attempt + 1));
    }

    // Best effort: put the previous list back so a half-completed approval
    // does not leave an item in the gallery that the caller treated as failed.
    await this.blob.putJson(STATE_PATHS.gallery, gallery).catch(() => {});

    throw lastError || new Error('The gallery state could not be saved.');
  }

  async publicGallery() {
    const gallery = await this.read();
    return gallery.filter((item) => item && isSafeImagePath(item.image)).map(publicItem);
  }

  /** Public gallery items plus the source the list was read from. */
  async publicGalleryState() {
    const { gallery, source } = await this.readState();
    const items = gallery
      .filter((item) => item && isSafeImagePath(item.image))
      .map(publicItem);

    return { gallery: items, source };
  }

  async recentMoments(limit = 8) {
    const gallery = await this.publicGallery();
    return gallery.filter((item) => item.uploaded).slice(0, limit);
  }

  async removeImage(relativePath) {
    if (!isSafeImagePath(relativePath)) return;

    if (this.blob) {
      const target = BLOB_IMAGE_URL.test(relativePath)
        ? relativePath
        : galleryImagePath(path.basename(relativePath));
      await this.blob.delete(target).catch(() => {});
      return;
    }

    const prefix = 'assets/gallery/moments/';
    if (!relativePath.startsWith(prefix)) return;

    const file = path.join(this.uploadDir, path.basename(relativePath));
    const fsp = require('fs').promises;
    await fsp.rm(file, { force: true }).catch(() => {});
  }
}

module.exports = { GalleryStore, publicItem, isSafeImagePath };
