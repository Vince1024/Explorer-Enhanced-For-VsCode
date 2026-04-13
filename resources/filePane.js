'use strict';
const vscode = acquireVsCodeApi();
const boot = window.__FILE_PANE_BOOT__;
if (!boot || typeof boot !== 'object') {
  throw new Error('explorer-enhanced: missing __FILE_PANE_BOOT__');
}
const Icons = globalThis.FilePaneIcons;
if (!Icons || typeof Icons.svgIcon !== 'function' || typeof Icons.iconForEntry !== 'function') {
  throw new Error('explorer-enhanced: FilePaneIcons missing (load filePane.icons.js before filePane.js)');
}
const Cols = globalThis.FilePaneColumns;
const Menus = globalThis.FilePaneMenus;
const Table = globalThis.FilePaneTable;
if (
  !Cols ||
  typeof Cols.init !== 'function' ||
  typeof Cols.applyColWidths !== 'function' ||
  typeof Cols.syncDetailColWidthsFromHost !== 'function'
) {
  throw new Error('explorer-enhanced: FilePaneColumns missing (load filePane.columns.js before filePane.js)');
}
if (
  !Menus ||
  typeof Menus.init !== 'function' ||
  typeof Menus.showFileCtxMenu !== 'function' ||
  typeof Menus.syncFilesContentSearchToggle !== 'function'
) {
  throw new Error('explorer-enhanced: FilePaneMenus missing (load filePane.menus.js after columns, before table/filePane.js)');
}
const Format = globalThis.FilePaneFormat;
if (!Format || typeof Format.fmtSizeBytes !== 'function') {
  throw new Error('explorer-enhanced: FilePaneFormat missing (load filePane.format.js before filePane.filterHighlight.js)');
}
const FilterHighlight = globalThis.FilePaneFilterHighlight;
if (!FilterHighlight || typeof FilterHighlight.appendNameWithFilterHighlights !== 'function') {
  throw new Error(
    'explorer-enhanced: FilePaneFilterHighlight missing (load filePane.filterHighlight.js after format, before gitBadges/table)'
  );
}
if (!Table || typeof Table.init !== 'function' || typeof Table.applySortAndRender !== 'function') {
  throw new Error('explorer-enhanced: FilePaneTable missing (load filePane.table.js after menus, before filePane.js)');
}
/** Breadcrumb segment separator from host (`boot.fsPathSep`); fallback `/`. */
const CRUMB_PATH_SEP =
  typeof boot.fsPathSep === 'string' && boot.fsPathSep.length > 0 ? boot.fsPathSep : '/';
const IconGrid = globalThis.FilePaneIconGrid;
if (!IconGrid || typeof IconGrid.init !== 'function' || typeof IconGrid.render !== 'function') {
  throw new Error('explorer-enhanced: FilePaneIconGrid missing (load filePane.iconGrid.js after table, before filePane.js)');
}

const folderEl = document.getElementById('folder');
const filesNavBackBtn = document.getElementById('filesNavBackBtn');
const filesNavForwardBtn = document.getElementById('filesNavForwardBtn');
const bodyEl = document.getElementById('body');
const gridEl = document.getElementById('grid');
const gridHeadEl = document.getElementById('grid-head');
if (!gridHeadEl) {
  throw new Error('explorer-enhanced: missing #grid-head');
}

const iconsPaneEl = document.getElementById('iconsPane');

/** List row folder selected on single click: highlight + breadcrumb, without changing the listing. */
let selectedListFolderPath = '';
/** @type {Array<{ label: string; path: string }>} */
let selectedListFolderCrumbs = [];

/** Last list/grid entry clicked (F2 / Delete if editor sync is slow). */
let lastCtxKeyboardPath = '';
/** @type {'file' | 'folder'} */
let lastCtxKeyboardKind = 'file';

const scrollMainEl = document.querySelector('.files-scroll-main');
/** Align #grid-head with #grid: the scrollable area reduces usable width when the scrollbar is present. */
function syncScrollportScrollbarWidth() {
  if (!scrollMainEl) return;
  const sb = Math.max(0, scrollMainEl.offsetWidth - scrollMainEl.clientWidth);
  document.documentElement.style.setProperty('--explorer-enhanced-files-scrollbar-w', `${sb}px`);
}
syncScrollportScrollbarWidth();
window.addEventListener('resize', () => {
  requestAnimationFrame(syncScrollportScrollbarWidth);
});
if (scrollMainEl && typeof ResizeObserver !== 'undefined') {
  const roScroll = new ResizeObserver(() => syncScrollportScrollbarWidth());
  roScroll.observe(scrollMainEl);
}

