'use strict';

/**
 * The home page gallery shows at most nine photos at a time.
 *
 * js/app.js is plain browser script (no module exports), so this test runs it in
 * a vm context with a tiny DOM stub: it asserts that renderGallery never emits
 * more than nine cards, that paging moves through the rest, and that the
 * "New" badge and the page controls behave.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

function makeElement() {
  return {
    innerHTML: '',
    textContent: '',
    hidden: false,
    dataset: {},
    addEventListener() {},
    scrollIntoView() {}
  };
}

function createPage(items, options = {}) {
  const elements = {
    galleryMasonryGrid: makeElement(),
    galleryPagination: makeElement(),
    galleryPageStatus: makeElement()
  };

  const sandbox = {
    console,
    Date,
    Number,
    Math,
    Set,
    Map,
    Array,
    String,
    Boolean,
    JSON,
    document: {
      getElementById: (id) => elements[id] || null,
      addEventListener() {}
    },
    window: {},
    fetch: async () => {
      throw new Error('fetch is not used in this test');
    }
  };

  sandbox.window = sandbox;

  const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'app.js'), 'utf8');
  vm.runInNewContext(source, sandbox, { filename: 'js/app.js' });

  sandbox.renderGallery(items);

  return { sandbox, elements };
}

const cardCount = (html) => (html.match(/<figure class="gallery-card/g) || []).length;

function photos(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `photo-${index + 1}`,
    image: `assets/gallery/moments/photo-${index + 1}.jpg`,
    caption: `Photo ${index + 1}`,
    contributor: 'LabRoute',
    uploaded: index === 0,
    uploadedAt: new Date(Date.UTC(2026, 9, 1, 0, index)).toISOString()
  }));
}

test('the gallery renders nine photos per page', () => {
  const { sandbox, elements } = createPage(photos(23));

  assert.equal(cardCount(elements.galleryMasonryGrid.innerHTML), 9);
  assert.equal(elements.galleryPageStatus.textContent, 'Showing 1–9 of 23 photos');
  assert.equal(elements.galleryPagination.hidden, false);

  // The first page is "1", the last is "3", and the controls advertise them.
  assert.match(elements.galleryPagination.innerHTML, /aria-label="Page 1 of 3"/);
  assert.match(elements.galleryPagination.innerHTML, /aria-label="Page 3 of 3"/);
  assert.match(elements.galleryPagination.innerHTML, /aria-current="page"/);
  // "Previous" is inert on the first page.
  assert.match(elements.galleryPagination.innerHTML, /data-gallery-page="prev"[^>]*disabled/);
  assert.doesNotMatch(elements.galleryPagination.innerHTML, /data-gallery-page="next"[^>]*disabled/);

  sandbox.goToGalleryPage(1, { scroll: false });
  assert.equal(cardCount(elements.galleryMasonryGrid.innerHTML), 9);
  assert.equal(elements.galleryPageStatus.textContent, 'Showing 10–18 of 23 photos');
  assert.match(elements.galleryMasonryGrid.innerHTML, /Photo 10/);
  assert.doesNotMatch(elements.galleryMasonryGrid.innerHTML, /Photo 1</);

  sandbox.goToGalleryPage(2, { scroll: false });
  assert.equal(cardCount(elements.galleryMasonryGrid.innerHTML), 5);
  assert.equal(elements.galleryPageStatus.textContent, 'Showing 19–23 of 23 photos');
  assert.match(elements.galleryPagination.innerHTML, /data-gallery-page="next"[^>]*disabled/);

  // Paging past the end stays on the last page rather than rendering nothing.
  sandbox.goToGalleryPage(99, { scroll: false });
  assert.equal(cardCount(elements.galleryMasonryGrid.innerHTML), 5);
});

test('a small gallery has no pager and never exceeds nine cards', () => {
  const { sandbox, elements } = createPage(photos(9));

  assert.equal(cardCount(elements.galleryMasonryGrid.innerHTML), 9);
  assert.equal(elements.galleryPagination.hidden, true);
  assert.equal(elements.galleryPagination.innerHTML, '');
  assert.equal(elements.galleryPageStatus.textContent, 'Showing 1–9 of 9 photos');

  sandbox.goToGalleryPage(1, { scroll: false });
  assert.equal(cardCount(elements.galleryMasonryGrid.innerHTML), 9);
});

test('the New badge marks only the very first photo of the whole gallery', () => {
  const { sandbox, elements } = createPage(photos(12));

  assert.equal((elements.galleryMasonryGrid.innerHTML.match(/gallery-new-badge/g) || []).length, 1);

  sandbox.goToGalleryPage(1, { scroll: false });
  assert.equal((elements.galleryMasonryGrid.innerHTML.match(/gallery-new-badge/g) || []).length, 0);
  assert.equal(elements.galleryPageStatus.textContent, 'Showing 10–12 of 12 photos');
});

test('an empty gallery keeps the empty state and hides the pager', () => {
  const { elements } = createPage([]);

  assert.match(elements.galleryMasonryGrid.innerHTML, /gallery-empty/);
  assert.equal(elements.galleryPagination.hidden, true);
  assert.equal(elements.galleryPageStatus.textContent, '');
});

test('long galleries window their page numbers around the current page', () => {
  const { sandbox, elements } = createPage(photos(90)); // 10 pages

  assert.equal(elements.galleryPageStatus.textContent, 'Showing 1–9 of 90 photos');
  assert.match(elements.galleryPagination.innerHTML, /gallery-page-gap/);
  assert.match(elements.galleryPagination.innerHTML, />1</);
  assert.match(elements.galleryPagination.innerHTML, />10</);

  sandbox.goToGalleryPage(4, { scroll: false });
  assert.equal(elements.galleryPageStatus.textContent, 'Showing 37–45 of 90 photos');
  assert.match(elements.galleryPagination.innerHTML, /aria-current="page"[^>]*>5</);

  // Only nine cards exist in the DOM at any time.
  assert.equal(cardCount(elements.galleryMasonryGrid.innerHTML), 9);
});
