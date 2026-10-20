'use strict';

const fsp = require('fs').promises;
const path = require('path');
const { atomicWriteJson, readJson } = require('./util');
const {
  STATE_PATHS,
  galleryImagePath,
  isPublicBlobUrl,
  pendingImagePath
} = require('./blob-storage');

const SAFE_FILENAME = /^[A-Za-z0-9._-]+$/;

/**
 * Photos waiting for an administrator to approve or decline them.
 *
 * Locally the files live in a private directory that the static server never
 * exposes. On Vercel they live in Blob storage under `labroute/pending/` and
 * are only ever streamed by the authenticated admin API. Either way, only an
 * admin can list or view them.
 */
class PendingStore {
  constructor(config, blobStorage = null) {
    this.dir = config.pendingDir;
    this.file = config.pendingFile;
    this.uploadDir = config.uploadDir;
    this.blob = blobStorage;
    this.items = [];
    this.loaded = false;
  }

  async load() {
    // Blob state is shared between Function instances, so never trust a
    // copy cached by an earlier request in this (warm) instance.
    if (this.blob) {
      // Deliberately no "start empty" fallback here: a transient Blob error
      // must fail the request, not make the next save() overwrite the real
      // pending queue with an empty one. A missing blob reads as null.
      const data = await this.blob.getJson(STATE_PATHS.pending);
      this.items = Array.isArray(data) ? data : Array.isArray(data?.pending) ? data.pending : [];
      this.loaded = true;
      return this.items;
    }

    if (this.loaded) return this.items;

    try {
      const data = await readJson(this.file, []);
      this.items = Array.isArray(data) ? data : Array.isArray(data?.pending) ? data.pending : [];
    } catch (error) {
      console.warn(`[labroute] Could not read pending uploads (${error.message}); starting empty.`);
      this.items = [];
    }

    this.loaded = true;
    return this.items;
  }

  async save() {
    if (this.blob) {
      await this.blob.putJson(STATE_PATHS.pending, this.items);
      return;
    }
    await fsp.mkdir(this.dir, { recursive: true });
    await atomicWriteJson(this.file, this.items);
  }

  async list() {
    await this.load();
    return [...this.items];
  }

  async get(id) {
    await this.load();
    return this.items.find((entry) => entry.id === id) || null;
  }

  async add(entry) {
    await this.load();
    this.items = [entry, ...this.items.filter((item) => item.id !== entry.id)];
    await this.save();
    return entry;
  }

  async remove(id) {
    await this.load();
    this.items = this.items.filter((item) => item.id !== id);
    await this.save();
  }

  filenameFor(entry) {
    return `${entry.id}.${entry.ext}`;
  }

  absolutePath(entry) {
    const filename = this.filenameFor(entry);
    if (!SAFE_FILENAME.test(filename)) return null;
    return path.join(this.dir, filename);
  }

  /** Store a freshly uploaded photo in the private pending area. */
  async writeImage(entry, buffer) {
    if (this.blob) {
      await this.blob.putBytes(
        pendingImagePath(this.filenameFor(entry)),
        buffer,
        entry.mime || undefined
      );
      return;
    }

    const file = this.absolutePath(entry);
    if (!file) throw new Error('Unsafe pending filename.');
    await fsp.mkdir(this.dir, { recursive: true });
    await fsp.writeFile(file, buffer, { mode: 0o600, flag: 'wx' });
  }

  /** Read a pending photo back (admin preview / approval). */
  async readImage(entry) {
    if (this.blob) {
      return this.blob.getBytes(pendingImagePath(this.filenameFor(entry)));
    }

    const file = this.absolutePath(entry);
    if (!file) return null;
    try {
      return await fsp.readFile(file);
    } catch {
      return null;
    }
  }

  /** Read an already-approved photo by filename (public gallery serving). */
  async readUploadedImage(filename) {
    const name = path.basename(String(filename || ''));
    if (!name || !SAFE_FILENAME.test(name)) return null;

    if (this.blob) {
      return this.blob.getBytes(galleryImagePath(name));
    }

    try {
      return await fsp.readFile(path.join(this.uploadDir, name));
    } catch {
      return null;
    }
  }

  /**
   * Approve-time move into the public gallery.
   *
   * Returns the value to store as the gallery item's `image`: the Blob URL
   * itself for a public store, otherwise the usual
   * `assets/gallery/moments/<file>` path, which the server serves from disk
   * (locally / ephemeral `/tmp`) or streams out of a private Blob store.
   */
  async moveToUploadDir(entry, uploadDir) {
    const filename = this.filenameFor(entry);
    const publicImage = `assets/gallery/moments/${filename}`;

    if (this.blob) {
      const copied = await this.blob.copyBytes(
        pendingImagePath(filename),
        galleryImagePath(filename),
        entry.mime || undefined
      );
      if (!copied) throw new Error('The pending photo could not be found in storage.');
      await this.blob.delete(pendingImagePath(filename)).catch(() => {});
      return { image: isPublicBlobUrl(copied.url) ? copied.url : publicImage, url: copied.url || '' };
    }

    const source = this.absolutePath(entry);
    if (!source) throw new Error('Unsafe pending filename.');

    const target = path.join(uploadDir, filename);
    await fsp.mkdir(uploadDir, { recursive: true });

    try {
      await fsp.rename(source, target);
    } catch (error) {
      if (error.code !== 'EXDEV') throw error;
      await fsp.copyFile(source, target);
      await fsp.rm(source, { force: true });
    }

    // Approved photos are served publicly; keep them readable by the server.
    await fsp.chmod(target, 0o644).catch(() => {});

    return { image: publicImage, url: '' };
  }

  async moveBack(entry, uploadDir) {
    const filename = this.filenameFor(entry);

    if (this.blob) {
      const copied = await this.blob
        .copyBytes(galleryImagePath(filename), pendingImagePath(filename), entry.mime || undefined)
        .catch(() => null);
      if (copied) await this.blob.delete(galleryImagePath(filename)).catch(() => {});
      return;
    }

    const source = path.join(uploadDir, filename);
    const target = this.absolutePath(entry);
    if (!target) return;

    try {
      await fsp.rename(source, target);
    } catch {
      // The original file is gone; nothing else to restore.
    }
  }

  async deleteFile(entry) {
    if (this.blob) {
      await this.blob.delete(pendingImagePath(this.filenameFor(entry))).catch(() => {});
      return;
    }
    const target = this.absolutePath(entry);
    if (target) await fsp.rm(target, { force: true });
  }
}

module.exports = { PendingStore };