function applyFolderRowSelectionClasses() {
  const sel = selectedListFolderPath;
  for (const row of bodyEl.querySelectorAll('tr[data-path].files-folder-row-selected')) {
    row.classList.remove('files-folder-row-selected');
    row.removeAttribute('aria-selected');
  }
  for (const row of bodyEl.querySelectorAll('tr[data-path]')) {
    if (row.dataset.kind !== 'folder') continue;
    if (sel && row.dataset.path === sel) {
      row.classList.add('files-folder-row-selected');
      row.setAttribute('aria-selected', 'true');
    }
  }
  const iconsPane = document.getElementById('iconsPane');
  if (iconsPane) {
    for (const tile of iconsPane.querySelectorAll('.files-icon-tile.files-folder-row-selected')) {
      tile.classList.remove('files-folder-row-selected');
      tile.removeAttribute('aria-selected');
    }
    for (const tile of iconsPane.querySelectorAll('.files-icon-tile[data-path]')) {
      if (tile.dataset.kind !== 'folder') continue;
      if (sel && tile.dataset.path === sel) {
        tile.classList.add('files-folder-row-selected');
        tile.setAttribute('aria-selected', 'true');
      }
    }
  }
}

/** Resets "folder selected on click" state and the DOM; does not refresh the breadcrumb. */
function clearFolderRowListSelectionDomOnly() {
  selectedListFolderPath = '';
  selectedListFolderCrumbs = [];
  applyFolderRowSelectionClasses();
}

function clearSelectedListFolderRow() {
  if (!selectedListFolderPath && selectedListFolderCrumbs.length === 0) return;
  clearFolderRowListSelectionDomOnly();
  renderPathHint();
}

/** Host response: highlight + breadcrumb for the clicked folder (listing unchanged). */
function applyFolderRowSelectFromHost(msg) {
  selectedListFolderPath = typeof msg.path === 'string' ? msg.path : '';
  selectedListFolderCrumbs = Array.isArray(msg.folderBreadcrumb) ? msg.folderBreadcrumb : [];
  applyFolderRowSelectionClasses();
  renderPathHint();
}

/** Folder single click: requests breadcrumb from host (listing unchanged). */
function postSelectFolderRow(fsPath) {
  if (typeof fsPath !== 'string' || fsPath.length === 0) return;
  vscode.postMessage({ type: 'selectFolderRow', path: fsPath });
}

let showGitStatus = boot.showGitStatus !== false;
let showProblemsInFiles = boot.showProblemsInFiles !== false;
let showFilesRowLines = boot.showFilesRowLines === true;
let showFilesColumnLines = boot.showFilesColumnLines !== false;
let showFolderSize = boot.showFolderSize === true;
let selectActiveFile = boot.selectActiveFile !== false;
let highlightOpenFiles = boot.highlightOpenFiles === true;
let showPath = boot.showPath !== false;
/** "Search in file contents" mode (toolbar toggle). */
let fileContentSearchEnabled = boot.fileContentSearch === true;
/** @type {ReturnType<typeof setTimeout> | null} */
let contentSearchDebounceTimer = null;
const CONTENT_SEARCH_DEBOUNCE_MS = 450;
/** @type {Set<string>} */
let openEditorPathsSet = new Set(Array.isArray(boot.openEditorPaths) ? boot.openEditorPaths : []);
document.body.classList.toggle('explorer-enhanced-show-git', showGitStatus);
document.body.classList.toggle('explorer-enhanced-show-problems', showProblemsInFiles);
document.body.classList.toggle('explorer-enhanced-show-row-lines', showFilesRowLines);
document.body.classList.toggle('explorer-enhanced-show-column-lines', showFilesColumnLines);

