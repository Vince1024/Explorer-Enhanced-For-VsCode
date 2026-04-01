'use strict';
(function () {
  let vscodeApi;
  let gridEl;
  let gridHeadEl;
  let getShowGitStatus;
  let getShowProblemsInFiles;
  let persistedColFracs;
  let defaultColFracs;

  const COL_FRACS_KEY = 'filePaneColFracs';
  const MIN_COL_FRAC = 0.08;

  const LIST_NAME_FRAC_KEY = 'filePaneListNameColFrac';
  const MIN_LIST_NAME_FRAC = 0.5;
  const MAX_LIST_NAME_FRAC = 0.97;

  function normalizeFracs(f) {
    if (!Array.isArray(f) || !f.every((n) => typeof n === 'number' && n > 0)) return null;
    let arr;
    if (f.length === 4) {
      arr = f.slice();
    } else if (f.length === 3) {
      const c = f[2];
      const take = Math.min(c * 0.28, 0.14);
      arr = [f[0], f[1], c - take, take];
      if (arr[2] <= 0) return null;
    } else {
      return null;
    }
    const sum = arr[0] + arr[1] + arr[2] + arr[3];
    if (sum <= 0) return null;
    return arr.map((x) => x / sum);
  }

  function loadColFracs() {
    const mem = normalizeFracs((vscodeApi.getState() || {})[COL_FRACS_KEY]);
    if (mem) return mem;
    const fromWorkspace = normalizeFracs(persistedColFracs);
    if (fromWorkspace) return fromWorkspace;
    return defaultColFracs.slice();
  }

  function saveColFracs(fracs) {
    const s = { ...(vscodeApi.getState() || {}), [COL_FRACS_KEY]: fracs };
    vscodeApi.setState(s);
    vscodeApi.postMessage({ type: 'saveColFracs', fracs });
  }

  let colFracs = null;

  function normalizeListNameFrac(f) {
    if (typeof f !== 'number' || !Number.isFinite(f)) return null;
    if (f < MIN_LIST_NAME_FRAC || f > MAX_LIST_NAME_FRAC) return null;
    return f;
  }

  function loadListNameColFrac(listNameColFracBoot) {
    const mem = normalizeListNameFrac((vscodeApi.getState() || {})[LIST_NAME_FRAC_KEY]);
    if (mem !== null) return mem;
    const b = listNameColFracBoot;
    if (typeof b === 'number' && normalizeListNameFrac(b) !== null) return b;
    return 0.88;
  }

  let listNameColFrac = null;

  function saveListNameColFrac(f) {
    listNameColFrac = Math.min(MAX_LIST_NAME_FRAC, Math.max(MIN_LIST_NAME_FRAC, f));
    const s = { ...(vscodeApi.getState() || {}), [LIST_NAME_FRAC_KEY]: listNameColFrac };
    vscodeApi.setState(s);
    vscodeApi.postMessage({ type: 'saveListNameColFrac', listNameColFrac });
  }

  function applyColWidthsToTable(tableEl) {
    const cols = tableEl.querySelectorAll('colgroup col');
    if (cols.length < 4) {
      return;
    }
    if (document.body.classList.contains('explorer-enhanced-layout-icons')) {
      return;
    }
    const list = document.body.classList.contains('explorer-enhanced-layout-list');
    const showGit = getShowGitStatus();
    const showProb = getShowProblemsInFiles();
    if (list) {
      cols[1].style.width = '0';
      cols[2].style.width = '0';
      if (showGit || showProb) {
        const wName = (listNameColFrac * 100).toFixed(2) + '%';
        const wStatus = ((1 - listNameColFrac) * 100).toFixed(2) + '%';
        cols[0].style.setProperty('width', wName, 'important');
        cols[3].style.setProperty('width', wStatus, 'important');
      } else {
        cols[0].style.removeProperty('width');
        cols[3].style.removeProperty('width');
      }
      return;
    }
    if (!showGit && !showProb) {
      const s = colFracs[0] + colFracs[1] + colFracs[2];
      if (s > 0) {
        for (let i = 0; i < 3; i++) {
          cols[i].style.width = ((colFracs[i] / s) * 100).toFixed(2) + '%';
        }
      }
      cols[3].style.setProperty('width', '0', 'important');
    } else {
      for (let i = 0; i < 4; i++) {
        cols[i].style.width = (colFracs[i] * 100).toFixed(2) + '%';
      }
    }
  }

  function applyColWidths() {
    applyColWidthsToTable(gridEl);
    applyColWidthsToTable(gridHeadEl);
  }

  function wireColumnResize() {
    gridHeadEl.querySelectorAll('.col-resize-handle').forEach((handle) => {
      handle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const edgeAttr = handle.getAttribute('data-col-edge');
        if (edgeAttr === 'list') {
          if (
            !document.body.classList.contains('explorer-enhanced-layout-list') ||
            (!getShowGitStatus() && !getShowProblemsInFiles())
          ) {
            return;
          }
          const startX = e.clientX;
          const startFrac = listNameColFrac;
          const tw = gridEl.getBoundingClientRect().width || gridHeadEl.getBoundingClientRect().width || 1;
          handle.classList.add('active');
          function onListMove(ev) {
            const d = (ev.clientX - startX) / tw;
            listNameColFrac = Math.min(
              MAX_LIST_NAME_FRAC,
              Math.max(MIN_LIST_NAME_FRAC, startFrac - d)
            );
            applyColWidths();
          }
          function onListUp() {
            handle.classList.remove('active');
            document.removeEventListener('mousemove', onListMove);
            document.removeEventListener('mouseup', onListUp);
            saveListNameColFrac(listNameColFrac);
          }
          document.addEventListener('mousemove', onListMove);
          document.addEventListener('mouseup', onListUp);
          return;
        }
        const edgeIndex = parseInt(edgeAttr, 10);
        if (edgeIndex !== 0 && edgeIndex !== 1 && edgeIndex !== 2) return;
        if (edgeIndex === 2 && !getShowGitStatus() && !getShowProblemsInFiles()) {
          return;
        }
        const startX = e.clientX;
        const startFracs = colFracs.slice();
        const tw = gridEl.getBoundingClientRect().width || gridHeadEl.getBoundingClientRect().width || 1;
        handle.classList.add('active');
        function onMove(ev) {
          const d = (ev.clientX - startX) / tw;
          const f = startFracs.slice();
          f[edgeIndex] = startFracs[edgeIndex] + d;
          f[edgeIndex + 1] = startFracs[edgeIndex + 1] - d;
          f[edgeIndex] = Math.max(MIN_COL_FRAC, f[edgeIndex]);
          f[edgeIndex + 1] = Math.max(MIN_COL_FRAC, f[edgeIndex + 1]);
          const sum = f[0] + f[1] + f[2] + f[3];
          colFracs = f.map((x) => x / sum);
          applyColWidths();
        }
        function onUp() {
          handle.classList.remove('active');
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          saveColFracs(colFracs);
        }
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    });
  }

  /** @param {{ vscode: object; gridEl: HTMLElement; gridHeadEl: HTMLElement; getShowGitStatus: () => boolean; getShowProblemsInFiles: () => boolean; persistedColFracs: unknown; defaultColFracs: number[]; listNameColFracBoot: unknown }} opts */
  function init(opts) {
    vscodeApi = opts.vscode;
    gridEl = opts.gridEl;
    gridHeadEl = opts.gridHeadEl;
    getShowGitStatus = opts.getShowGitStatus;
    getShowProblemsInFiles = opts.getShowProblemsInFiles;
    persistedColFracs = opts.persistedColFracs;
    defaultColFracs = opts.defaultColFracs;
    colFracs = loadColFracs();
    listNameColFrac = loadListNameColFrac(opts.listNameColFracBoot);
    applyColWidths();
    wireColumnResize();
  }

  globalThis.FilePaneColumns = { init, applyColWidths };
})();
