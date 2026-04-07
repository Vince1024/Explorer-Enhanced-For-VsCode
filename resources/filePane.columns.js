'use strict';
(function () {
  let vscodeApi;
  let gridEl;
  let gridHeadEl;
  let getShowGitStatus;
  let getShowProblemsInFiles;
  let persistedDetailColWidthsPxBoot;
  let defaultDetailColWidthsPxBoot;

  /** Fallback if boot omits limits (must match extension defaults in filePaneWebviewSupport.ts). */
  const FALLBACK_MIN_PX = [20, 20, 20];
  const FALLBACK_MAX_PX = [480, 280, 220];

  let minDetailPx = FALLBACK_MIN_PX.slice();
  let maxDetailPx = FALLBACK_MAX_PX.slice();

  /** Webview memento: detail layout pixel widths [Modified, Size, Status]. */
  const COL_PX_KEY = 'filePaneDetailColWidthsPx';
  /** Legacy webview memento: fractional widths (migrated once to {@link COL_PX_KEY}). */
  const COL_FRACS_LEGACY_KEY = 'filePaneColFracs';

  function clampDetailPx(v, idx) {
    return Math.min(maxDetailPx[idx], Math.max(minDetailPx[idx], Math.round(v)));
  }

  function normalizeDetailPx(arr) {
    if (!Array.isArray(arr) || arr.length !== 3) return null;
    const x = arr[0];
    const y = arr[1];
    const z = arr[2];
    if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number') return null;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
    return [clampDetailPx(x, 0), clampDetailPx(y, 1), clampDetailPx(z, 2)];
  }

  /** Webview-only legacy fracs (mirrors normalizeColFracs in filePaneWebviewSupport.ts). */
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

  function loadDetailColPx() {
    const st = vscodeApi.getState() || {};
    /* Workspace boot (extension) is source of truth; memento can lag after reload or differ from workspaceState. */
    const fromWs = normalizeDetailPx(persistedDetailColWidthsPxBoot);
    const fromMem = normalizeDetailPx(st[COL_PX_KEY]);
    if (fromWs) {
      if (!fromMem || fromMem[0] !== fromWs[0] || fromMem[1] !== fromWs[1] || fromMem[2] !== fromWs[2]) {
        vscodeApi.setState({ ...st, [COL_PX_KEY]: fromWs.slice() });
      }
      return fromWs.slice();
    }
    if (fromMem) return fromMem.slice();
    const oldFracs = normalizeFracs(st[COL_FRACS_LEGACY_KEY]);
    if (oldFracs) {
      const tw = (gridEl && gridEl.getBoundingClientRect().width) || 720;
      return [
        clampDetailPx(oldFracs[1] * tw, 0),
        clampDetailPx(oldFracs[2] * tw, 1),
        clampDetailPx(oldFracs[3] * tw, 2),
      ];
    }
    return defaultDetailColWidthsPxBoot.slice();
  }

  /** Apply host/workspace triple; memento + internal state only (caller runs {@link applyColWidths} if needed). */
  function syncDetailColWidthsFromHost(raw) {
    const n = normalizeDetailPx(raw);
    if (!n) return;
    detailColPx = n;
    const st = vscodeApi.getState() || {};
    vscodeApi.setState({ ...st, [COL_PX_KEY]: detailColPx.slice() });
  }

  function saveDetailColPx(arr) {
    detailColPx = arr.slice();
    const s = { ...(vscodeApi.getState() || {}), [COL_PX_KEY]: detailColPx };
    delete s[COL_FRACS_LEGACY_KEY];
    vscodeApi.setState(s);
    vscodeApi.postMessage({ type: 'saveDetailColWidthsPx', detailColWidthsPx: detailColPx });
  }

  /** @type {number[]|null} */
  let detailColPx = null;

  /** Drag on column edge i: moving handle right widens column to the left of edge (Name absorbs). */
  function tripleAfterEdgeDrag(startTriple, edgeIndex, dx) {
    const next = startTriple.slice();
    next[edgeIndex] = clampDetailPx(startTriple[edgeIndex] - dx, edgeIndex);
    return next;
  }

  /** Fourth col: Git/Problems — list hides via removeProperty; detail uses 0 width when off. */
  function setFourthColGitProb(cols, listLayout, gitOrProb, statusPx) {
    cols[3].style.removeProperty('min-width');
    if (!gitOrProb) {
      if (listLayout) {
        cols[3].style.removeProperty('width');
      } else {
        cols[3].style.setProperty('width', '0', 'important');
      }
      return;
    }
    cols[3].style.setProperty('width', statusPx + 'px', 'important');
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
    const gp = showGit || showProb;

    if (list) {
      cols[1].style.width = '0';
      cols[2].style.width = '0';
      cols[0].style.removeProperty('width');
      setFourthColGitProb(cols, true, gp, detailColPx[2]);
      return;
    }

    cols[0].style.removeProperty('width');
    cols[1].style.width = detailColPx[0] + 'px';
    cols[2].style.width = detailColPx[1] + 'px';
    setFourthColGitProb(cols, false, gp, detailColPx[2]);
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
          const startTriple = detailColPx.slice();
          handle.classList.add('active');
          function onListMove(ev) {
            const dx = ev.clientX - startX;
            detailColPx = tripleAfterEdgeDrag(startTriple, 2, dx);
            applyColWidths();
          }
          function onListUp() {
            handle.classList.remove('active');
            document.removeEventListener('mousemove', onListMove);
            document.removeEventListener('mouseup', onListUp);
            saveDetailColPx(detailColPx);
          }
          document.addEventListener('mousemove', onListMove);
          document.addEventListener('mouseup', onListUp);
          return;
        }
        const edgeIndex = parseInt(edgeAttr, 10);
        if (edgeIndex !== 0 && edgeIndex !== 1 && edgeIndex !== 2) return;
        if (document.body.classList.contains('explorer-enhanced-layout-list')) return;
        if (edgeIndex === 2 && !getShowGitStatus() && !getShowProblemsInFiles()) {
          return;
        }
        const startX = e.clientX;
        const startPx = detailColPx.slice();
        handle.classList.add('active');
        function onMove(ev) {
          const dx = ev.clientX - startX;
          detailColPx = tripleAfterEdgeDrag(startPx, edgeIndex, dx);
          applyColWidths();
        }
        function onUp() {
          handle.classList.remove('active');
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          saveDetailColPx(detailColPx);
        }
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    });
  }

  function readLimitTriple(raw, fallback) {
    if (!Array.isArray(raw) || raw.length !== 3) return fallback.slice();
    const out = [];
    for (let i = 0; i < 3; i++) {
      const n = raw[i];
      out[i] = typeof n === 'number' && Number.isFinite(n) ? n : fallback[i];
    }
    return out;
  }

  /**
   * @param {{ vscode: object; gridEl: HTMLElement; gridHeadEl: HTMLElement; getShowGitStatus: () => boolean; getShowProblemsInFiles: () => boolean; persistedDetailColWidthsPx: unknown; defaultDetailColWidthsPx: number[]; detailColMinPx?: unknown; detailColMaxPx?: unknown }} opts
   */
  function init(opts) {
    vscodeApi = opts.vscode;
    gridEl = opts.gridEl;
    gridHeadEl = opts.gridHeadEl;
    getShowGitStatus = opts.getShowGitStatus;
    getShowProblemsInFiles = opts.getShowProblemsInFiles;
    persistedDetailColWidthsPxBoot = opts.persistedDetailColWidthsPx;
    defaultDetailColWidthsPxBoot = Array.isArray(opts.defaultDetailColWidthsPx)
      ? opts.defaultDetailColWidthsPx
      : [188, 96, 96];
    minDetailPx = readLimitTriple(opts.detailColMinPx, FALLBACK_MIN_PX);
    maxDetailPx = readLimitTriple(opts.detailColMaxPx, FALLBACK_MAX_PX);
    detailColPx = loadDetailColPx();
    applyColWidths();
    wireColumnResize();
  }

  globalThis.FilePaneColumns = { init, applyColWidths, syncDetailColWidthsFromHost };
})();
