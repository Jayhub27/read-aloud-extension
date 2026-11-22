/**
 * Sentence segmentation with source offsets.
 *
 * Loaded as a classic script in the content script (assigns globalThis.TTSSentence)
 * and as a CommonJS module in Node unit tests. No build step.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TTSSentence = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const ABBREVIATIONS = new Set([
    'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc', 'fig', 'figs',
    'no', 'nos', 'inc', 'ltd', 'co', 'corp', 'approx', 'dept', 'est', 'min', 'max',
    'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
    'mt', 'ft', 'oz', 'lb', 'hr', 'hrs', 'sec', 'secs', 'vol', 'pp', 'ca', 'cf', 'al',
  ]);

  const TERMINATORS = '.!?\u2026';
  const CLOSERS = '"\'\u201d\u2019)]}';
  const WORD_CHAR = /[A-Za-z0-9\u00c0-\u024f\u0400-\u04ff\u0600-\u06ff\u4e00-\u9fff]/;

  function isAbbreviation(text, dotIndex) {
    const before = text.slice(Math.max(0, dotIndex - 24), dotIndex);
    const withDot = before + '.';

    // Dotted forms such as "U.S.", "e.g." and "a.m." end with several
    // letter-dot pairs, so a plain-word lookup would miss them.
    if (/(?:[A-Za-z]\.){2,}$/.test(withDot)) return true;

    const plain = /(?:^|[^A-Za-z])([A-Za-z][A-Za-z'\u2019-]*)\.$/.exec(withDot);
    if (!plain) return false;
    const word = plain[1].toLowerCase();
    if (ABBREVIATIONS.has(word)) return true;
    // Single letter initial, as in "J. Smith".
    if (/^[a-z]$/.test(word)) return true;
    return false;
  }

  /**
   * Split a long sentence into speakable chunks at natural punctuation,
   * keeping absolute offsets into the original text.
   */
  function chunkRange(text, start, end, maxLength) {
    const chunks = [];
    let from = start;

    function trimRange(a, b) {
      while (a < b && /\s/.test(text[a])) a += 1;
      while (b > a && /\s/.test(text[b - 1])) b -= 1;
      return [a, b];
    }

    while (from < end) {
      if (end - from <= maxLength) {
        const [a, b] = trimRange(from, end);
        if (b > a) chunks.push({ text: text.slice(a, b), start: a, end: b });
        break;
      }

      const limit = from + maxLength;
      let split = -1;
      for (let i = limit; i > from + Math.floor(maxLength / 2); i -= 1) {
        if (/[,;:]\s/.test(text.slice(i - 1, i + 1)) || /\s/.test(text[i])) {
          split = i;
          break;
        }
      }
      if (split <= from) split = limit;

      const [a, b] = trimRange(from, split);
      if (b > a) chunks.push({ text: text.slice(a, b), start: a, end: b });
      from = split;
    }

    return chunks;
  }

  /**
   * Split text into sentences.
   * @param {string} input
   * @param {{maxLength?: number}} [options]
   * @returns {Array<{text: string, start: number, end: number}>} offsets index into `input`
   */
  function splitSentences(input, options) {
    const text = String(input == null ? '' : input);
    const maxLength = (options && options.maxLength) || 240;
    const out = [];

    function push(from, to) {
      let a = from;
      let b = to;
      while (a < b && /\s/.test(text[a])) a += 1;
      while (b > a && /\s/.test(text[b - 1])) b -= 1;
      if (b <= a) return;
      const raw = text.slice(a, b);
      if (!WORD_CHAR.test(raw)) return;
      for (const chunk of chunkRange(text, a, b, maxLength)) out.push(chunk);
    }

    let start = 0;
    let i = 0;

    while (i < text.length) {
      const ch = text[i];

      // Blank line: hard paragraph boundary (content script joins blocks with "\n\n").
      if (ch === '\n' && text[i + 1] === '\n') {
        push(start, i);
        i += 2;
        start = i;
        continue;
      }

      if (TERMINATORS.indexOf(ch) !== -1) {
        let j = i;
        while (j < text.length && TERMINATORS.indexOf(text[j]) !== -1) j += 1;
        while (j < text.length && CLOSERS.indexOf(text[j]) !== -1) j += 1;

        const followedBySpace = j >= text.length || /\s/.test(text[j]);
        if (followedBySpace) {
          let abbreviation = false;
          if (ch === '.') {
            const prev = i > 0 ? text[i - 1] : '';
            const next = j < text.length ? text[j] : '';
            const decimal = /\d/.test(prev) && j < text.length && /\d/.test(text[j + 1] || '');
            if (!decimal) abbreviation = isAbbreviation(text, i);
          }

          let nextIsLower = false;
          if (j < text.length) {
            let k = j;
            while (k < text.length && /\s/.test(text[k])) k += 1;
            nextIsLower = /[a-z]/.test(text[k] || '');
          }

          if (!abbreviation && !nextIsLower) {
            push(start, j);
            start = j;
          }
        }
        i = j;
        continue;
      }

      i += 1;
    }

    push(start, text.length);
    return out;
  }

  return { splitSentences, chunkRange, isAbbreviation, ABBREVIATIONS };
});
