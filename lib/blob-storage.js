'use strict';

/**
 * Persistent storage on Vercel via Vercel Blob.
 *
 * The local Node server keeps photos and JSON state on disk. That cannot work
 * on Vercel: a Function's deployment filesystem is read-only and `/tmp` is
 * thrown away when an instance is recycled. When a Blob store is connected to
 * the project (Vercel sets `BLOB_READ_WRITE_TOKEN`, or `BLOB_STORE_ID` with an
 * OIDC token), the stores in this project talk to the small interface below
 * instead of the filesystem, so the pending queue, approved photos, gallery
 * order and cooldown state survive cold starts and are shared by every
 * Function instance.
 *
 * The `@vercel/blob` SDK is required lazily: a plain `npm start` on a laptop
 * or a Node host never loads it, so local development still needs no install
 * step unless Blob storage is actually selected.
 */

const PREFIX = 'labroute';

const STATE_PATHS = {
  gallery: `${PREFIX}/state/gallery.json`,
  pending: `${PREFIX}/state/pending.json`,
  rateLimits: `${PREFIX}/state/rate-limits.json`
};

function pendingImagePath(filename) {
  return `${PREFIX}/pending/${filename}`;
}

function galleryImagePath(filename) {
  return `${PREFIX}/gallery/${filename}`;
}

/** True when the returned blob URL can be used directly as an <img src>. */
function isPublicBlobUrl(url) {
  return typeof url === 'string' && /\.public\.blob\.vercel-storage\.com\//.test(url);
}

function otherAccess(access) {
  return access === 'private' ? 'public' : 'private';
}

