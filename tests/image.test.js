'use strict';

/**
 * Image intake: any phone photo must be accepted.
 *
 * The reported bug: a normal JPEG taken on a phone was rejected with "the photo
 * could not be read", because the phone reported no MIME type and the data URL
 * arrived as `data:application/octet-stream;base64,...`. These tests pin the
 * behaviour of the fix — the bytes decide, not the label.
 */

const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  ALLOWED_MIME_TYPES,
  decodeImageDataUrl,
  detectImageType,
  detectUnsupported,
  normaliseDeclaredMime
} = require('../lib/image');

const ONE_PIXEL_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z3X0AAAAASUVORK5CYII=';

// Small real files generated once with ImageMagick.
const JPEG_40x30 = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAAeACgDAREAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFgEBAQEAAAAAAAAAAAAAAAAAAAcI/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AlidNlgAAAAAAAAAAAAAAAAAAP//Z';
const GIF_40x30 = 'R0lGODlhKAAeAPAAADMzzAAAACH5BAAAAAAALAAAAAAoAB4AAAIhhI+py+0Po5y02ouz3rz7D4biSJbmiabqyrbuC8fyTHMFADs=';
const BMP_40x30 = 'Qk1GDgAAAAAAADYAAAAoAAAAKAAAAB4AAAABABgAAAAAABAOAAAAAAAAAAAAAAAAAAAAAAAAM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wzM8wz';

// ftyp box announcing HEIC, and a TIFF header.
const HEIC_HEADER = Buffer.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0x00, 0x00, 0x00, 0x00,
  0x68, 0x65, 0x69, 0x63, 0x6d, 0x69, 0x66, 0x31
]);
const TIFF_HEADER = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00]);

const config = {
  maxUploadBytes: 3 * 1024 * 1024,
  maxImageDimension: 10000,
  maxImagePixels: 40 * 1000 * 1000
};

const dataUrl = (mime, base64) => `data:${mime};base64,${base64}`;

function rejection(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw');
}

test('a phone JPEG with no MIME label is accepted (the reported bug)', () => {
  // This is exactly what Android/Google Photos produce: valid JPEG bytes under
  // an octet-stream label. It used to fail with "the photo could not be read".
  for (const label of ['application/octet-stream', 'binary/octet-stream', 'image/jpg', '', 'image/jpeg; charset=binary']) {
    const decoded = decodeImageDataUrl(dataUrl(label, JPEG_40x30), config);

    assert.equal(decoded.mime, 'image/jpeg', `label: ${label || '(none)'}`);
    assert.equal(decoded.ext, 'jpg');
    assert.equal(decoded.width, 40);
    assert.equal(decoded.height, 30);
    assert.ok(decoded.buffer.length > 0);
  }
});

test('the bytes win over a wrong label instead of rejecting the photo', () => {
  // A PNG sent as image/jpeg (some editors do this) is still stored as a PNG.
  const decoded = decodeImageDataUrl(dataUrl('image/jpeg', ONE_PIXEL_PNG), config);
  assert.equal(decoded.mime, 'image/png');
  assert.equal(decoded.ext, 'png');

  // And a JPEG labelled as a PNG.
  const other = decodeImageDataUrl(dataUrl('image/png', JPEG_40x30), config);
  assert.equal(other.mime, 'image/jpeg');
});

test('GIF and BMP photos are accepted with their real dimensions', () => {
  const gif = decodeImageDataUrl(dataUrl('image/gif', GIF_40x30), config);
  assert.equal(gif.mime, 'image/gif');
  assert.equal(gif.ext, 'gif');
  assert.equal(gif.width, 40);
  assert.equal(gif.height, 30);

  const bmp = decodeImageDataUrl(dataUrl('image/bmp', BMP_40x30), config);
  assert.equal(bmp.mime, 'image/bmp');
  assert.equal(bmp.ext, 'bmp');
  assert.equal(bmp.width, 40);
  assert.equal(bmp.height, 30);

  assert.ok(ALLOWED_MIME_TYPES.has('image/gif'));
  assert.ok(ALLOWED_MIME_TYPES.has('image/bmp'));
});

