'use strict';
(function () {
  let paneEl;
  let vscodeApi;
  let getShowGitStatus;
  let getShowProblemsInFiles;
  let getShowFolderSize;
  /** @type {((fsPath: string) => void) | null} */
  let onFolderRowSingleClick = null;
  /** @type {(() => void) | null} */
  let onClearFolderListSelection = null;

  const Format = globalThis.FilePaneFormat;
  if (!Format || typeof Format.fmtSizeBytes !== 'function') {
    throw new Error('explorer-enhanced: FilePaneFormat missing (load filePane.format.js before filePane.iconGrid.js)');
  }

  const GitBadges = globalThis.FilePaneGitBadges;
  if (!GitBadges || typeof GitBadges.incomingPairElement !== 'function') {
    throw new Error('explorer-enhanced: FilePaneGitBadges missing (load filePane.gitBadges.js before filePane.iconGrid.js)');
  }

  const FilterHighlight = globalThis.FilePaneFilterHighlight;
  if (!FilterHighlight || typeof FilterHighlight.appendNameWithFilterHighlights !== 'function') {
    throw new Error('explorer-enhanced: FilePaneFilterHighlight missing (load before filePane.iconGrid.js)');
  }

  const FilePaneTableRef = globalThis.FilePaneTable;
  if (!FilePaneTableRef || typeof FilePaneTableRef.getNameFilterNorm !== 'function') {
    throw new Error('explorer-enhanced: FilePaneTable missing (load before filePane.iconGrid.js)');
  }

  function fmtSizeBytes(n) {
    return Format.fmtSizeBytes(n);
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

  /** @param {{ errors?: number; warnings?: number; infos?: number }} pr */
  function probDominantClass(pr) {
    if (pr.errors) return 'error';
    if (pr.warnings) return 'warning';
    return 'info';
  }

  /** @param {unknown[]} sortedRows */
  function render(sortedRows) {
    if (!paneEl) return;
    const Icons = globalThis.FilePaneIcons;
    const Menus = globalThis.FilePaneMenus;
    const showGit = getShowGitStatus();
    const showProb = getShowProblemsInFiles();
    paneEl.replaceChildren();
    for (const r of sortedRows) {
      const tile = document.createElement('div');
      tile.className = 'files-icon-tile';
      tile.setAttribute('role', 'option');
      tile.tabIndex = -1;
      tile.dataset.path = r.path;
      if (r.kind === 'folder') tile.dataset.kind = 'folder';

      const iconWrap = document.createElement('div');
      iconWrap.className = 'files-icon-tile-ico';
      const ic = Icons.iconForEntry(r);
      iconWrap.appendChild(Icons.svgIcon(ic.d, ic.fill));

      const badgeRow = document.createElement('div');
      badgeRow.className = 'files-icon-tile-badges';
      const pr = r.problems;
      const totalPb = showProb && pr ? probTotal(pr) : 0;
      const g = showGit && r.git ? r.git : null;
      const isFolderRow = r.kind === 'folder';
      const hasGitLetters =
        g &&
        (GitBadges.rowHasLocalGitLetters(g, isFolderRow) ||
          (!isFolderRow && g.incoming && g.incoming.letter));
      const hasGit = !!hasGitLetters;

      function appendGitTo(container) {
        if (!g) return;
        const isFolder = isFolderRow;
        const addLetter = (badge) => {
          if (!badge || !badge.letter) return;
          const k = badge.kind || 'none';
          if (isFolder) {
            const dot = document.createElement('span');
            dot.className = 'git-dot git-dot--' + k;
            dot.setAttribute('role', 'img');
            dot.setAttribute('aria-label', k);
            dot.title = k;
            container.appendChild(dot);
          } else {
            const span = document.createElement('span');
            span.className = 'git-letter git-letter--' + k;
            span.textContent = badge.letter;
            span.title = k;
            container.appendChild(span);
          }
        };
        const incEl = !isFolder ? GitBadges.incomingPairElement(g.incoming) : null;
        if (incEl) container.appendChild(incEl);
        GitBadges.appendCommaBetweenIncomingAndLocal(container, g, isFolder);
        addLetter(g.primary);
        if (!isFolder && g.secondary) addLetter(g.secondary);
      }

      if (totalPb > 0 && hasGit) {
        const combo = document.createElement('span');
        combo.className = 'files-icon-tile-combo';
        const num = document.createElement('span');
        num.className = 'prob-badge prob-badge--' + probDominantClass(pr);
        num.textContent = String(totalPb);
        num.title = totalPb + ' problem(s)';
        combo.appendChild(num);
        combo.appendChild(document.createTextNode(','));
        appendGitTo(combo);
        badgeRow.appendChild(combo);
      } else if (totalPb > 0) {
        const wrap = document.createElement('span');
        wrap.className = 'prob-badges';
        appendProbBadge(wrap, pr.errors, 'error', pr.errors === 1 ? 'error' : 'errors');
        appendProbBadge(wrap, pr.warnings, 'warning', pr.warnings === 1 ? 'warning' : 'warnings');
        appendProbBadge(wrap, pr.infos, 'info', pr.infos === 1 ? 'info / hint' : 'infos / hints');
        badgeRow.appendChild(wrap);
      } else if (hasGit) {
        appendGitTo(badgeRow);
      }

      const label = document.createElement('div');
      label.className = 'files-icon-tile-label';
      FilterHighlight.appendNameWithFilterHighlights(label, r.name, FilePaneTableRef.getNameFilterNorm());

      tile.appendChild(iconWrap);
      if (badgeRow.childNodes.length) {
        tile.appendChild(badgeRow);
      }
      tile.appendChild(label);
      if (r.kind === 'folder' && typeof getShowFolderSize === 'function' && getShowFolderSize()) {
        const meta = document.createElement('div');
        meta.className = 'files-icon-tile-meta';
        if (r.folderSizePending) {
          const sp = document.createElement('span');
          sp.className = 'codicon codicon-loading explorer-enhanced-folder-size-spin';
          sp.setAttribute('aria-label', 'Calculating folder size');
          sp.title = 'Calculating size…';
          meta.appendChild(sp);
        } else {
          meta.textContent = fmtSizeBytes(r.size || 0);
        }
        tile.appendChild(meta);
      }

      tile.addEventListener('click', () => {
        if (r.kind === 'folder') {
          if (typeof onFolderRowSingleClick === 'function') {
            onFolderRowSingleClick(r.path);
          }
          return;
        }
        if (typeof onClearFolderListSelection === 'function') {
          onClearFolderListSelection();
        }
        vscodeApi.postMessage({ type: 'openFile', path: r.path, preview: true });
      });
      tile.addEventListener('dblclick', (e) => {
        e.preventDefault();
        if (r.kind === 'folder') {
          vscodeApi.postMessage({ type: 'openFolder', path: r.path });
          return;
        }
        vscodeApi.postMessage({ type: 'openFile', path: r.path, preview: false });
      });
      tile.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        Menus.showFileCtxMenu(e.clientX, e.clientY, r.path, r.kind === 'folder' ? 'folder' : 'file');
      });
      paneEl.appendChild(tile);
    }
  }

  function clear() {
    if (paneEl) paneEl.replaceChildren();
  }

  /** @param {boolean} enabled @param {Set<string>} pathSet */
  function applyOpenEditorHighlights(enabled, pathSet) {
    if (!paneEl) return;
    for (const tile of paneEl.querySelectorAll('.files-icon-tile[data-path]')) {
      if (tile.dataset.kind === 'folder') {
        tile.classList.remove('files-open-in-editor');
        continue;
      }
      const p = tile.dataset.path;
      tile.classList.toggle('files-open-in-editor', !!(enabled && p && pathSet && pathSet.has(p)));
    }
  }

  /** @param {{ vscode: object; paneEl: HTMLElement | null; getShowGitStatus: () => boolean; getShowProblemsInFiles: () => boolean; getShowFolderSize?: () => boolean; onFolderRowSingleClick?: (fsPath: string) => void; onClearFolderListSelection?: () => void }} opts */
  function init(opts) {
    vscodeApi = opts.vscode;
    paneEl = opts.paneEl;
    getShowGitStatus = opts.getShowGitStatus;
    getShowProblemsInFiles = opts.getShowProblemsInFiles;
    getShowFolderSize = typeof opts.getShowFolderSize === 'function' ? opts.getShowFolderSize : () => false;
    onFolderRowSingleClick = typeof opts.onFolderRowSingleClick === 'function' ? opts.onFolderRowSingleClick : null;
    onClearFolderListSelection = typeof opts.onClearFolderListSelection === 'function' ? opts.onClearFolderListSelection : null;
  }

  globalThis.FilePaneIconGrid = { init, render, clear, applyOpenEditorHighlights };
})();