function updateStatusHeaderLabel() {
  const labelEl = document.getElementById('filesPaneStatusHeaderLabel');
  const thEl = document.getElementById('filesPaneStatusHeader');
  if (!labelEl || !thEl) return;
  let t = '';
  if (showProblemsInFiles && showGitStatus) {
    t = 'pb, git';
  } else if (showGitStatus) {
    t = 'git';
  } else if (showProblemsInFiles) {
    t = 'pb';
  }
  labelEl.textContent = t;
  thEl.title = t;
  thEl.setAttribute('aria-label', t ? 'Status (' + t + ')' : 'Status');
}

function rebuildOpenEditorPathsSet(paths) {
  openEditorPathsSet = new Set(Array.isArray(paths) ? paths : []);
}

function syncOpenEditorHighlightToDom() {
  if (Table && typeof Table.applyOpenEditorHighlights === 'function') {
    Table.applyOpenEditorHighlights(highlightOpenFiles, openEditorPathsSet);
  }
  if (IconGrid && typeof IconGrid.applyOpenEditorHighlights === 'function') {
    IconGrid.applyOpenEditorHighlights(highlightOpenFiles, openEditorPathsSet);
  }
}

Cols.init({
  vscode,
  gridEl,
  gridHeadEl,
  getShowGitStatus: () => showGitStatus,
  getShowProblemsInFiles: () => showProblemsInFiles,
  persistedDetailColWidthsPx: boot.persistedDetailColWidthsPx,
  defaultDetailColWidthsPx: boot.defaultDetailColWidthsPx,
  detailColMinPx: boot.detailColMinPx,
  detailColMaxPx: boot.detailColMaxPx,
});

Menus.init({
  vscode,
  applyColWidths: () => Cols.applyColWidths(),
});
Menus.syncSettingsGitToggle(showGitStatus);
Menus.syncSettingsProblemsToggle(showProblemsInFiles);
Menus.syncSettingsRowLinesToggle(showFilesRowLines);
Menus.syncSettingsColumnLinesToggle(showFilesColumnLines);
Menus.syncSettingsFolderSizeToggle(showFolderSize);
Menus.syncSettingsSelectActiveFileToggle(selectActiveFile);
Menus.syncSettingsShowPathToggle(showPath);
Menus.syncFilesContentSearchToggle(fileContentSearchEnabled);

function isFilesPaneTopbarMenuOpen() {
  const v = document.getElementById('viewsMenu');
  const s = document.getElementById('settingsMenu');
  return (
    !!(v && v.classList.contains('views-menu--open')) || !!(s && s.classList.contains('views-menu--open'))
  );
}

function isKeydownTargetEditable(target) {
  if (!target || typeof target !== 'object') return false;
  const el = target.nodeType === 1 ? target : target.parentElement;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (el.isContentEditable) return true;
  return !!(el.closest && el.closest('[contenteditable="true"]'));
}

function recordCtxKeyboardPathFromListClick(fsPath, kind) {
  if (typeof fsPath !== 'string' || fsPath.length === 0) return;
  lastCtxKeyboardPath = fsPath;
  lastCtxKeyboardKind = kind === 'folder' ? 'folder' : 'file';
}

function escapeAttrSelectorValue(s) {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(s);
  }
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function getCtxKeyboardTarget() {
  const icons = document.body.classList.contains('explorer-enhanced-layout-icons');

  if (selectedListFolderPath) {
    return { path: selectedListFolderPath, kind: 'folder' };
  }

  if (icons && iconsPaneEl) {
    const t = iconsPaneEl.querySelector('.files-icon-tile[data-path].editor-active');
    if (t && t.dataset.path) {
      return { path: t.dataset.path, kind: t.dataset.kind === 'folder' ? 'folder' : 'file' };
    }
  } else if (bodyEl) {
    const tr = bodyEl.querySelector('tr[data-path].editor-active');
    if (tr && tr.dataset.path) {
      return { path: tr.dataset.path, kind: tr.dataset.kind === 'folder' ? 'folder' : 'file' };
    }
  }

  if (lastCtxKeyboardPath) {
    const esc = escapeAttrSelectorValue(lastCtxKeyboardPath);
    const still =
      icons && iconsPaneEl
        ? iconsPaneEl.querySelector('.files-icon-tile[data-path="' + esc + '"]')
        : bodyEl
          ? bodyEl.querySelector('tr[data-path="' + esc + '"]')
          : null;
    if (still) {
      return { path: lastCtxKeyboardPath, kind: lastCtxKeyboardKind };
    }
  }

  return null;
}

