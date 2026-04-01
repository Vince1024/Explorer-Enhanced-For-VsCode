'use strict';
(function () {
  let vscodeApi;
  let applyColWidthsFn;

  const foldersToggleBtn = document.getElementById('foldersToggleBtn');
  const viewsMenuBtn = document.getElementById('viewsMenuBtn');
  const viewsMenuEl = document.getElementById('viewsMenu');
  const settingsMenuBtn = document.getElementById('settingsMenuBtn');
  const settingsMenuEl = document.getElementById('settingsMenu');
  const settingsGitToggleLi = document.getElementById('settingsGitToggle');
  const settingsProblemsToggleLi = document.getElementById('settingsProblemsToggle');
  const settingsFolderSizeToggleLi = document.getElementById('settingsFolderSizeToggle');
  const settingsSelectActiveFileToggleLi = document.getElementById('settingsSelectActiveFileToggle');
  const settingsHighlightOpenFilesToggleLi = document.getElementById('settingsHighlightOpenFilesToggle');
  const settingsShowPathToggleLi = document.getElementById('settingsShowPathToggle');

  let lastRevealOsTitle = 'Reveal in OS';
  let ctxMenuEl = null;

  function hideViewsMenu() {
    if (!viewsMenuEl || !viewsMenuBtn) return;
    viewsMenuEl.classList.remove('views-menu--open');
    viewsMenuEl.hidden = true;
    viewsMenuEl.style.left = '';
    viewsMenuEl.style.right = '';
    viewsMenuEl.style.top = '';
    viewsMenuEl.style.visibility = '';
    viewsMenuBtn.setAttribute('aria-expanded', 'false');
  }

  function hideSettingsMenu() {
    if (!settingsMenuEl || !settingsMenuBtn) return;
    settingsMenuEl.classList.remove('views-menu--open');
    settingsMenuEl.hidden = true;
    settingsMenuEl.style.left = '';
    settingsMenuEl.style.right = '';
    settingsMenuEl.style.top = '';
    settingsMenuEl.style.visibility = '';
    settingsMenuBtn.setAttribute('aria-expanded', 'false');
  }

  function hideTopbarDropdowns() {
    hideViewsMenu();
    hideSettingsMenu();
  }

  function toggleViewsMenu() {
    if (!viewsMenuEl || !viewsMenuBtn) return;
    const open = viewsMenuEl.classList.contains('views-menu--open');
    if (open) {
      hideViewsMenu();
      return;
    }
    hideSettingsMenu();
    const r = viewsMenuBtn.getBoundingClientRect();
    viewsMenuEl.hidden = false;
    viewsMenuEl.classList.add('views-menu--open');
    viewsMenuEl.style.visibility = 'hidden';
    const mw = viewsMenuEl.getBoundingClientRect().width;
    viewsMenuEl.style.visibility = '';
    let left = r.right - mw;
    if (left < 4) left = 4;
    if (left + mw > window.innerWidth - 4) {
      left = Math.max(4, window.innerWidth - mw - 4);
    }
    viewsMenuEl.style.left = left + 'px';
    viewsMenuEl.style.right = 'auto';
    viewsMenuEl.style.top = (r.bottom + 4) + 'px';
    viewsMenuBtn.setAttribute('aria-expanded', 'true');
  }

  function toggleSettingsMenu() {
    if (!settingsMenuEl || !settingsMenuBtn) return;
    const open = settingsMenuEl.classList.contains('views-menu--open');
    if (open) {
      hideSettingsMenu();
      return;
    }
    hideViewsMenu();
    const r = settingsMenuBtn.getBoundingClientRect();
    settingsMenuEl.hidden = false;
    settingsMenuEl.classList.add('views-menu--open');
    settingsMenuEl.style.visibility = 'hidden';
    const mw = settingsMenuEl.getBoundingClientRect().width;
    settingsMenuEl.style.visibility = '';
    let left = r.right - mw;
    if (left < 4) left = 4;
    if (left + mw > window.innerWidth - 4) {
      left = Math.max(4, window.innerWidth - mw - 4);
    }
    settingsMenuEl.style.left = left + 'px';
    settingsMenuEl.style.right = 'auto';
    settingsMenuEl.style.top = (r.bottom + 4) + 'px';
    settingsMenuBtn.setAttribute('aria-expanded', 'true');
  }

  function syncFoldersToggleUi(on) {
    if (!foldersToggleBtn) return;
    foldersToggleBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    const icon = foldersToggleBtn.querySelector('.folders-toggle-icon');
    if (icon) {
      icon.className = 'codicon folders-toggle-icon ' + (on ? 'codicon-folder' : 'codicon-file');
    }
  }

  function syncViewMenuActive(layout) {
    if (!viewsMenuEl) return;
    for (const li of viewsMenuEl.querySelectorAll('li[data-layout]')) {
      const lay = li.getAttribute('data-layout');
      const isActive = lay === layout;
      li.classList.toggle('views-menu-active', isActive);
      li.setAttribute('aria-checked', isActive ? 'true' : 'false');
    }
    const trigger = document.getElementById('viewsMenuTriggerIcon');
    if (trigger) {
      for (const svg of trigger.querySelectorAll('svg[data-layout-trigger]')) {
        const k = svg.getAttribute('data-layout-trigger');
        const show =
          (layout === 'list' && k === 'list') ||
          (layout === 'detail' && k === 'detail') ||
          (layout === 'icons' && k === 'icons');
        if (show) {
          svg.removeAttribute('hidden');
        } else {
          svg.setAttribute('hidden', '');
        }
      }
    }
  }

  /** @param {boolean} on */
  function syncSettingsGitToggle(on) {
    if (!settingsGitToggleLi) return;
    settingsGitToggleLi.classList.toggle('views-menu-active', on);
    settingsGitToggleLi.setAttribute('aria-checked', on ? 'true' : 'false');
  }

  /** @param {boolean} on */
  function syncSettingsProblemsToggle(on) {
    if (!settingsProblemsToggleLi) return;
    settingsProblemsToggleLi.classList.toggle('views-menu-active', on);
    settingsProblemsToggleLi.setAttribute('aria-checked', on ? 'true' : 'false');
  }

  const settingsRowLinesToggleLi = document.getElementById('settingsRowLinesToggle');
  const settingsColumnLinesToggleLi = document.getElementById('settingsColumnLinesToggle');

  /** @param {boolean} on */
  function syncSettingsRowLinesToggle(on) {
    if (!settingsRowLinesToggleLi) return;
    settingsRowLinesToggleLi.classList.toggle('views-menu-active', on);
    settingsRowLinesToggleLi.setAttribute('aria-checked', on ? 'true' : 'false');
  }

  /** @param {boolean} on */
  function syncSettingsColumnLinesToggle(on) {
    if (!settingsColumnLinesToggleLi) return;
    settingsColumnLinesToggleLi.classList.toggle('views-menu-active', on);
    settingsColumnLinesToggleLi.setAttribute('aria-checked', on ? 'true' : 'false');
  }

  /** @param {boolean} on */
  function syncSettingsFolderSizeToggle(on) {
    if (!settingsFolderSizeToggleLi) return;
    settingsFolderSizeToggleLi.classList.toggle('views-menu-active', on);
    settingsFolderSizeToggleLi.setAttribute('aria-checked', on ? 'true' : 'false');
  }

  /** @param {boolean} on */
  function syncSettingsSelectActiveFileToggle(on) {
    if (!settingsSelectActiveFileToggleLi) return;
    settingsSelectActiveFileToggleLi.classList.toggle('views-menu-active', on);
    settingsSelectActiveFileToggleLi.setAttribute('aria-checked', on ? 'true' : 'false');
  }

  /** @param {boolean} on */
  function syncSettingsHighlightOpenFilesToggle(on) {
    if (!settingsHighlightOpenFilesToggleLi) return;
    settingsHighlightOpenFilesToggleLi.classList.toggle('views-menu-active', on);
    settingsHighlightOpenFilesToggleLi.setAttribute('aria-checked', on ? 'true' : 'false');
  }

  /** @param {boolean} on */
  function syncSettingsShowPathToggle(on) {
    if (!settingsShowPathToggleLi) return;
    settingsShowPathToggleLi.classList.toggle('views-menu-active', on);
    settingsShowPathToggleLi.setAttribute('aria-checked', on ? 'true' : 'false');
  }

  function hideCtxMenu() {
    if (ctxMenuEl) {
      ctxMenuEl.remove();
      ctxMenuEl = null;
    }
  }

  /**
   * @param {number} clientX
   * @param {number} clientY
   * @param {string} filePath
   * @param {'file' | 'folder'} [kind]
   */
  function showFileCtxMenu(clientX, clientY, filePath, kind) {
    hideTopbarDropdowns();
    hideCtxMenu();
    const ul = document.createElement('ul');
    ul.className = 'ctx-menu';
    ul.setAttribute('role', 'menu');
    const isFolder = kind === 'folder';

    const add = (label, action, shortcutText) => {
      const li = document.createElement('li');
      li.setAttribute('role', 'menuitem');
      li.className = 'ctx-menu-row';
      const lab = document.createElement('span');
      lab.className = 'ctx-menu-label';
      lab.textContent = label;
      li.appendChild(lab);
      if (shortcutText) {
        const k = document.createElement('span');
        k.className = 'ctx-menu-key';
        k.textContent = shortcutText;
        li.appendChild(k);
      }
      li.addEventListener('click', (ev) => {
        ev.stopPropagation();
        hideCtxMenu();
        vscodeApi.postMessage({ type: 'ctx', action, path: filePath });
      });
      ul.appendChild(li);
    };
    const sep = () => {
      const li = document.createElement('li');
      li.className = 'ctx-sep';
      li.setAttribute('role', 'separator');
      ul.appendChild(li);
    };

    if (isFolder) {
      add('New File...', 'newFile');
      add('New Folder...', 'newFolder');
      add(lastRevealOsTitle, 'revealInOs', 'Shift+Alt+R');
      add('Open in Integrated Terminal', 'openInTerminal');
      sep();
      add('Add Directory to Cursor Chat', 'addToCursorChat');
      add('Add Directory to New Cursor Chat', 'addToNewCursorChat');
      sep();
      add('Find in Folder...', 'findInFolder', 'Shift+Alt+F');
      sep();
      add('Cut', 'explorerCut', 'Ctrl+X');
      add('Copy', 'explorerCopy', 'Ctrl+C');
      add('Paste', 'explorerPaste', 'Ctrl+V');
      sep();
      add('Copy Path', 'copyPath', 'Shift+Alt+C');
      add('Copy Relative Path', 'copyRelativePath', 'Ctrl+M Ctrl+Shift+C');
      sep();
      add('Run Tests', 'runTests');
      sep();
      add('Rename...', 'rename', 'F2');
      add('Delete', 'delete', 'Del');
    } else {
      add('Open to the Side', 'openToSide');
      add('Open With...', 'openWith');
      add(lastRevealOsTitle, 'revealInOs', 'Shift+Alt+R');
      add('Open in Integrated Terminal', 'openInTerminal');
      sep();
      add('Cursor Blame', 'cursorBlame');
      sep();
      add('Select for Compare', 'selectForCompare');
      sep();
      add('Add File to Cursor Chat', 'addToCursorChat');
      add('Add File to New Cursor Chat', 'addToNewCursorChat');
      sep();
      add('Find File References', 'findFileReferences');
      add('Open Timeline', 'openTimeline');
      sep();
      add('Cut', 'explorerCut', 'Ctrl+X');
      add('Copy', 'explorerCopy', 'Ctrl+C');
      sep();
      add('Copy Path', 'copyPath', 'Shift+Alt+C');
      add('Copy Relative Path', 'copyRelativePath', 'Ctrl+M Ctrl+Shift+C');
      sep();
      add('Run Tests', 'runTests');
      sep();
      add('Rename...', 'rename', 'F2');
      add('Delete', 'delete', 'Del');
    }

    document.body.appendChild(ul);
    ctxMenuEl = ul;
    ul.style.left = clientX + 'px';
    ul.style.top = clientY + 'px';
    requestAnimationFrame(() => {
      const r = ul.getBoundingClientRect();
      if (r.right > window.innerWidth - 4) ul.style.left = Math.max(4, window.innerWidth - r.width - 4) + 'px';
      if (r.bottom > window.innerHeight - 4) ul.style.top = Math.max(4, window.innerHeight - r.height - 4) + 'px';
    });
  }

  /** Close on press outside the menu (webview often skips bubbling click to body). */
  function onPointerDownOutsideMenus(e) {
    const t = e.target;
    if (ctxMenuEl && (!t || !ctxMenuEl.contains(t))) {
      hideCtxMenu();
    }
    if (viewsMenuEl && viewsMenuBtn && t && !viewsMenuEl.contains(t) && !viewsMenuBtn.contains(t)) {
      hideViewsMenu();
    }
    if (settingsMenuEl && settingsMenuBtn && t && !settingsMenuEl.contains(t) && !settingsMenuBtn.contains(t)) {
      hideSettingsMenu();
    }
  }

  function onKeydownEscape(e) {
    if (e.key === 'Escape') {
      hideTopbarDropdowns();
      hideCtxMenu();
    }
  }

  /** @param {{ vscode: object; applyColWidths: () => void }} opts */
  function init(opts) {
    vscodeApi = opts.vscode;
    applyColWidthsFn = opts.applyColWidths;

    if (foldersToggleBtn) {
      foldersToggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        hideTopbarDropdowns();
        vscodeApi.postMessage({
          type: 'setShowFoldersInList',
          value: foldersToggleBtn.getAttribute('aria-pressed') !== 'true',
        });
      });
    }

    if (viewsMenuBtn) {
      viewsMenuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleViewsMenu();
      });
    }

    if (settingsMenuBtn) {
      settingsMenuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleSettingsMenu();
      });
    }

    if (viewsMenuEl) {
      viewsMenuEl.addEventListener('click', (e) => {
        const li = e.target && e.target.closest && e.target.closest('li[data-layout]');
        if (!li) return;
        const layout = li.getAttribute('data-layout');
        if (layout !== 'list' && layout !== 'detail' && layout !== 'icons') return;
        e.stopPropagation();
        hideViewsMenu();
        vscodeApi.postMessage({ type: 'setViewLayout', value: layout });
        document.body.classList.toggle('explorer-enhanced-layout-list', layout === 'list');
        document.body.classList.toggle('explorer-enhanced-layout-detail', layout === 'detail');
        document.body.classList.toggle('explorer-enhanced-layout-icons', layout === 'icons');
        syncViewMenuActive(layout);
        applyColWidthsFn();
        if (globalThis.FilePaneTable && typeof globalThis.FilePaneTable.applySortAndRender === 'function') {
          globalThis.FilePaneTable.applySortAndRender();
        }
      });
    }

    if (settingsMenuEl) {
      settingsMenuEl.addEventListener('click', (e) => {
        const li = e.target && e.target.closest && e.target.closest('li[data-settings-option]');
        if (!li) return;
        const opt = li.getAttribute('data-settings-option');
        if (
          opt !== 'git' &&
          opt !== 'problems' &&
          opt !== 'rowLines' &&
          opt !== 'columnLines' &&
          opt !== 'folderSize' &&
          opt !== 'selectActiveFile' &&
          opt !== 'highlightOpenFiles' &&
          opt !== 'showPath'
        ) {
          return;
        }
        e.stopPropagation();
        const wasOn = li.getAttribute('aria-checked') === 'true';
        hideSettingsMenu();
        if (opt === 'git') {
          vscodeApi.postMessage({ type: 'setShowGitStatus', value: !wasOn });
        } else if (opt === 'problems') {
          vscodeApi.postMessage({ type: 'setShowProblemsInFiles', value: !wasOn });
        } else if (opt === 'folderSize') {
          vscodeApi.postMessage({ type: 'setShowFolderSize', value: !wasOn });
        } else if (opt === 'selectActiveFile') {
          vscodeApi.postMessage({ type: 'setSelectActiveFile', value: !wasOn });
        } else if (opt === 'highlightOpenFiles') {
          vscodeApi.postMessage({ type: 'setHighlightOpenFiles', value: !wasOn });
        } else if (opt === 'showPath') {
          vscodeApi.postMessage({ type: 'setShowPath', value: !wasOn });
        } else if (opt === 'columnLines') {
          const next = !wasOn;
          vscodeApi.postMessage({ type: 'setShowFilesColumnLines', value: next });
          document.body.classList.toggle('explorer-enhanced-show-column-lines', next);
          syncSettingsColumnLinesToggle(next);
        } else {
          const next = !wasOn;
          vscodeApi.postMessage({ type: 'setShowFilesRowLines', value: next });
          document.body.classList.toggle('explorer-enhanced-show-row-lines', next);
          syncSettingsRowLinesToggle(next);
        }
      });
    }

    document.addEventListener('mousedown', onPointerDownOutsideMenus, true);
    document.addEventListener('touchstart', onPointerDownOutsideMenus, true);
    document.addEventListener('keydown', onKeydownEscape, true);

    document.body.addEventListener('click', (e) => {
      if (ctxMenuEl && e.target && !ctxMenuEl.contains(e.target)) hideCtxMenu();
      if (viewsMenuEl && viewsMenuBtn && e.target && !viewsMenuEl.contains(e.target) && !viewsMenuBtn.contains(e.target)) {
        hideViewsMenu();
      }
      if (settingsMenuEl && settingsMenuBtn && e.target && !settingsMenuEl.contains(e.target) && !settingsMenuBtn.contains(e.target)) {
        hideSettingsMenu();
      }
    });
  }

  function setRevealOsTitle(title) {
    if (typeof title === 'string' && title.length > 0) {
      lastRevealOsTitle = title;
    }
  }

  globalThis.FilePaneMenus = {
    init,
    syncFoldersToggleUi,
    syncViewMenuActive,
    syncSettingsGitToggle,
    syncSettingsProblemsToggle,
    syncSettingsRowLinesToggle,
    syncSettingsColumnLinesToggle,
    syncSettingsFolderSizeToggle,
    syncSettingsSelectActiveFileToggle,
    syncSettingsHighlightOpenFilesToggle,
    syncSettingsShowPathToggle,
    showFileCtxMenu,
    hideCtxMenu,
    hideViewsMenu,
    hideSettingsMenu,
    setRevealOsTitle,
  };
})();
