#!/usr/bin/env node
'use strict';

/**
 * Publish a reviewed photo without any storage service.
 *
 * The admin dashboard offers two downloads per pending photo: the image and a
 * JSON record. This script takes both, copies the image into
 * `assets/gallery/moments/`, and prepends the record to `content/gallery.json`.
 * Committing the result makes the photo a normal static file of the site:
 * Vercel checks the filesystem before applying rewrites, so it is served
 * straight from the deployment and cannot expire.
 *
 * Usage:
 *   node tools/publish-moment.js <photo.jpg> --metadata <record.json>
 *   node tools/publish-moment.js <photo.jpg> --caption "Bench work" \
 *        [--contributor "Ada"] [--id moment-abc123] [--tall] [--force]
 *
 * Flags:
 *   --metadata <file>   JSON downloaded from /api/admin/pending/<id>/metadata
 *   --caption <text>    Caption when no metadata file is given (required then)
 *   --contributor <t>   Contributor name (default: anonymous)
 *   --id <id>           Gallery id (default: derived from the filename)
 *   --root <dir>        Project root (default: the current directory)
 *   --force             Overwrite an existing image file with the same id
 *   --dry-run           Print what would change without writing anything
 */

const fsp = require('fs').promises;
const path = require('path');

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{3,79}$/;
const CAPTION_MAX = 160;
const CONTRIBUTOR_MAX = 60;

function fail(message) {
  const error = new Error(message);
  error.userFacing = true;
  throw error;
}

function parseArgs(argv) {
  const args = { positional: [] };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (!token.startsWith('--')) {
      args.positional.push(token);
      continue;
    }

    const key = token.slice(2);
    const wantsValue = ['metadata', 'caption', 'contributor', 'id', 'root'].includes(key);

    if (wantsValue) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) fail(`--${key} needs a value.`);
      args[key] = value;
      index += 1;
      continue;
    }

    args[key] = true;
  }

  return args;
}

function galleryList(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.gallery)) return data.gallery;
  return null;
}

function slugFromFilename(file) {
  const base = path.basename(file, path.extname(file));
  const cleaned = base.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned.length >= 4 ? cleaned.slice(0, 80) : '';
}

function defaultId(file) {
  const fromName = slugFromFilename(file);
  if (fromName && SAFE_ID.test(fromName)) return fromName;

  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  return `moment-${stamp}`;
}

function normaliseText(value, max) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * Copy the photo in and prepend its record to content/gallery.json.
 * Exported so the test suite can exercise it without spawning a process.
 */
async function publishMoment(options) {
  const root = path.resolve(options.root || process.cwd());
  const galleryFile = path.join(root, 'content', 'gallery.json');
  const momentsDir = path.join(root, 'assets', 'gallery', 'moments');

  if (!options.imagePath) fail('Give the photo to publish: node tools/publish-moment.js <photo.jpg>');

  const imagePath = path.resolve(options.imagePath);
  const extension = path.extname(imagePath).toLowerCase();

  if (!IMAGE_EXTENSIONS.has(extension)) {
    fail(`Unsupported image type "${extension}". Use JPEG, PNG, WebP or GIF.`);
  }

  let stat;
  try {
    stat = await fsp.stat(imagePath);
  } catch {
    fail(`Could not find the photo at ${imagePath}`);
  }
  if (!stat.isFile() || stat.size === 0) fail(`The photo at ${imagePath} is empty.`);

  let metadata = null;
  if (options.metadata) {
    try {
      metadata = JSON.parse(await fsp.readFile(path.resolve(options.metadata), 'utf8'));
    } catch (error) {
      fail(`Could not read the metadata file (${error.message}).`);
    }
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      fail('The metadata file must contain a single gallery record.');
    }
  }

  const caption = normaliseText(options.caption ?? metadata?.caption, CAPTION_MAX);
  if (caption.length < 3) {
    fail('A caption is required: pass --caption "..." or --metadata <record.json>.');
  }

  const contributor = normaliseText(
    options.contributor ?? metadata?.contributor,
    CONTRIBUTOR_MAX
  );
  const id = String(options.id ?? metadata?.id ?? defaultId(imagePath));

  if (!SAFE_ID.test(id)) {
    fail(`"${id}" is not a usable gallery id. Use letters, digits, "-" and "_".`);
  }

  const targetFile = path.join(momentsDir, `${id}${extension}`);

  if (!options.force) {
    const exists = await fsp
      .stat(targetFile)
      .then((entry) => entry.isFile())
      .catch(() => false);
    if (exists) fail(`${path.relative(root, targetFile)} already exists. Use --force to overwrite.`);
  }

  let existing;
  try {
    existing = galleryList(JSON.parse(await fsp.readFile(galleryFile, 'utf8')));
  } catch (error) {
    fail(`Could not read content/gallery.json (${error.message}).`);
  }
  if (!existing) fail('content/gallery.json must contain an array of gallery records.');

  const item = {
    id,
    image: `assets/gallery/moments/${id}${extension}`,
    caption,
    contributor,
    uploadedAt: metadata?.uploadedAt || new Date().toISOString(),
    tall: metadata?.tall !== false && options.tall !== false
  };

  const next = [item, ...existing.filter((entry) => entry && entry.id !== id)];
  const alreadyListed = existing.some((entry) => entry && entry.id === id);

  if (options.dryRun) {
    return {
      root,
      id,
      item,
      targetFile,
      galleryFile,
      bytes: stat.size,
      alreadyListed,
      galleryCount: next.length,
      written: false
    };
  }

  await fsp.mkdir(momentsDir, { recursive: true });

  // copyFile keeps the download untouched; the repo gets its own copy.
  if (path.resolve(targetFile) !== imagePath) {
    await fsp.copyFile(imagePath, targetFile);
  }

  const temporary = `${galleryFile}.${process.pid}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`);
  await fsp.rename(temporary, galleryFile);

  return {
    root,
    id,
    item,
    targetFile,
    galleryFile,
    bytes: stat.size,
    alreadyListed,
    galleryCount: next.length,
    written: true
  };
}

function relative(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

function printResult(result) {
  const { root } = result;

  console.log('');
  if (!result.written) {
    console.log('  Dry run — nothing was written.');
  } else {
    console.log('  Photo published to the repository.');
  }
  console.log('  ────────────────────────────────────────────');
  const size = result.bytes < 1024 ? '<1' : String(Math.round(result.bytes / 1024));
  console.log(`  Image:    ${relative(root, result.targetFile)} (${size} KB)`);
  console.log(`  Gallery:  content/gallery.json → ${result.galleryCount} photo(s)`);
  console.log(`  Caption:  ${result.item.caption}`);
  console.log(`  By:       ${result.item.contributor || 'Anonymous contributor'}`);
  if (result.alreadyListed) {
    console.log('  Note:     that id was already in the gallery list; it was refreshed.');
  }
  console.log('');
  console.log('  Commit it:');
  console.log(
    `    git add ${relative(root, result.targetFile)} content/gallery.json && \\`
  );
  console.log(`    git commit -m "gallery: publish ${result.id}" && git push`);
  console.log('');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(
      'Usage: node tools/publish-moment.js <photo.jpg> [--metadata record.json] [--caption "..."]'
    );
    return;
  }

  try {
    const result = await publishMoment({
      imagePath: args.positional[0],
      metadata: args.metadata,
      caption: args.caption,
      contributor: args.contributor,
      id: args.id,
      root: args.root,
      force: Boolean(args.force),
      dryRun: Boolean(args['dry-run'])
    });

    printResult(result);
  } catch (error) {
    console.error(`\n  ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = { publishMoment, parseArgs, defaultId };
