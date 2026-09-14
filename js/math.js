/**
 * Shared MathJax configuration and rendering helper for Labroute reports.
 *
 * Report JSON stores TeX as ordinary strings. JSON.stringify escapes a
 * backslash in the downloaded file and JSON.parse restores it when a report
 * is read, so TeX source must never be manually double-escaped in the form.
 */
(function configureLabrouteMath(window) {
  'use strict';

  window.MathJax = {
    loader: {
      load: ['[tex]/noerrors']
    },
    tex: {
      // Delimiters are deliberately explicit so ordinary currency symbols are
      // not accidentally treated as mathematics.
      inlineMath: [['\\(', '\\)']],
      displayMath: [['\\[', '\\]'], ['$$', '$$']],
      packages: {
        '[+]': ['noerrors']
      }
    },
    options: {
      enableMenu: false
    }
  };

  /**
   * Typeset TeX that was inserted into an element after MathJax's initial
   * page scan. If the CDN is unavailable, the source remains readable rather
   * than preventing the report from rendering.
   *
   * @param {HTMLElement} element
   * @returns {Promise<boolean>}
   */
  window.LabrouteMath = {
    async typeset(element) {
      const mathJax = window.MathJax;
      if (!element || !mathJax || !mathJax.startup || !mathJax.startup.promise) {
        return false;
      }

      try {
        await mathJax.startup.promise;
        if (typeof mathJax.typesetPromise !== 'function') return false;

        if (typeof mathJax.typesetClear === 'function') {
          mathJax.typesetClear([element]);
        }
        await mathJax.typesetPromise([element]);
        return true;
      } catch (error) {
        console.warn('MathJax could not typeset this content.', error);
        return false;
      }
    }
  };
})(window);