function postCtxActionFromKeyboard(action) {
  const t = getCtxKeyboardTarget();
  if (!t || !t.path) return false;
  vscode.postMessage({ type: 'ctx', action, path: t.path });
  return true;
}

function onFilesPaneKeydownCapture(e) {
  if (!e || e.defaultPrevented) return;
  if (typeof Menus.isCtxMenuOpen === 'function' && Menus.isCtxMenuOpen()) return;
  if (isFilesPaneTopbarMenuOpen()) return;
  if (isKeydownTargetEditable(e.target)) return;

  if (e.key === 'F2') {
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    if (postCtxActionFromKeyboard('rename')) {
      e.preventDefault();
      e.stopPropagation();
    }
    return;
  }
  if (e.key === 'Delete' || e.code === 'Delete') {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (postCtxActionFromKeyboard('delete')) {
      e.preventDefault();
      e.stopPropagation();
    }
  }
}

if (bodyEl) {
  bodyEl.addEventListener(
    'click',
    (e) => {
      const tr = e.target && e.target.closest && e.target.closest('tr[data-path]');
      if (!tr || !bodyEl.contains(tr)) return;
      const p = tr.dataset.path;
      if (!p) return;
      recordCtxKeyboardPathFromListClick(p, tr.dataset.kind === 'folder' ? 'folder' : 'file');
    },
    true
  );
}
if (iconsPaneEl) {
  iconsPaneEl.addEventListener(
    'click',
    (e) => {
      const tile = e.target && e.target.closest && e.target.closest('.files-icon-tile[data-path]');
      if (!tile || !iconsPaneEl.contains(tile)) return;
      const p = tile.dataset.path;
      if (!p) return;
      recordCtxKeyboardPathFromListClick(p, tile.dataset.kind === 'folder' ? 'folder' : 'file');
    },
    true
  );
}

document.addEventListener('keydown', onFilesPaneKeydownCapture, true);

Table.init({
  vscode,
  bodyEl,
  gridHeadEl,
  getShowGitStatus: () => showGitStatus,
  getShowProblemsInFiles: () => showProblemsInFiles,
  getShowFolderSize: () => showFolderSize,
  dateTimeCustomPatternBoot: boot.dateTimeCustomPattern,
  onFolderRowSingleClick: postSelectFolderRow,
  onClearFolderListSelection: clearSelectedListFolderRow,
});

const filesFilterInput = document.getElementById('filesFilterInput');
const filesFilterClearBtn = document.getElementById('filesFilterClearBtn');
const filesFilterInputWrap = document.getElementById('filesFilterInputWrap');
const filesContentSearchOverlayEl = document.getElementById('filesContentSearchOverlay');

function applyFilterFieldPlaceholder() {
  if (!filesFilterInput) return;
  if (fileContentSearchEnabled) {
    filesFilterInput.placeholder = 'Search in file contents…';
    filesFilterInput.title =
      'Recursive text search under the selected folder (UTF-8, size limits apply). Progress is shown in the window and here.';
    filesFilterInput.setAttribute('aria-label', 'Search text inside files under the selected folder');
  } else {
    filesFilterInput.placeholder = 'Filter by name…';
    filesFilterInput.title =
      'Instant filter on the Name column (case-insensitive). Cleared when you change folder. Esc clears.';
    filesFilterInput.setAttribute('aria-label', 'Filter files and folders by name');
  }
}

function postContentSearchQueryDebounced(raw) {
  if (contentSearchDebounceTimer) {
    clearTimeout(contentSearchDebounceTimer);
  }
  contentSearchDebounceTimer = setTimeout(() => {
    contentSearchDebounceTimer = null;
    vscode.postMessage({ type: 'contentSearchQuery', value: typeof raw === 'string' ? raw : '' });
  }, CONTENT_SEARCH_DEBOUNCE_MS);
}

function postContentSearchQueryImmediate(raw) {
  if (contentSearchDebounceTimer) {
    clearTimeout(contentSearchDebounceTimer);
    contentSearchDebounceTimer = null;
  }
  vscode.postMessage({ type: 'contentSearchQuery', value: typeof raw === 'string' ? raw : '' });
}