test('HEIC is refused with instructions, not a generic error', () => {
  const heic = HEIC_HEADER.toString('base64');
  const error = rejection(() => decodeImageDataUrl(dataUrl('image/heic', heic), config));

  assert.equal(error.status, 415);
  assert.equal(error.code, 'unsupported_image_type');
  assert.match(error.message, /HEIC/);
  assert.match(error.message, /Settings → Camera → Formats/);
  // The label is irrelevant: sniffed bytes say HEIC either way.
  const mislabelled = rejection(() =>
    decodeImageDataUrl(dataUrl('application/octet-stream', heic), config)
  );
  assert.match(mislabelled.message, /HEIC/);
});

test('non-images are still rejected', () => {
  const html = Buffer.from('<!doctype html><script>alert(1)</script>').toString('base64');
  const error = rejection(() => decodeImageDataUrl(dataUrl('text/html', html), config));
  assert.equal(error.status, 415);
  assert.match(error.message, /JPEG, PNG, WebP, GIF or BMP/);

  const pdf = Buffer.from('%PDF-1.7\n%\xE2\xE3\xCF\xD3').toString('base64');
  assert.equal(rejection(() => decodeImageDataUrl(dataUrl('application/pdf', pdf), config)).status, 415);

  const tiff = rejection(() => decodeImageDataUrl(dataUrl('image/tiff', TIFF_HEADER.toString('base64')), config));
  assert.equal(tiff.status, 415);
  assert.match(tiff.message, /TIFF/);

  assert.equal(rejection(() => decodeImageDataUrl('', config)).status, 400);
  assert.equal(rejection(() => decodeImageDataUrl('not a data url', config)).status, 400);
  assert.equal(rejection(() => decodeImageDataUrl(dataUrl('image/jpeg', ''), config)).status, 400);
});

test('size and dimension guards still apply to the newly allowed formats', () => {
  const big = Buffer.alloc(4 * 1024 * 1024, 1).toString('base64');
  const tooLarge = rejection(() => decodeImageDataUrl(dataUrl('image/jpeg', big), config));
  assert.equal(tooLarge.status, 413);

  // A BMP header claiming 40,000 x 40,000 px is a decompression-bomb guard case.
  const bomb = Buffer.alloc(60);
  bomb.write('BM', 0, 'ascii');
  bomb.writeUInt32LE(40, 14);
  bomb.writeInt32LE(40000, 18);
  bomb.writeInt32LE(40000, 22);
  const huge = rejection(() => decodeImageDataUrl(dataUrl('image/bmp', bomb.toString('base64')), config));
  assert.equal(huge.status, 413);
});

test('declared labels are normalised, never trusted blindly', () => {
  assert.equal(normaliseDeclaredMime('image/jpg'), 'image/jpeg');
  assert.equal(normaliseDeclaredMime('IMAGE/PNG'), 'image/png');
  assert.equal(normaliseDeclaredMime('image/jpeg; charset=binary'), 'image/jpeg');
  assert.equal(normaliseDeclaredMime('image/x-ms-bmp'), 'image/bmp');
  assert.equal(normaliseDeclaredMime('application/octet-stream'), 'application/octet-stream');
  assert.equal(normaliseDeclaredMime(''), '');
  assert.equal(normaliseDeclaredMime(undefined), '');

  assert.equal(detectImageType(Buffer.from(JPEG_40x30, 'base64')).mime, 'image/jpeg');
  assert.equal(detectImageType(Buffer.from('nonsense')), null);
});

test('unsupported containers are recognised for a helpful message', () => {
  assert.equal(detectUnsupported(HEIC_HEADER), 'heic');
  assert.equal(detectUnsupported(TIFF_HEADER), 'tiff');
  assert.equal(detectUnsupported(Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66])), 'avif');
  assert.equal(detectUnsupported(Buffer.from(JPEG_40x30, 'base64')), null);
});
