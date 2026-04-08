'use strict';
(function () {
  const MATCH_CLASS = 'explorer-enhanced-name-filter-match';

  /**
   * Fills `el` with `rawName`, wrapping each case-insensitive occurrence of `filterNorm` in a span.
   * `filterNorm` must be the same normalized query as {@link nameFilterNorm} in the table module (trim + toLocaleLowerCase).
   * @param {HTMLElement} el
   * @param {string} rawName
   * @param {string} filterNorm
   */
  function appendNameWithFilterHighlights(el, rawName, filterNorm) {
    el.replaceChildren();
    const name = typeof rawName === 'string' ? rawName : '';
    if (!filterNorm || !name) {
      el.textContent = name;
      return;
    }
    const lower = name.toLocaleLowerCase();
    const q = filterNorm;
    let pos = 0;
    while (pos < name.length) {
      const idx = lower.indexOf(q, pos);
      if (idx === -1) {
        el.appendChild(document.createTextNode(name.slice(pos)));
        break;
      }
      if (idx > pos) {
        el.appendChild(document.createTextNode(name.slice(pos, idx)));
      }
      const mark = document.createElement('span');
      mark.className = MATCH_CLASS;
      mark.textContent = name.slice(idx, idx + q.length);
      el.appendChild(mark);
      pos = idx + q.length;
    }
  }

  globalThis.FilePaneFilterHighlight = {
    appendNameWithFilterHighlights,
    MATCH_CLASS,
  };
})();