function syncFilesFilterClearUi() {
  const has = !!(filesFilterInput && filesFilterInput.value.length > 0);
  if (filesFilterClearBtn) {
    filesFilterClearBtn.hidden = !has;
  }
  if (filesFilterInputWrap) {
    filesFilterInputWrap.classList.toggle('files-filter-input-wrap--has-value', has);
  }
}

if (filesFilterInput) {
  applyFilterFieldPlaceholder();
  filesFilterInput.addEventListener('input', () => {
    if (fileContentSearchEnabled) {
      Table.setNameFilter('', { skipRender: true });
      Table.applySortAndRender();
      postContentSearchQueryDebounced(filesFilterInput.value);
    } else {
      Table.setNameFilter(filesFilterInput.value);
    }
    syncFilesFilterClearUi();
    requestAnimationFrame(syncScrollportScrollbarWidth);
  });
  filesFilterInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      filesFilterInput.value = '';
      if (fileContentSearchEnabled) {
        postContentSearchQueryImmediate('');
      }
      Table.setNameFilter('');
      syncFilesFilterClearUi();
      e.preventDefault();
    }
  });
  syncFilesFilterClearUi();
  if (fileContentSearchEnabled && filesFilterInput.value.length > 0) {
    postContentSearchQueryImmediate(filesFilterInput.value);
  }
}
if (filesFilterClearBtn && filesFilterInput) {
  filesFilterClearBtn.addEventListener('click', () => {
    filesFilterInput.value = '';
    if (fileContentSearchEnabled) {
      postContentSearchQueryImmediate('');
    }
    Table.setNameFilter('');
    syncFilesFilterClearUi();
    filesFilterInput.focus();
    requestAnimationFrame(syncScrollportScrollbarWidth);
  });
}

IconGrid.init({
  vscode,
  paneEl: iconsPaneEl,
  getShowGitStatus: () => showGitStatus,
  getShowProblemsInFiles: () => showProblemsInFiles,
  getShowFolderSize: () => showFolderSize,
  onFolderRowSingleClick: postSelectFolderRow,
  onClearFolderListSelection: clearSelectedListFolderRow,
});

Table.setAfterSortRender((sorted) => {
  if (document.body.classList.contains('explorer-enhanced-layout-icons')) {
    IconGrid.render(sorted);
  } else {
    IconGrid.clear();
  }
  applyEditorSelection(currentEditorFilePath);
  applyFolderRowSelectionClasses();
  syncOpenEditorHighlightToDom();
  requestAnimationFrame(syncScrollportScrollbarWidth);
});

updateStatusHeaderLabel();

const bootLayout = boot.viewLayout;
if (typeof bootLayout === 'string' && (bootLayout === 'list' || bootLayout === 'detail' || bootLayout === 'icons')) {
  document.body.classList.toggle('explorer-enhanced-layout-list', bootLayout === 'list');
  document.body.classList.toggle('explorer-enhanced-layout-detail', bootLayout === 'detail');
  document.body.classList.toggle('explorer-enhanced-layout-icons', bootLayout === 'icons');
  Menus.syncViewMenuActive(bootLayout);
}

let currentFolderPath = '';
let currentEditorFilePath = '';
let folderNavCanGoBack = false;
let folderNavCanGoForward = false;
/** @type {Array<{ label: string; path: string }>} */
let folderBreadcrumbFromState = [];

function syncFolderNavButtons() {
  if (!filesNavBackBtn || !filesNavForwardBtn) return;
  const hasFolder = currentFolderPath.length > 0;
  filesNavBackBtn.disabled = !hasFolder || !folderNavCanGoBack;
  filesNavForwardBtn.disabled = !hasFolder || !folderNavCanGoForward;
}