async function streamToBuffer(stream) {
  if (!stream) return Buffer.alloc(0);
  if (Buffer.isBuffer(stream)) return stream;

  // Web ReadableStream (what @vercel/blob returns) and Node streams are both
  // async-iterable on supported Node versions.
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * Wrap the official SDK in the tiny interface the stores need.
 *
 * `sdk` is injectable for tests. When omitted, `@vercel/blob` is loaded on
 * first use; if it is unavailable this returns null so callers can fall back
 * to local/ephemeral disk instead of crashing the whole API.
 */
function createBlobStorage(options = {}) {
  let sdk = options.sdk || null;
  let access = options.access === 'public' ? 'public' : 'private';
  let accessConfirmed = Boolean(options.access);

  function loadSdk() {
    if (sdk) return sdk;
    // Lazy + guarded: only Blob deployments need the dependency installed.
    sdk = require('@vercel/blob');
    return sdk;
  }

  if (!options.sdk) {
    try {
      loadSdk();
    } catch (error) {
      console.warn(
        `[labroute] Vercel Blob is configured but @vercel/blob could not be loaded (${error.message}); falling back to local storage.`
      );
      return null;
    }
  }

  /**
   * A Blob store is created as either private or public, and the SDK must be
   * told which. If the configured value does not match the store, retry once
   * with the other value and remember whatever worked.
   */
  async function withAccess(operation, confirmAccess = true) {
    try {
      const result = await operation(access);
      if (confirmAccess) accessConfirmed = true;
      return result;
    } catch (firstError) {
      const fallback = otherAccess(access);
      try {
        const result = await operation(fallback);
        access = fallback;
        if (confirmAccess) accessConfirmed = true;
        return result;
      } catch {
        throw firstError;
      }
    }
  }

  async function getBytes(pathname) {
    const { get } = loadSdk();

    const read = async (candidate) => {
      // useCache:false — JSON state must be read-after-write consistent, not
      // served from the Blob CDN cache.
      const result = await get(pathname, { access: candidate, useCache: false });
      if (!result || result.statusCode !== 200 || !result.stream) return null;
      return streamToBuffer(result.stream);
    };

    // A successful read of actual bytes proves the access level; a "not
    // found" (null) does not — the wrong level can look exactly like that.
    const buffer = await withAccess(read, false);
    if (buffer !== null) {
      accessConfirmed = true;
      return buffer;
    }

    if (!accessConfirmed) {
      const fallbackBuffer = await read(otherAccess(access)).catch(() => null);
      if (fallbackBuffer !== null) {
        access = otherAccess(access);
        accessConfirmed = true;
        return fallbackBuffer;
      }
    }

    return buffer;
  }

  async function putBytes(pathname, buffer, contentType) {
    const { put } = loadSdk();
    const result = await withAccess((candidate) =>
      put(pathname, buffer, {
        access: candidate,
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: contentType || undefined
      })
    );
    return { url: result?.url || '', pathname: result?.pathname || pathname };
  }

  async function getJson(pathname) {
    const buffer = await getBytes(pathname);
    if (!buffer) return null;

    const text = buffer.toString('utf8').trim();
    if (!text) return null;
    return JSON.parse(text);
  }

  async function putJson(pathname, value) {
    return putBytes(pathname, Buffer.from(`${JSON.stringify(value, null, 2)}\n`), 'application/json');
  }

  async function copyBytes(fromPathname, toPathname, contentType) {
    const buffer = await getBytes(fromPathname);
    if (!buffer) return null;
    return putBytes(toPathname, buffer, contentType);
  }

  async function remove(pathnameOrUrl) {
    if (!pathnameOrUrl) return;
    const { del } = loadSdk();
    await del(pathnameOrUrl);
  }

  return {
    kind: 'vercel-blob',
    get access() {
      return access;
    },
    getBytes,
    putBytes,
    getJson,
    putJson,
    copyBytes,
    delete: remove
  };
}

/**
 * In-memory implementation of the same interface. Used by the test suite to
 * prove the upload → review → approve workflow survives across separate app
 * instances (i.e. serverless cold starts) sharing one store.
 */
function createMemoryBlobStorage(options = {}) {
  const access = options.access === 'public' ? 'public' : 'private';
  const blobs = new Map();

  const urlFor = (pathname) =>
    `https://memory-store.${access}.blob.vercel-storage.com/${pathname}`;

  const pathnameFrom = (pathnameOrUrl) => {
    const value = String(pathnameOrUrl || '');
    if (!value.startsWith('https://')) return value;
    try {
      return new URL(value).pathname.replace(/^\/+/, '');
    } catch {
      return value;
    }
  };

  return {
    kind: 'memory-blob',
    access,
    blobs,
    async getBytes(pathname) {
      const entry = blobs.get(pathname);
      return entry ? Buffer.from(entry.buffer) : null;
    },
    async putBytes(pathname, buffer, contentType) {
      blobs.set(pathname, { buffer: Buffer.from(buffer), contentType: contentType || '' });
      return { url: urlFor(pathname), pathname };
    },
    async getJson(pathname) {
      const entry = blobs.get(pathname);
      if (!entry) return null;
      const text = entry.buffer.toString('utf8').trim();
      return text ? JSON.parse(text) : null;
    },
    async putJson(pathname, value) {
      const buffer = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
      blobs.set(pathname, { buffer, contentType: 'application/json' });
      return { url: urlFor(pathname), pathname };
    },
    async copyBytes(fromPathname, toPathname, contentType) {
      const entry = blobs.get(fromPathname);
      if (!entry) return null;
      blobs.set(toPathname, {
        buffer: Buffer.from(entry.buffer),
        contentType: contentType || entry.contentType
      });
      return { url: urlFor(toPathname), pathname: toPathname };
    },
    async delete(pathnameOrUrl) {
      blobs.delete(pathnameFrom(pathnameOrUrl));
    }
  };
}

function hasBlobCredentials(env = process.env) {
  if (env.BLOB_READ_WRITE_TOKEN) return true;
  // Connected stores authenticate with short-lived OIDC tokens on Vercel.
  return Boolean(env.BLOB_STORE_ID && env.VERCEL_OIDC_TOKEN);
}

module.exports = {
  STATE_PATHS,
  createBlobStorage,
  createMemoryBlobStorage,
  galleryImagePath,
  hasBlobCredentials,
  isPublicBlobUrl,
  pendingImagePath
};
