'use strict';

const path = require('path');
const { atomicWriteJson, readJson } = require('./util');
const { STATE_PATHS, galleryImagePath } = require('./blob-storage');

const FALLBACK_CAPTION = 'A moment from the LabRoute engineering archive';
const BLOB_IMAGE_URL =
  /^https:\/\/[A-Za-z0-9.-]+\.blob\.vercel-storage\.com\/[A-Za-z0-9/._%~-]+$/;

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

  async read() {
    if (this.blob) {
      const stored = await this.blob.getJson(STATE_PATHS.gallery);
      // Until the first approval writes the Blob copy, serve the gallery
      // that is committed to the repository.
      if (stored === null || stored === undefined) return this.readSeed();
      if (Array.isArray(stored)) return stored;
      if (stored && Array.isArray(stored.gallery)) return stored.gallery;
      throw new Error('The stored gallery must contain an array of gallery items.');
    }

    // readJson returns the fallback only when the file is missing, which is
    // exactly the serverless first-run case (writable copy not created yet).
    const data = await readJson(this.file, null);
    if (data === null || data === undefined) {
      return this.file === this.seedFile ? [] : this.readSeed();
    }

    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.gallery)) return data.gallery;

    throw new Error('content/gallery.json must contain an array of gallery items.');
  }

  async add(item) {
    const gallery = await this.read();
    const withoutDuplicate = gallery.filter((entry) => entry && entry.id !== item.id);
    const next = [item, ...withoutDuplicate];

    if (this.blob) {
      await this.blob.putJson(STATE_PATHS.gallery, next);
    } else {
      await atomicWriteJson(this.file, next);
    }
    return next;
  }

  async publicGallery() {
    const gallery = await this.read();
    return gallery.filter((item) => item && isSafeImagePath(item.image)).map(publicItem);
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
