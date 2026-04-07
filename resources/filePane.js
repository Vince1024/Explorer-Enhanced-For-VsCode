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
if (!Menus || typeof Menus.init !== 'function' || typeof Menus.showFileCtxMenu !== 'function') {
  throw new Error('explorer-enhanced: FilePaneMenus missing (load filePane.menus.js after columns, before table/filePane.js)');
}
const Format = globalThis.FilePaneFormat;
if (!Format || typeof Format.fmtSizeBytes !== 'function') {
  throw new Error('explorer-enhanced: FilePaneFormat missing (load filePane.format.js before filePane.table.js)');
}
if (!Table || typeof Table.init !== 'function' || typeof Table.applySortAndRender !== 'function') {
  throw new Error('explorer-enhanced: FilePaneTable missing (load filePane.table.js after menus, before filePane.js)');
}
const IconGrid = globalThis.FilePaneIconGrid;
if (!IconGrid || typeof IconGrid.init !== 'function' || typeof IconGrid.render !== 'function') {
  throw new Error('explorer-enhanced: FilePaneIconGrid missing (load filePane.iconGrid.js after table, before filePane.js)');
}

const folderEl = document.getElementById('folder');
const bodyEl = document.getElementById('body');
const gridEl = document.getElementById('grid');
const gridHeadEl = document.getElementById('grid-head');
if (!gridHeadEl) {
  throw new Error('explorer-enhanced: missing #grid-head');
}

const scrollMainEl = document.querySelector('.files-scroll-main');
/** Aligne #grid-head avec #grid : la zone scrollable réduit la largeur utile quand la scrollbar est présente. */
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

let showGitStatus = boot.showGitStatus !== false;
let showProblemsInFiles = boot.showProblemsInFiles !== false;
let showFilesRowLines = boot.showFilesRowLines === true;
let showFilesColumnLines = boot.showFilesColumnLines !== false;
let showFolderSize = boot.showFolderSize === true;
let selectActiveFile = boot.selectActiveFile !== false;
let highlightOpenFiles = boot.highlightOpenFiles === true;
let showPath = boot.showPath !== false;
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

Table.init({
  vscode,
  bodyEl,
  gridEl,
  gridHeadEl,
  getShowGitStatus: () => showGitStatus,
  getShowProblemsInFiles: () => showProblemsInFiles,
  getShowFolderSize: () => showFolderSize,
  dateTimeCustomPatternBoot: boot.dateTimeCustomPattern,
});

const iconsPaneEl = document.getElementById('iconsPane');
IconGrid.init({
  vscode,
  paneEl: iconsPaneEl,
  getShowGitStatus: () => showGitStatus,
  getShowProblemsInFiles: () => showProblemsInFiles,
  getShowFolderSize: () => showFolderSize,
});

Table.setAfterSortRender((sorted) => {
  if (document.body.classList.contains('explorer-enhanced-layout-icons')) {
    IconGrid.render(sorted);
  } else {
    IconGrid.clear();
  }
  applyEditorSelection(currentEditorFilePath);
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

function renderPathHint() {
  if (!currentFolderPath) {
    folderEl.textContent = 'Select a folder in the Folders view above.';
    return;
  }
  if (!showPath) {
    folderEl.textContent = '';
    return;
  }
  if (currentEditorFilePath) {
    const i = Math.max(currentEditorFilePath.lastIndexOf('/'), currentEditorFilePath.lastIndexOf('\\'));
    const fileParent = i >= 0 ? currentEditorFilePath.slice(0, i) : '';
    if (fileParent === currentFolderPath) {
      folderEl.textContent = 'Files: ' + currentEditorFilePath;
      return;
    }
  }
  folderEl.textContent = 'Files: ' + currentFolderPath;
}

function applyEditorSelection(fsPath) {
  const target = fsPath || '';
  currentEditorFilePath = target;
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
  if (msg.type === 'syncDetailColWidthsPx') {
    if (Array.isArray(msg.detailColWidthsPx) && msg.detailColWidthsPx.length === 3) {
      Cols.syncDetailColWidthsFromHost(msg.detailColWidthsPx);
      Cols.applyColWidths();
    }
    return;
  }
  if (msg.type === 'selectPath') {
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
  if (msg.type !== 'state') return;
  if (msg.revealOsTitle) Menus.setRevealOsTitle(msg.revealOsTitle);
  if (typeof msg.dateTimeFormat === 'string' && Table.DATE_FORMATS.has(msg.dateTimeFormat)) {
    Table.setDateTimeFormat(msg.dateTimeFormat);
  }
  if (typeof msg.dateTimeCustomPattern === 'string' && msg.dateTimeCustomPattern.length > 0) {
    Table.setDateTimeCustomPattern(msg.dateTimeCustomPattern);
  }
  currentFolderPath = typeof msg.folder === 'string' ? msg.folder : '';
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
  requestAnimationFrame(syncScrollportScrollbarWidth);
});