function fsPathNormForCompare(p) {
  if (!p || typeof p !== 'string') return '';
  return p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

function fsParentDir(fsPath) {
  if (!fsPath) return '';
  const i = Math.max(fsPath.lastIndexOf('/'), fsPath.lastIndexOf('\\'));
  return i >= 0 ? fsPath.slice(0, i) : '';
}

function fileIsUnderCurrentFolder(filePath, folderPath) {
  return fsPathNormForCompare(fsParentDir(filePath)) === fsPathNormForCompare(folderPath);
}

/** Capitalize drive letter (c:\ → C:\) for display. */
function capitalizeDriveLetter(p) {
  if (!p || typeof p !== 'string') return p || '';
  return /^[a-z]:/.test(p) ? p[0].toUpperCase() + p.slice(1) : p;
}

/** Native path for clipboard (e.g. backslashes on Windows). */
function normalizePathForClipboard(fsPath) {
  if (!fsPath || typeof fsPath !== 'string') return '';
  let p = fsPath;
  if (CRUMB_PATH_SEP === '\\') {
    p = p.replace(/\//g, '\\');
  } else {
    p = p.replace(/\\/g, '/');
  }
  return capitalizeDriveLetter(p);
}

function getBreadcrumbClipboardPath() {
  if (!showPath) return '';
  if (selectedListFolderPath) {
    return normalizePathForClipboard(selectedListFolderPath);
  }
  if (!currentFolderPath) return '';
  const useFile =
    currentEditorFilePath && fileIsUnderCurrentFolder(currentEditorFilePath, currentFolderPath);
  const raw = useFile ? currentEditorFilePath : currentFolderPath;
  return normalizePathForClipboard(raw);
}

function onFolderElCopy(e) {
  if (!folderEl) return;
  const sel = document.getSelection();
  if (sel && !sel.isCollapsed && folderEl.contains(sel.anchorNode)) {
    const selectedText = sel.toString();
    if (selectedText) {
      e.preventDefault();
      e.clipboardData.setData('text/plain', selectedText);
      return;
    }
  }
  const clip = getBreadcrumbClipboardPath();
  if (!clip) return;
  e.preventDefault();
  e.clipboardData.setData('text/plain', clip);
}

function appendCrumbSeparator(parentEl) {
  const sep = document.createElement('span');
  sep.className = 'files-path-crumb-sep';
  sep.textContent = CRUMB_PATH_SEP;
  sep.setAttribute('aria-hidden', 'true');
  parentEl.appendChild(sep);
}

/**
 * @param {HTMLElement} parentEl
 * @param {Array<{ label: string; path: string }>} crumbs
 * @param {boolean} everyCrumbIsButton When true, last segment is still a folder button (active file shown after crumbs).
 */
function appendFolderBreadcrumbSegments(parentEl, crumbs, everyCrumbIsButton) {
  for (let i = 0; i < crumbs.length; i++) {
    const seg = crumbs[i];
    if (i > 0) {
      appendCrumbSeparator(parentEl);
    }
    const displayLabel = i === 0 ? capitalizeDriveLetter(seg.label) : seg.label;
    const isLast = i === crumbs.length - 1;
    const asButton = !isLast || everyCrumbIsButton;
    if (asButton) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'files-path-crumb';
      btn.textContent = displayLabel;
      btn.title = seg.path;
      btn.setAttribute('aria-label', 'Open folder ' + seg.path);
      btn.addEventListener('click', () => {
        vscode.postMessage({ type: 'openFolder', path: seg.path });
      });
      parentEl.appendChild(btn);
    } else {
      const cur = document.createElement('span');
      cur.className = 'files-path-crumb-current';
      cur.textContent = displayLabel;
      cur.setAttribute('aria-current', 'page');
      parentEl.appendChild(cur);
    }
  }
}

function renderPathHint() {
  syncFolderNavButtons();
  if (!folderEl) return;
  folderEl.replaceChildren();

  if (!currentFolderPath) {
    folderEl.textContent = 'Select a folder in the Folders view above.';
    return;
  }
  if (!showPath) {
    return;
  }

  const crumbs =
    selectedListFolderPath && selectedListFolderCrumbs.length > 0
      ? selectedListFolderCrumbs
      : folderBreadcrumbFromState;
  const pathForActiveFileCheck = selectedListFolderPath || currentFolderPath;
  const activeFileInThisFolder =
    currentEditorFilePath && fileIsUnderCurrentFolder(currentEditorFilePath, pathForActiveFileCheck);

  if (activeFileInThisFolder && crumbs.length > 0) {
    appendFolderBreadcrumbSegments(folderEl, crumbs, true);
    const fi = Math.max(currentEditorFilePath.lastIndexOf('/'), currentEditorFilePath.lastIndexOf('\\'));
    const base = fi >= 0 ? currentEditorFilePath.slice(fi + 1) : currentEditorFilePath;
    appendCrumbSeparator(folderEl);
    const fileLeaf = document.createElement('span');
    fileLeaf.className = 'files-path-crumb-current';
    fileLeaf.textContent = base;
    fileLeaf.title = currentEditorFilePath;
    fileLeaf.setAttribute('aria-current', 'page');
    folderEl.appendChild(fileLeaf);
    return;
  }

  if (activeFileInThisFolder && crumbs.length === 0) {
    const span = document.createElement('span');
    span.className = 'files-path-file-hint';
    span.textContent = capitalizeDriveLetter(currentEditorFilePath);
    folderEl.appendChild(span);
    return;
  }

  if (crumbs.length === 0) {
    const span = document.createElement('span');
    span.className = 'files-path-file-hint';
    span.textContent = capitalizeDriveLetter(currentFolderPath);
    folderEl.appendChild(span);
    return;
  }
  appendFolderBreadcrumbSegments(folderEl, crumbs, false);
}

if (folderEl) {
  folderEl.addEventListener('copy', onFolderElCopy);
}

if (filesNavBackBtn) {
  filesNavBackBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'folderHistoryBack' });
  });
}
if (filesNavForwardBtn) {
  filesNavForwardBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'folderHistoryForward' });
  });
}

