'use strict';

/**
 * The promo card: one per session, one click target, and a decision table that
 * is testable without a real browser.
 *
 * js/promo.js is a browser script, so it runs here in a vm with a tiny DOM
 * stub (same approach as tests/gallery-paging.test.js).
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'js', 'promo.js'), 'utf8');

function makeClassList() {
  const set = new Set();
  return {
    add: (name) => set.add(name),
    remove: (name) => set.delete(name),
    contains: (name) => set.has(name),
    toString: () => [...set].join(' ')
  };
}

function makeElement(tag) {
  const node = {
    tagName: String(tag || 'div').toUpperCase(),
    id: '',
    className: '',
    innerHTML: '',
    parentNode: null,
    children: [],
    classList: makeClassList(),
    handlers: {},
    removed: false,
    appendChild(child) {
      child.parentNode = node;
      node.children.push(child);
      return child;
    },
    remove() {
      node.removed = true;
      if (node.parentNode) {
        node.parentNode.children = node.parentNode.children.filter((item) => item !== node);
      }
    },
    addEventListener(type, handler) {
      (node.handlers[type] = node.handlers[type] || []).push(handler);
    },
    querySelector(selector) {
      // The markup is a string in this stub; return a stand-in element so the
      // wiring code has something to attach to.
      return makeElement(selector);
    },
    focus() {}
  };
  return node;
}

function createSandbox(options = {}) {
  const timers = [];
  const body = makeElement('body');
  const documentHandlers = {};

  const elements = {};

  const sandbox = {
    console,
    Date,
    Number,
    Math,
    JSON,
    Array,
    String,
    Boolean,
    Set,
    URLSearchParams,
    fetch: () => Promise.reject(new Error('network disabled in tests')),
    requestAnimationFrame: (callback) => {
      callback();
      return 1;
    },
    setTimeout: (callback, delay) => {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => {
      if (timer) timer.cleared = true;
    },
    document: {
      readyState: 'loading', // keeps init() inert
      visibilityState: options.visibilityState || 'visible',
      body,
      getElementById: (id) => elements[id] || null,
      createElement: (tag) => makeElement(tag),
      addEventListener: (type, handler) => {
        (documentHandlers[type] = documentHandlers[type] || []).push(handler);
      }
    },
    location: { search: options.search || '' },
    navigator: { doNotTrack: options.doNotTrack || null },
    sessionStorage: (() => {
      const store = new Map(options.session || []);
      return {
        getItem: (key) => (store.has(key) ? store.get(key) : null),
        setItem: (key, value) => store.set(key, String(value)),
        removeItem: (key) => store.delete(key),
        dump: () => Object.fromEntries(store)
      };
    })(),
    localStorage: (() => {
      const store = new Map(options.local || []);
      return {
        getItem: (key) => (store.has(key) ? store.get(key) : null),
        setItem: (key, value) => store.set(key, String(value)),
        removeItem: (key) => store.delete(key),
        dump: () => Object.fromEntries(store)
      };
    })()
  };

  sandbox.window = sandbox;
  sandbox.document.defaultView = sandbox;

  vm.runInNewContext(SOURCE, sandbox, { filename: 'js/promo.js' });

  return { sandbox, api: sandbox.LabRoutePromo, body, timers, elements, documentHandlers };
}

const CONFIG = {
  enabled: true,
  oncePerSession: true,
  delaySeconds: 12,
  dismissDays: 0,
  label: 'Sponsored',
  ads: [
    {
      id: 'kit',
      image: 'assets/ads/sample-lab-kit.jpg',
      title: 'Lab kit starter set',
      body: 'Everything for a first practical.',
      cta: 'Take a look',
      href: 'about.html'
    }
  ]
};

test('the promo never shows when it should not', () => {
  const { api } = createSandbox();
  // Arrays come from the vm realm, so copy them before a strict comparison.
  const reasons = (config, env) => Array.from(api.skipReasons(config, env));

  // Switched off in content/ads.json: nothing is shown, even with valid ads.
  assert.deepEqual(reasons({ ...CONFIG, enabled: false }, {}), ['disabled']);
  assert.deepEqual(reasons({ enabled: true, ads: [] }, {}), ['no-usable-ads']);
  assert.deepEqual(reasons(CONFIG, { skipParam: true }), ['noad-param']);
  assert.deepEqual(reasons(CONFIG, { doNotTrack: true }), ['do-not-track']);
  assert.deepEqual(reasons(CONFIG, { seen: true }), ['seen-this-session']);
  assert.deepEqual(reasons({ ...CONFIG, dismissDays: 14 }, { dismissed: true }), [
    'dismissed-recently'
  ]);

  // All clear.
  assert.deepEqual(reasons(CONFIG, {}), []);

  // A config that explicitly ignores DNT reports no DNT reason.
  assert.deepEqual(reasons({ ...CONFIG, respectDoNotTrack: false }, { doNotTrack: true }), []);
});

test('unsafe creative and links are discarded', () => {
  const { api } = createSandbox();

  for (const href of ['javascript:alert(1)', 'data:text/html,<script>', '//evil.example/x', '']) {
    assert.equal(api.isSafeLink(href), false, href);
  }
  for (const href of ['about.html', '/index.html#Gallery', 'https://shop.example/kit']) {
    assert.equal(api.isSafeLink(href), true, href);
  }

  assert.equal(api.isSafeImage('assets/ads/x.png'), true);
  assert.equal(api.isSafeImage('https://cdn.example/x.png'), true);
  assert.equal(api.isSafeImage('javascript:alert(1)'), false);
  assert.equal(api.isSafeImage('assets/../../etc/passwd'), false);

  const usable = api.usableAds({
    enabled: true,
    ads: [
      { ...CONFIG.ads[0], href: 'javascript:alert(1)' },
      { ...CONFIG.ads[0], image: 'data:image/png;base64,AAAA' },
      { ...CONFIG.ads[0], enabled: false },
      CONFIG.ads[0]
    ]
  });
  assert.equal(usable.length, 1);
});

test('only one card appears per session, after the delay', () => {
  const { sandbox, api, body, timers } = createSandbox();

  const handle = api.start(CONFIG, { document: sandbox.document, window: sandbox });
  assert.ok(handle, 'a card was scheduled');
  assert.equal(body.children.length, 0, 'nothing is mounted immediately');
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 12000, 'waits the configured 12s');

  timers[0].callback();
  assert.equal(body.children.length, 1);
  assert.equal(body.children[0].id, 'labroutePromo');

  // Exactly one link, so the whole creative is a single tap target.
  const markup = api.promoMarkup(CONFIG.ads[0], CONFIG);
  assert.equal((markup.match(/<a /g) || []).length, 1);
  assert.match(markup, /href="about.html"/);
  assert.match(markup, /aria-label="Sponsored offer"/);
  assert.match(markup, /Dismiss this offer/);

  // A second call in the same session is refused.
  assert.equal(api.start(CONFIG, { document: sandbox.document, window: sandbox, seen: true }), null);
});

test('the card keeps its creative, title, description and CTA on every viewport', () => {
  const { api } = createSandbox();
  const markup = api.promoMarkup(CONFIG.ads[0], CONFIG);

  // The advertisement has to say what it is selling, on a phone as much as on
  // a desktop: the earlier mobile layout dropped the description entirely.
  assert.match(markup, /class="promo-image"/);
  assert.match(markup, /class="promo-label"/);
  assert.match(markup, /class="promo-title"/);
  assert.match(markup, /class="promo-body"/);
  assert.match(markup, /class="promo-cta"/);

  const css = fs.readFileSync(path.join(__dirname, '..', 'styles', 'promo.css'), 'utf8');
  const mobile = css.slice(css.indexOf('@media (max-width: 640px)'));
  assert.ok(mobile.length > 0, 'there is a mobile block');

  // The description stays visible and readable rather than being hidden.
  const bodyRule = /\.promo-body\s*\{([^}]*)\}/.exec(mobile);
  assert.ok(bodyRule, 'the mobile block styles .promo-body');
  assert.match(bodyRule[1], /display:\s*-webkit-box/);
  assert.match(bodyRule[1], /-webkit-line-clamp:\s*2/);
  assert.doesNotMatch(bodyRule[1], /display:\s*none/);

  // The copy column is the same anatomy as the desktop card, not a thumbnail
  // strip: the image sits above the text at full width.
  const linkRule = /\.promo-link\s*\{([^}]*)\}/.exec(mobile);
  assert.ok(linkRule, 'the mobile block lays out .promo-link');
  assert.match(linkRule[1], /flex-direction:\s*column/);

  const imageRule = /\.promo-image\s*\{([^}]*)\}/.exec(mobile);
  assert.ok(imageRule, 'the mobile block sizes .promo-image');
  assert.match(imageRule[1], /width:\s*100%/);
  assert.match(imageRule[1], /aspect-ratio:\s*16\s*\/\s*9/);
});

test('dismissing remembers the session and respects the configured days', () => {
  const { sandbox, api, body, timers } = createSandbox();

  const handle = api.start(CONFIG, { document: sandbox.document, window: sandbox });
  timers[0].callback();
  assert.equal(body.children.length, 1);

  handle.close();
  assert.equal(sandbox.sessionStorage.getItem('labroute_promo_seen'), '1');
  // dismissDays is 0 by default: nothing is remembered across sessions.
  assert.equal(sandbox.localStorage.getItem('labroute_promo_dismissed_until'), null);

  const remembering = createSandbox();
  const second = remembering.api.start(
    { ...CONFIG, dismissDays: 14 },
    { document: remembering.sandbox.document, window: remembering.sandbox }
  );
  remembering.timers[0].callback();
  second.close();
  const until = Number(remembering.sandbox.localStorage.getItem('labroute_promo_dismissed_until'));
  assert.ok(until > Date.now(), 'a dismissal window was stored');
});

test('a hidden tab skips the card instead of interrupting on return', () => {
  const { sandbox, api, body, timers } = createSandbox({ visibilityState: 'hidden' });

  api.start(CONFIG, { document: sandbox.document, window: sandbox });
  timers[0].callback();

  assert.equal(body.children.length, 0);
  assert.equal(sandbox.sessionStorage.getItem('labroute_promo_seen'), '1');
});

test('delays are clamped to a sane window and ads are chosen by weight', () => {
  const { api } = createSandbox();

  assert.equal(api.delayMs({ delaySeconds: 0 }), api.MIN_DELAY_MS); // never instant
  assert.equal(api.delayMs({ delaySeconds: 9999 }), api.MAX_DELAY_MS);
  assert.equal(api.delayMs({}), 12000);
  assert.equal(api.delayMs({ delaySeconds: 20 }), 20000);

  const ads = [
    { id: 'a', weight: 3 },
    { id: 'b', weight: 1 }
  ];
  assert.equal(api.pickAd(ads, 0).id, 'a');
  assert.equal(api.pickAd(ads, 0.74).id, 'a');
  assert.equal(api.pickAd(ads, 0.76).id, 'b');
  assert.equal(api.pickAd(ads, 0.999).id, 'b');
  assert.equal(api.pickAd([], 0.5), null);
});

test('the markup escapes anything an advertiser puts in the JSON', () => {
  const { api } = createSandbox();

  const markup = api.promoMarkup(
    {
      image: 'assets/ads/x.png',
      href: 'https://shop.example/x?a=1&b=2',
      title: '<img src=x onerror=alert(1)>',
      body: 'Tom & Jerry "quoted"',
      alt: 'A "kit"',
      cta: '<b>Go</b>'
    },
    CONFIG
  );

  assert.doesNotMatch(markup, /<img src=x/);
  assert.match(markup, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(markup, /Tom &amp; Jerry &quot;quoted&quot;/);
  assert.match(markup, /&lt;b&gt;Go&lt;\/b&gt;/);
  // External creative opens in a new tab with a sponsored relation.
  assert.match(markup, /target="_blank" rel="noopener sponsored"/);
});
