/**
 * LabRoute — single, quiet promo card.
 *
 * Rules this file is written to honour:
 * - at most ONE card per browser session (sessionStorage);
 * - it never appears immediately — a delay lets people start reading first;
 * - it never covers the page: no backdrop, no scroll lock, dismissable with a
 *   button or Escape, and exactly one click target (the creative);
 * - on phones it is a compact bar pinned to the bottom edge, clear of the safe
 *   area, so it cannot sit over the middle of the page.
 *
 * Content lives in content/ads.json so campaigns change without code edits.
 * Appending `?noad=1` to any URL suppresses it for that visit.
 */

(function () {
  'use strict';

  const CONFIG_URL = 'content/ads.json';
  const SESSION_KEY = 'labroute_promo_seen';
  const DISMISS_KEY = 'labroute_promo_dismissed_until';
  const SKIP_PARAM = 'noad';

  const DEFAULTS = {
    enabled: false,
    oncePerSession: true,
    delaySeconds: 12,
    dismissDays: 0,
    respectDoNotTrack: true,
    label: 'Sponsored'
  };

  const MIN_DELAY_MS = 3000;
  const MAX_DELAY_MS = 120000;
  const LEAVE_MS = 260;

  /** Only same-site paths and http(s) URLs are allowed. */
  function isSafeLink(value) {
    const href = String(value || '').trim();
    if (!href) return false;
    if (/^https?:\/\/[^\s]+$/i.test(href)) return true;
    // Relative site paths such as "about.html" or "/index.html#Gallery".
    return /^\/?[A-Za-z0-9][A-Za-z0-9/._~%#?=&-]*$/.test(href) && !href.startsWith('//');
  }

  function isSafeImage(value) {
    const image = String(value || '').trim();
    if (!image) return false;
    if (/^assets\/[A-Za-z0-9/._-]+$/.test(image)) {
      // No climbing out of the assets tree, the same rule the gallery uses.
      return !image.includes('..') && !image.includes('\\');
    }
    return /^https:\/\/[^\s]+$/i.test(image);
  }

  /** Ads worth rendering: enabled, with a safe image and a safe link. */
  function usableAds(config) {
    const list = Array.isArray(config && config.ads) ? config.ads : [];

    return list.filter(
      (ad) =>
        ad &&
        typeof ad === 'object' &&
        ad.enabled !== false &&
        isSafeImage(ad.image) &&
        isSafeLink(ad.href)
    );
  }

  /** Weighted random pick, so several campaigns can share the slot. */
  function pickAd(ads, random) {
    if (!Array.isArray(ads) || !ads.length) return null;

    const weightOf = (ad) => (Number.isFinite(ad.weight) && ad.weight > 0 ? ad.weight : 1);
    const total = ads.reduce((sum, ad) => sum + weightOf(ad), 0);
    let ticket = (typeof random === 'number' ? random : Math.random()) * total;

    for (const ad of ads) {
      ticket -= weightOf(ad);
      if (ticket < 0) return ad;
    }

    return ads[ads.length - 1];
  }

  function delayMs(config) {
    const seconds = Number.isFinite(config && config.delaySeconds)
      ? config.delaySeconds
      : DEFAULTS.delaySeconds;

    return Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, seconds * 1000));
  }

  // --- storage (wrapped: Safari private mode throws on access) --------------

  function readStore(store, key) {
    try {
      return window[store].getItem(key);
    } catch {
      return null;
    }
  }

  function writeStore(store, key, value) {
    try {
      window[store].setItem(key, value);
    } catch {
      // Ignore: the card simply may reappear in a later session.
    }
  }

  function alreadySeen() {
    return readStore('sessionStorage', SESSION_KEY) === '1';
  }

  function markSeen() {
    writeStore('sessionStorage', SESSION_KEY, '1');
  }

  function dismissedRecently() {
    const until = Number(readStore('localStorage', DISMISS_KEY));
    return Number.isFinite(until) && until > Date.now();
  }

  function rememberDismissal(config) {
    const days = Number.isFinite(config && config.dismissDays) ? config.dismissDays : 0;
    if (days <= 0) return;

    writeStore('localStorage', DISMISS_KEY, String(Date.now() + days * 24 * 60 * 60 * 1000));
  }

  // --- why-not checks -------------------------------------------------------

  /**
   * Every reason this visitor should not see a card. Empty array means show.
   * Kept pure so the decision is testable without a browser.
   */
  function skipReasons(config, env) {
    const context = env || {};
    const reasons = [];

    if (!config || config.enabled !== true) reasons.push('disabled');
    if (!usableAds(config).length) reasons.push('no-usable-ads');
    if (context.skipParam) reasons.push('noad-param');
    if (context.doNotTrack && config && config.respectDoNotTrack !== false) {
      reasons.push('do-not-track');
    }
    if (config && config.oncePerSession !== false && context.seen) reasons.push('seen-this-session');
    if (config && config.dismissDays > 0 && context.dismissed) reasons.push('dismissed-recently');

    return reasons;
  }

  // --- rendering -----------------------------------------------------------

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (character) => {
      switch (character) {
        case '&':
          return '&amp;';
        case '<':
          return '&lt;';
        case '>':
          return '&gt;';
        case '"':
          return '&quot;';
        case "'":
          return '&#39;';
        default:
          return character;
      }
    });
  }

  function promoMarkup(ad, config) {
    const label = escapeHtml((config && config.label) || DEFAULTS.label);
    const title = escapeHtml(ad.title);
    const body = escapeHtml(ad.body);
    const cta = escapeHtml(ad.cta || 'View offer');
    const alt = escapeHtml(ad.alt || ad.title || 'Sponsored offer');
    const href = escapeHtml(ad.href);
    const external = /^https?:\/\//i.test(String(ad.href));

    return `
      <div class="promo-card" role="complementary" aria-label="${label} offer">
        <a class="promo-link" href="${href}"${external ? ' target="_blank" rel="noopener sponsored"' : ''}>
          <img class="promo-image" src="${escapeHtml(ad.image)}" alt="${alt}" loading="lazy" decoding="async" width="320" height="180" />
          <span class="promo-copy">
            <span class="promo-label">${label}</span>
            <span class="promo-title">${title}</span>
            ${body ? `<span class="promo-body">${body}</span>` : ''}
            <span class="promo-cta">${cta}</span>
          </span>
        </a>
        <button type="button" class="promo-close" aria-label="Dismiss this offer" title="Dismiss">
          <span aria-hidden="true">&times;</span>
        </button>
      </div>`;
  }

  function mountPromo(ad, config, doc, win) {
    const existing = doc.getElementById('labroutePromo');
    if (existing) return existing;

    const root = doc.createElement('div');
    root.id = 'labroutePromo';
    root.className = 'promo-root';
    root.innerHTML = promoMarkup(ad, config);

    doc.body.appendChild(root);

    // One frame later so the CSS transition starts from the hidden state.
    if (typeof win.requestAnimationFrame === 'function') {
      win.requestAnimationFrame(() => root.classList.add('is-visible'));
    } else {
      root.classList.add('is-visible');
    }

    return root;
  }

  function removePromo(root, win) {
    root.classList.remove('is-visible');
    root.classList.add('is-leaving');

    win.setTimeout(() => {
      if (root && typeof root.remove === 'function') root.remove();
      else if (root && root.parentNode) root.parentNode.removeChild(root);
    }, LEAVE_MS);
  }

  // --- boot ----------------------------------------------------------------

  /**
   * Start the countdown and, when it elapses, show the card.
   * Returns a handle { ad, root, timer, close } or null when skipped.
   */
  function start(config, environment) {
    const env = environment || {};
    const doc = env.document || (typeof document !== 'undefined' ? document : null);
    const win = env.window || (typeof window !== 'undefined' ? window : null);

    if (!doc || !win || !doc.body) return null;

    const reasons = skipReasons(config, {
      skipParam: env.skipParam,
      doNotTrack: env.doNotTrack,
      seen: env.seen,
      dismissed: env.dismissed
    });

    if (reasons.length) return null;

    const ad = pickAd(usableAds(config), env.random);
    if (!ad) return null;

    const handle = { ad, root: null, timer: null, close: null };

    const close = () => {
      if (!handle.root) return;
      removePromo(handle.root, win);
      handle.root = null;
      markSeen();
      rememberDismissal(config);
    };

    handle.close = close;

    handle.timer = win.setTimeout(() => {
      // A visitor who left the tab is not watching: do not pop up on return
      // and do not try again this session.
      if (doc.visibilityState === 'hidden') {
        markSeen();
        return;
      }

      const root = mountPromo(ad, config, doc, win);
      handle.root = root;

      const button = root.querySelector('.promo-close');
      if (button && typeof button.addEventListener === 'function') {
        button.addEventListener('click', (event) => {
          if (event && typeof event.preventDefault === 'function') {
            event.preventDefault();
            event.stopPropagation();
          }
          close();
        });
      }

      const link = root.querySelector('.promo-link');
      if (link && typeof link.addEventListener === 'function') {
        // Following the ad counts as engaging: not again this session.
        link.addEventListener('click', () => {
          markSeen();
          rememberDismissal(config);
        });
      }

      if (typeof doc.addEventListener === 'function') {
        doc.addEventListener('keydown', (event) => {
          if (event.key === 'Escape') close();
        });
      }
    }, delayMs(config));

    return handle;
  }

  function init() {
    const win = window;

    let skipParam = false;
    try {
      skipParam = new URLSearchParams(win.location.search).has(SKIP_PARAM);
    } catch {
      skipParam = false;
    }

    const doNotTrack =
      Boolean(win.navigator && win.navigator.doNotTrack === '1') || win.doNotTrack === '1';

    // Cheap local gates before spending a request.
    if (skipParam || alreadySeen() || dismissedRecently()) return;

    fetch(`${CONFIG_URL}?v=${Date.now()}`, { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : null))
      .then((config) => {
        if (!config) return;
        start(config, {
          skipParam,
          doNotTrack,
          seen: alreadySeen(),
          dismissed: dismissedRecently()
        });
      })
      .catch(() => {
        // Advertising must never break the page: fail silently.
      });
  }

  const api = {
    DEFAULTS,
    MIN_DELAY_MS,
    MAX_DELAY_MS,
    delayMs,
    isSafeImage,
    isSafeLink,
    pickAd,
    promoMarkup,
    skipReasons,
    start,
    usableAds
  };

  // Exposed for the test suite; harmless in the browser.
  if (typeof window !== 'undefined') window.LabRoutePromo = api;

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }
})();
