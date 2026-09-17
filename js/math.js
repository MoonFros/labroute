/**
 * Shared MathJax configuration and rendering helpers for Labroute reports.
 *
 * Report JSON stores TeX as ordinary strings. JSON.stringify escapes a
 * backslash in the downloaded file and JSON.parse restores it when a report
 * is read, so TeX source must never be manually double-escaped in the form.
 */
(function configureLabrouteMath(window) {
  'use strict';

  // Some previously-uploaded reports use pre-LaTeX shortcuts such as
  // /{frac}{a}{b} or /frac{a}{b}. Normalize those commands only while
  // rendering—the original report JSON remains untouched.
  const TEX_COMMANDS = [
    'dfrac', 'tfrac', 'frac', 'sqrt', 'root', 'sum', 'prod', 'int', 'iint',
    'iiint', 'oint', 'lim', 'log', 'ln', 'exp', 'sin', 'cos', 'tan', 'cot',
    'sec', 'csc', 'arcsin', 'arccos', 'arctan', 'alpha', 'beta', 'gamma',
    'delta', 'epsilon', 'theta', 'lambda', 'mu', 'pi', 'rho', 'sigma', 'phi',
    'omega', 'Delta', 'Gamma', 'Lambda', 'Pi', 'Sigma', 'Phi', 'Omega',
    'partial', 'nabla', 'infty', 'cdot', 'times', 'div', 'pm', 'mp', 'leq',
    'geq', 'neq', 'approx', 'equiv', 'propto', 'rightarrow', 'leftarrow',
    'leftrightarrow', 'Rightarrow', 'Leftarrow', 'mathbf', 'mathrm', 'mathit',
    'text', 'left', 'right', 'overline', 'underline', 'vec', 'hat', 'dot',
    'ddot', 'begin', 'end', 'matrix', 'pmatrix', 'bmatrix', 'cases', 'aligned'
  ].join('|');

  const legacyBracedCommand = new RegExp(`[\\\\/]\\{(${TEX_COMMANDS})\\}`, 'g');
  const legacyCommand = new RegExp(`[\\\\/](${TEX_COMMANDS})\\b`, 'g');
  const texCommandAtStart = new RegExp(`^\\\\(?:${TEX_COMMANDS})\\b`);
  const rawTexCommand = new RegExp(`\\\\(?:${TEX_COMMANDS})\\b`);

  /**
   * Convert the two historic slash command forms to normal TeX commands.
   * A valid \frac is left unchanged.
   *
   * @param {string} source
   * @returns {string}
   */
  function normalizeLegacyCommands(source) {
    return source
      .replace(legacyBracedCommand, '\\$1')
      .replace(legacyCommand, '\\$1');
  }

  /**
   * Decide whether an un-delimited line is clearly an equation. This supports
   * legacy JSON that contains a bare \frac or `V = IR` on its own line while
   * avoiding ordinary prose such as "The value is \frac...".
   *
   * @param {string} line
   * @returns {boolean}
   */
  function isLikelyEquation(line) {
    const trimmed = line.trim();
    if (!trimmed) return false;
    if (texCommandAtStart.test(trimmed)) return true;

    const commandMatch = rawTexCommand.exec(trimmed);
    rawTexCommand.lastIndex = 0;
    if (commandMatch) {
      const beforeCommand = trimmed.slice(0, commandMatch.index).trim();
      // Symbols and short variable expressions before a TeX command are math;
      // multiple ordinary words indicate prose and are left alone.
      if (/^[A-Za-z0-9_{}^\\+\-*/=().,≈≤≥<>\s]*$/.test(beforeCommand) &&
          !/[A-Za-z]{2,}\s+[A-Za-z]{2,}/.test(beforeCommand)) {
        return true;
      }
    }

    // Simple undelimited equations such as V = IR and I_C \approx 2 mA.
    return /^(?:[A-Za-z]{1,4}|\\[A-Za-z]+)(?:_[A-Za-z0-9{}]+|\^[A-Za-z0-9{}]+)?\s*(?:=|≈|≃|≤|≥|<|>|\\(?:approx|equiv|leq|geq|neq|propto)\b)/.test(trimmed);
  }

  /**
   * Add display delimiters around legacy equations that were stored without
   * MathJax delimiters. Existing \(...\), \[...\], $...$, and $$...$$ source
   * is preserved as-is.
   *
   * @param {string} source
   * @returns {string}
   */
  function addLegacyEquationDelimiters(source) {
    let activeDelimiter = null;

    return source.split('\n').map(line => {
      if (activeDelimiter) {
        if (line.includes(activeDelimiter)) activeDelimiter = null;
        return line;
      }

      if (line.includes('\\[') && !line.includes('\\]')) {
        activeDelimiter = '\\]';
        return line;
      }
      if (line.includes('\\(') && !line.includes('\\)')) {
        activeDelimiter = '\\)';
        return line;
      }
      if (line.includes('$$')) {
        // One $$ on a line opens a display expression; two close it again.
        if ((line.match(/\$\$/g) || []).length % 2 === 1) activeDelimiter = '$$';
        return line;
      }
      if (line.includes('\\[') || line.includes('\\(') || /\$[^$]+\$/.test(line)) {
        return line;
      }

      if (!isLikelyEquation(line)) return line;

      const indentation = line.match(/^\s*/)?.[0] || '';
      return `${indentation}\\[${line.trim()}\\]`;
    }).join('\n');
  }

  const groupedCommands = new Set([
    'dfrac', 'tfrac', 'frac', 'sqrt', 'root', 'text', 'mathbf', 'mathrm',
    'mathit', 'overline', 'underline', 'vec', 'hat', 'dot', 'ddot'
  ]);
  const twoGroupCommands = new Set(['dfrac', 'tfrac', 'frac']);

  function readDelimitedGroup(source, start, open, close) {
    if (source[start] !== open) return start;
    let depth = 0;
    for (let index = start; index < source.length; index += 1) {
      if (source[index] === open) depth += 1;
      if (source[index] === close) {
        depth -= 1;
        if (depth === 0) return index + 1;
      }
    }
    return start;
  }

  function readScript(source, start) {
    if (source[start] !== '^' && source[start] !== '_') return start;
    if (source[start + 1] === '{') return readDelimitedGroup(source, start + 1, '{', '}');
    return Math.min(start + 2, source.length);
  }

  /**
   * Find the end of one bare TeX command, including the argument groups that
   * make a command such as \frac{a}{b} meaningful. This is intentionally
   * conservative: prose on either side stays plain text.
   */
  function readBareTexCommand(source, start) {
    const match = source.slice(start).match(new RegExp(`^\\\\(${TEX_COMMANDS})\\b`));
    if (!match) return start;

    const command = match[1];
    let cursor = start + match[0].length;

    if (command === 'left') {
      const rightStart = source.indexOf('\\right', cursor);
      if (rightStart !== -1) {
        const rightEnd = readBareTexCommand(source, rightStart);
        return rightEnd > rightStart ? rightEnd : cursor;
      }
    }

    // \right is followed by one delimiter character, e.g. \right) or \right].
    if (command === 'right' && cursor < source.length) return cursor + 1;

    if (command === 'sqrt' && source[cursor] === '[') {
      const rootEnd = readDelimitedGroup(source, cursor, '[', ']');
      if (rootEnd > cursor) cursor = rootEnd;
    }

    if (groupedCommands.has(command)) {
      const groupCount = twoGroupCommands.has(command) ? 2 : 1;
      for (let group = 0; group < groupCount; group += 1) {
        while (/\s/.test(source[cursor] || '')) cursor += 1;
        const groupEnd = readDelimitedGroup(source, cursor, '{', '}');
        if (groupEnd === cursor) break;
        cursor = groupEnd;
      }
    }

    // Include common superscript and subscript suffixes, e.g. \sum_{i=1}^n.
    while (source[cursor] === '^' || source[cursor] === '_') {
      const scriptEnd = readScript(source, cursor);
      if (scriptEnd === cursor) break;
      cursor = scriptEnd;
    }

    return cursor;
  }

  /**
   * Wrap bare commands embedded in prose as inline math. This covers a legacy
   * sentence like "the ratio is /{frac}{a}{b}" while leaving surrounding
   * prose untouched. Lines that are whole equations were already wrapped as
   * display math by addLegacyEquationDelimiters.
   */
  function wrapBareTexCommands(source) {
    let output = '';
    let cursor = 0;
    let activeDelimiter = null;

    while (cursor < source.length) {
      if (activeDelimiter) {
        if (source.startsWith(activeDelimiter, cursor)) {
          output += activeDelimiter;
          cursor += activeDelimiter.length;
          activeDelimiter = null;
        } else {
          output += source[cursor];
          cursor += 1;
        }
        continue;
      }

      if (source.startsWith('\\[', cursor)) {
        output += '\\[';
        cursor += 2;
        activeDelimiter = '\\]';
        continue;
      }
      if (source.startsWith('\\(', cursor)) {
        output += '\\(';
        cursor += 2;
        activeDelimiter = '\\)';
        continue;
      }
      if (source.startsWith('$$', cursor)) {
        output += '$$';
        cursor += 2;
        activeDelimiter = '$$';
        continue;
      }
      if (source[cursor] === '$') {
        output += '$';
        cursor += 1;
        activeDelimiter = '$';
        continue;
      }

      const commandEnd = source[cursor] === '\\' ? readBareTexCommand(source, cursor) : cursor;
      if (commandEnd > cursor) {
        output += `\\(${source.slice(cursor, commandEnd)}\\)`;
        cursor = commandEnd;
        continue;
      }

      output += source[cursor];
      cursor += 1;
    }

    return output;
  }

  /**
   * Prepare one raw JSON text node for MathJax without altering the saved file.
   * @param {string} source
   * @returns {string}
   */
  function prepareText(source) {
    const normalized = normalizeLegacyCommands(String(source ?? ''));
    return wrapBareTexCommands(addLegacyEquationDelimiters(normalized));
  }

  function prepareElement(element) {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    let node;

    while ((node = walker.nextNode())) {
      const parent = node.parentElement;
      if (parent?.closest('mjx-container, script, style, textarea, pre, code')) continue;
      textNodes.push(node);
    }

    textNodes.forEach(textNode => {
      const prepared = prepareText(textNode.nodeValue);
      if (prepared !== textNode.nodeValue) textNode.nodeValue = prepared;
    });
  }

  window.MathJax = {
    loader: {
      load: ['[tex]/noerrors']
    },
    tex: {
      // $...$ is accepted for legacy uploads. Authors should prefer \(...\)
      // because it cannot be confused with a currency value in ordinary text.
      inlineMath: [['\\(', '\\)'], ['$', '$']],
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
    prepareText,
    async typeset(element) {
      if (!element) return false;
      prepareElement(element);

      const mathJax = window.MathJax;
      if (!mathJax || !mathJax.startup || !mathJax.startup.promise) {
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
