'use strict';
(function () {
  let paneEl;
  let vscodeApi;
  let getShowGitStatus;
  let getShowProblemsInFiles;
  let getShowFolderSize;

  const Format = globalThis.FilePaneFormat;
  if (!Format || typeof Format.fmtSizeBytes !== 'function') {
    throw new Error('explorer-enhanced: FilePaneFormat missing (load filePane.format.js before filePane.iconGrid.js)');
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
      const hasGit = showGit && r.git && r.git.letter;
      const k = hasGit ? r.git.kind || 'none' : 'none';

      if (totalPb > 0 && hasGit) {
        const combo = document.createElement('span');
        combo.className = 'files-icon-tile-combo';
        const num = document.createElement('span');
        num.className = 'prob-badge prob-badge--' + probDominantClass(pr);
        num.textContent = String(totalPb);
        num.title = totalPb + ' problem(s)';
        combo.appendChild(num);
        combo.appendChild(document.createTextNode(', '));
        if (r.kind === 'folder') {
          const dot = document.createElement('span');
          dot.className = 'git-dot git-dot--' + k;
          dot.setAttribute('role', 'img');
          dot.setAttribute('aria-label', k);
          dot.title = k;
          combo.appendChild(dot);
        } else {
          const span = document.createElement('span');
          span.className = 'git-letter git-letter--' + k;
          span.textContent = r.git.letter;
          span.title = k;
          combo.appendChild(span);
        }
        badgeRow.appendChild(combo);
      } else if (totalPb > 0) {
        const wrap = document.createElement('span');
        wrap.className = 'prob-badges';
        appendProbBadge(wrap, pr.errors, 'error', pr.errors === 1 ? 'error' : 'errors');
        appendProbBadge(wrap, pr.warnings, 'warning', pr.warnings === 1 ? 'warning' : 'warnings');
        appendProbBadge(wrap, pr.infos, 'info', pr.infos === 1 ? 'info / hint' : 'infos / hints');
        badgeRow.appendChild(wrap);
      } else if (hasGit) {
        if (r.kind === 'folder') {
          const dot = document.createElement('span');
          dot.className = 'git-dot git-dot--' + k;
          dot.setAttribute('role', 'img');
          dot.setAttribute('aria-label', k);
          dot.title = k;
          badgeRow.appendChild(dot);
        } else {
          const span = document.createElement('span');
          span.className = 'git-letter git-letter--' + k;
          span.textContent = r.git.letter;
          span.title = k;
          badgeRow.appendChild(span);
        }
      }

      const label = document.createElement('div');
      label.className = 'files-icon-tile-label';
      label.textContent = r.name;

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
          sp.setAttribute('aria-label', 'Calcul de la taille du dossier');
          sp.title = 'Calcul de la taille…';
          meta.appendChild(sp);
        } else {
          meta.textContent = fmtSizeBytes(r.size || 0);
        }
        tile.appendChild(meta);
      }

      tile.addEventListener('click', () => {
        if (r.kind === 'folder') return;
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

  /** @param {{ vscode: object; paneEl: HTMLElement | null; getShowGitStatus: () => boolean; getShowProblemsInFiles: () => boolean; getShowFolderSize?: () => boolean }} opts */
  function init(opts) {
    vscodeApi = opts.vscode;
    paneEl = opts.paneEl;
    getShowGitStatus = opts.getShowGitStatus;
    getShowProblemsInFiles = opts.getShowProblemsInFiles;
    getShowFolderSize = typeof opts.getShowFolderSize === 'function' ? opts.getShowFolderSize : () => false;
  }

  globalThis.FilePaneIconGrid = { init, render, clear, applyOpenEditorHighlights };
})();
