'use strict';
(function () {
  let vscodeApi;
  let bodyEl;
  let gridEl;
  let gridHeadEl;
  let getShowGitStatus;
  let getShowProblemsInFiles;
  let getShowFolderSize;

  const Format = globalThis.FilePaneFormat;
  if (!Format || typeof Format.fmtSizeBytes !== 'function') {
    throw new Error('explorer-enhanced: FilePaneFormat missing (load filePane.format.js before filePane.table.js)');
  }

  const SORT_STATE_KEY = 'filePaneSort';

  const DATE_FORMATS = new Set(['locale', 'localeDate', 'localeTime', 'iso', 'relative', 'custom']);
  let dateTimeFormat = 'locale';
  let dateTimeCustomPattern = '';

  let sortState = { key: 'name', dir: 'asc' };
  let rawRows = [];
  /** @type {((sorted: unknown[]) => void) | null} */
  let afterSortRender = null;

  function isIconLayout() {
    return document.body.classList.contains('explorer-enhanced-layout-icons');
  }

  function loadSortState() {
    const s = vscodeApi.getState() || {};
    const x = s[SORT_STATE_KEY];
    if (x && ['name', 'mtime', 'size'].includes(x.key) && (x.dir === 'asc' || x.dir === 'desc')) {
      return { key: x.key, dir: x.dir };
    }
    return { key: 'name', dir: 'asc' };
  }

  function saveSortState() {
    vscodeApi.setState({ ...(vscodeApi.getState() || {}), [SORT_STATE_KEY]: { key: sortState.key, dir: sortState.dir } });
  }

  function fmtDateCustom(ms, pat) {
    if (!pat || typeof pat !== 'string') return '—';
    try {
      const d = new Date(ms);
      const pad = (n, len) => String(Math.floor(n)).padStart(len, '0');
      const Y = d.getFullYear();
      const Mo = d.getMonth() + 1;
      const Da = d.getDate();
      const H = d.getHours();
      const Mi = d.getMinutes();
      const Se = d.getSeconds();
      const Ms = d.getMilliseconds();
      let out = pat;
      const reps = [
        ['YYYY', String(Y)],
        ['yyyy', String(Y)],
        ['YY', pad(Y % 100, 2)],
        ['yy', pad(Y % 100, 2)],
        ['MM', pad(Mo, 2)],
        ['DD', pad(Da, 2)],
        ['HH', pad(H, 2)],
        ['mm', pad(Mi, 2)],
        ['ss', pad(Se, 2)],
        ['SSS', pad(Ms, 3)],
      ];
      for (let i = 0; i < reps.length; i++) {
        const tok = reps[i][0];
        const val = reps[i][1];
        out = out.split(tok).join(val);
      }
      return out;
    } catch {
      return '—';
    }
  }

  function fmtRelative(ms) {
    try {
      const diffSec = Math.round((Date.now() - ms) / 1000);
      const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
      if (diffSec < 45) return rtf.format(-diffSec, 'second');
      const diffMin = Math.round(diffSec / 60);
      if (diffMin < 60) return rtf.format(-diffMin, 'minute');
      const diffHr = Math.round(diffMin / 60);
      if (diffHr < 48) return rtf.format(-diffHr, 'hour');
      const diffDay = Math.round(diffHr / 24);
      if (diffDay < 14) return rtf.format(-diffDay, 'day');
      const diffWeek = Math.round(diffDay / 7);
      if (diffWeek < 8) return rtf.format(-diffWeek, 'week');
      const diffMonth = Math.round(diffDay / 30);
      if (diffMonth < 12) return rtf.format(-diffMonth, 'month');
      const diffYear = Math.round(diffDay / 365);
      return rtf.format(-diffYear, 'year');
    } catch {
      try {
        return new Date(ms).toLocaleDateString();
      } catch {
        return '—';
      }
    }
  }

  function fmtDate(ms) {
    if (!ms) return '—';
    try {
      const d = new Date(ms);
      switch (dateTimeFormat) {
        case 'localeDate':
          return d.toLocaleDateString();
        case 'localeTime':
          return d.toLocaleTimeString();
        case 'iso':
          return d.toISOString();
        case 'relative':
          return fmtRelative(ms);
        case 'custom':
          return fmtDateCustom(ms, dateTimeCustomPattern);
        default:
          return d.toLocaleString();
      }
    } catch {
      return '—';
    }
  }

  function fmtSizeBytes(n) {
    return Format.fmtSizeBytes(n);
  }

  function fmtSize(n, rowKind) {
    if (rowKind === 'folder') {
      if (typeof getShowFolderSize !== 'function' || !getShowFolderSize()) return '—';
      return fmtSizeBytes(n);
    }
    return fmtSizeBytes(n);
  }

  function folderSizeSpinnerEl() {
    const sp = document.createElement('span');
    sp.className = 'codicon codicon-loading explorer-enhanced-folder-size-spin';
    sp.setAttribute('aria-label', 'Calcul de la taille du dossier');
    sp.title = 'Calcul de la taille…';
    return sp;
  }

  function updateSortIndicators() {
    for (const th of gridHeadEl.querySelectorAll('th[data-sort]')) {
      const key = th.getAttribute('data-sort');
      const ind = th.querySelector('.sort-indicator');
      if (!ind) continue;
      if (key === sortState.key) {
        ind.textContent = sortState.dir === 'asc' ? ' ▲' : ' ▼';
        th.setAttribute('aria-sort', sortState.dir === 'asc' ? 'ascending' : 'descending');
      } else {
        ind.textContent = '';
        th.removeAttribute('aria-sort');
      }
    }
  }

  function compareRows(a, b) {
    if (sortState.key === 'name') {
      const kindCmp = (a.kind === 'folder' ? 0 : 1) - (b.kind === 'folder' ? 0 : 1);
      if (kindCmp !== 0) return kindCmp;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    }
    if (sortState.key === 'mtime') {
      return (a.mtime || 0) - (b.mtime || 0);
    }
    return (a.size || 0) - (b.size || 0);
  }

  function appendProbBadge(wrap, n, cls, titleSuffix) {
    if (!n) return;
    const s = document.createElement('span');
    s.className = 'prob-badge prob-badge--' + cls;
    s.textContent = String(n);
    s.title = n + ' ' + titleSuffix;
    wrap.appendChild(s);
  }

  function probTotal(pr) {
    return (pr.errors || 0) + (pr.warnings || 0) + (pr.infos || 0);
  }

  function probDominantClass(pr) {
    if (pr.errors) return 'error';
    if (pr.warnings) return 'warning';
    return 'info';
  }

  function renderFileRows(rows) {
    const Icons = globalThis.FilePaneIcons;
    const Menus = globalThis.FilePaneMenus;
    const showGit = getShowGitStatus();
    const showProb = getShowProblemsInFiles();
    bodyEl.replaceChildren();
    for (const r of rows) {
      const tr = document.createElement('tr');
      tr.dataset.path = r.path;
      if (r.kind === 'folder') tr.dataset.kind = 'folder';

      const tdName = document.createElement('td');
      tdName.className = 'name-cell';
      const nameRow = document.createElement('div');
      nameRow.className = 'name-row';
      const iconWrap = document.createElement('span');
      iconWrap.className = 'file-icon';
      const ic = Icons.iconForEntry(r);
      iconWrap.appendChild(Icons.svgIcon(ic.d, ic.fill));
      const nameSpan = document.createElement('span');
      nameSpan.className = 'file-name';
      nameSpan.textContent = r.name;
      nameRow.appendChild(iconWrap);
      nameRow.appendChild(nameSpan);
      tdName.appendChild(nameRow);

      const tdMod = document.createElement('td');
      tdMod.textContent = fmtDate(r.mtime);

      const tdSize = document.createElement('td');
      tdSize.className = 'num';
      if (
        r.kind === 'folder' &&
        typeof getShowFolderSize === 'function' &&
        getShowFolderSize() &&
        r.folderSizePending
      ) {
        tdSize.appendChild(folderSizeSpinnerEl());
      } else {
        tdSize.textContent = fmtSize(r.size, r.kind);
      }

      const tdStatus = document.createElement('td');
      tdStatus.className = 'status-cell';
      const statusInner = document.createElement('div');
      statusInner.className = 'status-cell-inner';

      const gitWrap = document.createElement('span');
      gitWrap.className = 'status-cell-git';
      if (showGit && r.git && r.git.primary && r.git.primary.letter) {
        const isFolder = r.kind === 'folder';
        const addBadge = (badge) => {
          const k = badge.kind || 'none';
          if (isFolder) {
            const dot = document.createElement('span');
            dot.className = 'git-dot git-dot--' + k;
            dot.setAttribute('role', 'img');
            dot.setAttribute('aria-label', k);
            dot.title = k;
            gitWrap.appendChild(dot);
          } else {
            const span = document.createElement('span');
            span.className = 'git-letter git-letter--' + k;
            span.textContent = badge.letter;
            span.title = k;
            gitWrap.appendChild(span);
          }
        };
        addBadge(r.git.primary);
        if (!isFolder && r.git.secondary && r.git.secondary.letter) {
          addBadge(r.git.secondary);
        }
      }

      const probWrap = document.createElement('span');
      probWrap.className = 'status-cell-prob';
      const pr = showProb ? r.problems : null;
      const totalPb = pr ? probTotal(pr) : 0;
      const hasGitContent = gitWrap.childNodes.length > 0;

      if (totalPb > 0 && hasGitContent) {
        const num = document.createElement('span');
        num.className = 'prob-badge prob-badge--' + probDominantClass(pr);
        num.textContent = String(totalPb);
        num.title = totalPb + ' problem(s)';
        probWrap.appendChild(num);
        const sep = document.createElement('span');
        sep.className = 'status-cell-sep';
        sep.textContent = ', ';
        sep.setAttribute('aria-hidden', 'true');
        statusInner.appendChild(probWrap);
        statusInner.appendChild(sep);
        statusInner.appendChild(gitWrap);
      } else {
        if (totalPb > 0) {
          const wrap = document.createElement('span');
          wrap.className = 'prob-badges';
          appendProbBadge(wrap, pr.errors, 'error', pr.errors === 1 ? 'error' : 'errors');
          appendProbBadge(wrap, pr.warnings, 'warning', pr.warnings === 1 ? 'warning' : 'warnings');
          appendProbBadge(wrap, pr.infos, 'info', pr.infos === 1 ? 'info / hint' : 'infos / hints');
          probWrap.appendChild(wrap);
        }
        statusInner.appendChild(probWrap);
        statusInner.appendChild(gitWrap);
      }
      tdStatus.appendChild(statusInner);

      tr.appendChild(tdName);
      tr.appendChild(tdMod);
      tr.appendChild(tdSize);
      tr.appendChild(tdStatus);
      tr.addEventListener('click', () => {
        if (r.kind === 'folder') return;
        vscodeApi.postMessage({ type: 'openFile', path: r.path, preview: true });
      });
      tr.addEventListener('dblclick', (e) => {
        e.preventDefault();
        if (r.kind === 'folder') {
          vscodeApi.postMessage({ type: 'openFolder', path: r.path });
          return;
        }
        vscodeApi.postMessage({ type: 'openFile', path: r.path, preview: false });
      });
      tr.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        Menus.showFileCtxMenu(e.clientX, e.clientY, r.path, r.kind === 'folder' ? 'folder' : 'file');
      });
      bodyEl.appendChild(tr);
    }
  }

  /** @param {boolean} enabled @param {Set<string>} pathSet */
  function applyOpenEditorHighlights(enabled, pathSet) {
    if (!bodyEl) return;
    for (const tr of bodyEl.querySelectorAll('tr[data-path]')) {
      if (tr.dataset.kind === 'folder') {
        tr.classList.remove('files-open-in-editor');
        continue;
      }
      const p = tr.dataset.path;
      const on = !!(enabled && p && pathSet && pathSet.has(p));
      tr.classList.toggle('files-open-in-editor', on);
    }
  }

  function applySortAndRender() {
    const mult = sortState.dir === 'asc' ? 1 : -1;
    const sorted = rawRows.slice().sort((a, b) => mult * compareRows(a, b));
    if (isIconLayout()) {
      bodyEl.replaceChildren();
    } else {
      renderFileRows(sorted);
    }
    updateSortIndicators();
    if (afterSortRender) {
      try {
        afterSortRender(sorted);
      } catch {
        /* ignore */
      }
    }
  }

  /** @param {((sorted: unknown[]) => void) | null} fn */
  function setAfterSortRender(fn) {
    afterSortRender = typeof fn === 'function' ? fn : null;
  }

  function wireSortHeaderClick() {
    const tr = gridHeadEl.querySelector('thead tr');
    if (!tr) return;
    tr.addEventListener('click', (e) => {
      if (e.target.closest('.col-resize-handle')) return;
      const th = e.target.closest('th[data-sort]');
      if (!th) return;
      const key = th.getAttribute('data-sort');
      if (key !== 'name' && key !== 'mtime' && key !== 'size') return;
      if (sortState.key === key) {
        sortState = { key, dir: sortState.dir === 'asc' ? 'desc' : 'asc' };
      } else {
        const dir = key === 'name' ? 'asc' : 'desc';
        sortState = { key, dir };
      }
      saveSortState();
      applySortAndRender();
    });
  }

  /** @param {{ vscode: object; bodyEl: HTMLElement; gridEl: HTMLElement; gridHeadEl: HTMLElement; getShowGitStatus: () => boolean; getShowProblemsInFiles: () => boolean; getShowFolderSize?: () => boolean; dateTimeCustomPatternBoot: unknown }} opts */
  function init(opts) {
    vscodeApi = opts.vscode;
    bodyEl = opts.bodyEl;
    gridEl = opts.gridEl;
    gridHeadEl = opts.gridHeadEl;
    getShowGitStatus = opts.getShowGitStatus;
    getShowProblemsInFiles = opts.getShowProblemsInFiles;
    getShowFolderSize = typeof opts.getShowFolderSize === 'function' ? opts.getShowFolderSize : () => false;
    dateTimeCustomPattern =
      typeof opts.dateTimeCustomPatternBoot === 'string' ? opts.dateTimeCustomPatternBoot : '';
    sortState = loadSortState();
    wireSortHeaderClick();
  }

  function setDateTimeFormat(f) {
    dateTimeFormat = f;
  }

  function setDateTimeCustomPattern(p) {
    dateTimeCustomPattern = p.length > 120 ? p.slice(0, 120) : p;
  }

  function replaceRows(rows) {
    rawRows = Array.isArray(rows) ? rows.slice() : [];
  }

  globalThis.FilePaneTable = {
    init,
    DATE_FORMATS,
    setDateTimeFormat,
    setDateTimeCustomPattern,
    replaceRows,
    applySortAndRender,
    setAfterSortRender,
    applyOpenEditorHighlights,
  };
})();