function applyEditorSelection(fsPath) {
  const target = fsPath || '';
  currentEditorFilePath = target;
  if (target) {
    lastCtxKeyboardPath = target;
    lastCtxKeyboardKind = 'file';
  }
  renderPathHint();
  for (const tr of bodyEl.querySelectorAll('tr[data-path].editor-active')) {
    tr.classList.remove('editor-active');
    tr.removeAttribute('aria-selected');
  }
  if (iconsPaneEl) {
    for (const tile of iconsPaneEl.querySelectorAll('.files-icon-tile[data-path].editor-active')) {
      tile.classList.remove('editor-active');
      tile.removeAttribute('aria-selected');
    }
  }
  if (!target) return;
  for (const tr of bodyEl.querySelectorAll('tr[data-path]')) {
    if (tr.dataset.path === target) {
      tr.classList.add('editor-active');
      tr.setAttribute('aria-selected', 'true');
      tr.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      return;
    }
  }
  if (iconsPaneEl) {
    for (const tile of iconsPaneEl.querySelectorAll('.files-icon-tile[data-path]')) {
      if (tile.dataset.path === target) {
        tile.classList.add('editor-active');
        tile.setAttribute('aria-selected', 'true');
        tile.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        return;
      }
    }
  }
}

window.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg) return;
  if (msg.type === 'folderRowSelect') {
    applyFolderRowSelectFromHost(msg);
    return;
  }
  if (msg.type === 'syncDetailColWidthsPx') {
    if (Array.isArray(msg.detailColWidthsPx) && msg.detailColWidthsPx.length === 3) {
      Cols.syncDetailColWidthsFromHost(msg.detailColWidthsPx);
      Cols.applyColWidths();
    }
    return;
  }
  if (msg.type === 'selectPath') {
    if (msg.path) {
      clearFolderRowListSelectionDomOnly();
    }
    applyEditorSelection(msg.path || '');
    syncOpenEditorHighlightToDom();
    return;
  }
  if (msg.type === 'openEditors') {
    highlightOpenFiles = msg.highlightOpenFiles === true;
    rebuildOpenEditorPathsSet(msg.paths);
    syncOpenEditorHighlightToDom();
    return;
  }
  if (msg.type === 'contentSearchProgress') {
    if (filesContentSearchOverlayEl) {
      const on = msg.running === true;
      filesContentSearchOverlayEl.hidden = !on;
      filesContentSearchOverlayEl.setAttribute('aria-hidden', on ? 'false' : 'true');
    }
    return;
  }
  if (msg.type !== 'state') return;
  const previousFolderPath = currentFolderPath;
  if (msg.revealOsTitle) Menus.setRevealOsTitle(msg.revealOsTitle);
  if (typeof msg.dateTimeFormat === 'string' && Table.DATE_FORMATS.has(msg.dateTimeFormat)) {
    Table.setDateTimeFormat(msg.dateTimeFormat);
  }
  if (typeof msg.dateTimeCustomPattern === 'string' && msg.dateTimeCustomPattern.length > 0) {
    Table.setDateTimeCustomPattern(msg.dateTimeCustomPattern);
  }
  currentFolderPath = typeof msg.folder === 'string' ? msg.folder : '';
  folderNavCanGoBack = msg.folderNavCanGoBack === true;
  folderNavCanGoForward = msg.folderNavCanGoForward === true;
  folderBreadcrumbFromState = Array.isArray(msg.folderBreadcrumb) ? msg.folderBreadcrumb : [];
  if (previousFolderPath !== currentFolderPath) {
    clearFolderRowListSelectionDomOnly();
    if (contentSearchDebounceTimer) {
      clearTimeout(contentSearchDebounceTimer);
      contentSearchDebounceTimer = null;
    }
    if (filesFilterInput) {
      filesFilterInput.value = '';
    }
    Table.setNameFilter('', { skipRender: true });
    syncFilesFilterClearUi();
  }
  if (typeof msg.fileContentSearch === 'boolean') {
    const was = fileContentSearchEnabled;
    fileContentSearchEnabled = msg.fileContentSearch;
    applyFilterFieldPlaceholder();
    Menus.syncFilesContentSearchToggle(msg.fileContentSearch);
    if (was && !msg.fileContentSearch && filesFilterInput) {
      Table.setNameFilter(filesFilterInput.value);
    }
    if (!was && msg.fileContentSearch && filesFilterInput) {
      Table.setNameFilter('', { skipRender: true });
      Table.applySortAndRender();
      postContentSearchQueryImmediate(filesFilterInput.value);
    }
  }
  /* Align with getShowGitStatus() / package default: show Git unless explicitly false. */
  showGitStatus = msg.showGitStatus !== false;
  document.body.classList.toggle('explorer-enhanced-show-git', showGitStatus);
  Menus.syncSettingsGitToggle(showGitStatus);
  showProblemsInFiles = msg.showProblemsInFiles !== false;
  document.body.classList.toggle('explorer-enhanced-show-problems', showProblemsInFiles);
  Menus.syncSettingsProblemsToggle(showProblemsInFiles);
  showFilesRowLines = msg.showFilesRowLines === true;
  document.body.classList.toggle('explorer-enhanced-show-row-lines', showFilesRowLines);
  Menus.syncSettingsRowLinesToggle(showFilesRowLines);
  showFilesColumnLines = msg.showFilesColumnLines !== false;
  document.body.classList.toggle('explorer-enhanced-show-column-lines', showFilesColumnLines);
  Menus.syncSettingsColumnLinesToggle(showFilesColumnLines);
  showFolderSize = msg.showFolderSize === true;
  Menus.syncSettingsFolderSizeToggle(showFolderSize);
  selectActiveFile = msg.selectActiveFile !== false;
  Menus.syncSettingsSelectActiveFileToggle(selectActiveFile);
  highlightOpenFiles = msg.highlightOpenFiles === true;
  rebuildOpenEditorPathsSet(msg.openEditorPaths);
  Menus.syncSettingsHighlightOpenFilesToggle(highlightOpenFiles);
  showPath = msg.showPath !== false;
  Menus.syncSettingsShowPathToggle(showPath);
  renderPathHint();
  updateStatusHeaderLabel();
  if (typeof msg.showFoldersInList === 'boolean') {
    Menus.syncFoldersToggleUi(msg.showFoldersInList);
  }
  if (
    typeof msg.viewLayout === 'string' &&
    (msg.viewLayout === 'list' || msg.viewLayout === 'detail' || msg.viewLayout === 'icons')
  ) {
    document.body.classList.toggle('explorer-enhanced-layout-list', msg.viewLayout === 'list');
    document.body.classList.toggle('explorer-enhanced-layout-detail', msg.viewLayout === 'detail');
    document.body.classList.toggle('explorer-enhanced-layout-icons', msg.viewLayout === 'icons');
    Menus.syncViewMenuActive(msg.viewLayout);
  }
  if (Array.isArray(msg.detailColWidthsPx) && msg.detailColWidthsPx.length === 3) {
    Cols.syncDetailColWidthsFromHost(msg.detailColWidthsPx);
  }
  Cols.applyColWidths();
  Table.replaceRows(msg.rows);
  Table.applySortAndRender();
  applyFolderRowSelectionClasses();
  requestAnimationFrame(syncScrollportScrollbarWidth);
});
