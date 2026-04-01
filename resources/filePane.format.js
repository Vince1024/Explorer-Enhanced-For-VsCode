'use strict';
(function () {
  /** @param {number} n */
  function fmtSizeBytes(n) {
    if (n < 1024) return n + ' B';
    const kb = n / 1024;
    if (kb < 1024) return kb.toFixed(1) + ' KB';
    const mb = kb / 1024;
    if (mb < 1024) return mb.toFixed(1) + ' MB';
    const gb = mb / 1024;
    return gb.toFixed(2) + ' GB';
  }

  globalThis.FilePaneFormat = { fmtSizeBytes };
})();
