import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { collectOpenWorkspaceFilePaths, getActiveWorkspaceFileUri } from "./activeFileUri";
import * as actions from "./explorerContextActions";
import { mapPool } from "./asyncPool";
import { computeDirectorySizeBytes } from "./folderSizeUtils";
import { isFsDirectory, isFsFile } from "./fileTypeUtils";
import {
  DEFAULT_DATE_TIME_CUSTOM_PATTERN,
  FILES_PANE_VIEW_LAYOUT_STATE_KEY,
  getFilesSettingsSnapshot,
  getViewLayoutForFilesPane,
  resolveEnhanceExplorerSettingsConfigs,
  setShowFilesRowLines,
  setShowFilesColumnLines,
  setShowFolderSize,
  setShowFoldersInFilesList,
  setShowGitInFiles,
  setShowProblemsInFiles,
  getHighlightOpenFilesFromWorkspaceState,
  getShowGitInFilesFromWorkspaceState,
  getShowProblemsInFilesFromWorkspaceState,
  getSelectActiveFileFromWorkspaceState,
  setHighlightOpenFiles,
  setSelectActiveFile,
  setShowPath,
  setFileContentSearch,
  type FilesSettingsSnapshot,
  type DateTimeFormatSetting,
  type ViewLayoutSetting,
} from "./filePaneSettings";
import {
  buildProblemsCountForFilePaths,
  diagnosticsMayAffectFolder,
  normalizeProblemsPath,
  type FileProblemsCount,
} from "./filePaneDiagnostics";
import {
  collectUrisWithTextUnderFolder,
  displayNameRelativeToFolder,
} from "./filePaneContentSearch";
import { gitIncomingToRowPayload, type FileViewRowPayload, type GitFileStatusService } from "./gitFileStatusService";
import {
  buildFilePaneWebviewCsp,
  FILE_PANE_VIEW_TYPE,
  FILE_PANE_WEBVIEW_CSS_COMMON,
  FILE_PANE_WEBVIEW_CSS_LAYOUT_DETAIL,
  FILE_PANE_WEBVIEW_CSS_LAYOUT_ICONS,
  FILE_PANE_WEBVIEW_CSS_LAYOUT_LIST,
  FILE_PANE_WEBVIEW_DIR,
  FILE_PANE_WEBVIEW_JS,
  FILE_PANE_WEBVIEW_JS_COLUMNS,
  FILE_PANE_WEBVIEW_JS_FORMAT,
  FILE_PANE_WEBVIEW_JS_FILTER_HIGHLIGHT,
  FILE_PANE_WEBVIEW_JS_GIT_BADGES,
  FILE_PANE_WEBVIEW_JS_ICON_GRID,
  FILE_PANE_WEBVIEW_JS_ICONS,
  FILE_PANE_WEBVIEW_JS_MENUS,
  FILE_PANE_WEBVIEW_JS_TABLE,
  FILE_PANE_WEBVIEW_SHELL,
  buildFolderBreadcrumbSegments,
  isNormalizedFsPathDescendantOrSelf,
  filesListingCacheKey,
  FILES_NAME_COLLATOR,
  FILES_VIEW_BASE_TITLE,
  DEFAULT_DETAIL_COL_PX,
  MAX_DETAIL_COL_PX,
  MIN_DETAIL_COL_PX,
  normalizeDetailColWidthsPx,
  openFileInEditorFromWebview,
  resolvePersistedDetailColWidths,
  statePayloadSignature,
  svgExplorerViewDetail,
  svgExplorerViewIcons,
  svgExplorerViewList,
  WORKSPACE_DETAIL_COL_PX_KEY,
  type FilePaneWebviewInboundMessage,
  type FolderBreadcrumbSegment,
} from "./filePaneWebviewSupport";

/** Coalesce rapid re-list of the same folder (Git + FS watcher + workspace) to avoid webview tbody flicker. */
const SHOW_FOLDER_DEBOUNCE_MS = 200;
/** Cap concurrent `fs.stat` calls when listing rows in Files. */
const FILE_STAT_CONCURRENCY = 24;
/** Concurrency for folder size scans (heavy disk work). */
const FOLDER_SIZE_SCAN_CONCURRENCY = 3;
/** Coalesce rapid Problems/diagnostic updates (same idea as Git bump). */
const DIAGNOSTICS_DEBOUNCE_MS = 80;

/**
 * Webview listing files for the folder selected in Folders (table: Name, Modified, Size, optional combined Git/Problems column).
 * Icons are inline SVG; per-extension hex tints approximate Seti/Material-style hues.
 * Same-folder rescans are debounced; `readDirectory` is skipped when the folder and list options are unchanged.
 * Git-only updates can refresh SCM badges without `stat` or `readDirectory` when the listing + row cache is still valid.
 * Refreshes when the view becomes visible again and on disk/Git signals.
 */
export class FilePaneViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = FILE_PANE_VIEW_TYPE;

  private _view?: vscode.WebviewView;
  private _pendingFolder?: vscode.Uri;
  /** Last folder passed to showFolder; used to repopulate after the webview is shown again. */
  private _lastFolderUri: vscode.Uri | undefined;
  private _folderWatcher?: vscode.FileSystemWatcher;
  /** Normalized fsPath of the folder currently watched (avoid recreating the same watcher). */
  private _watchedFolderKey: string | undefined;
  private _showFolderDebounceTimer: ReturnType<typeof setTimeout> | undefined;
  private _showFolderFlushRunning = false;
  private _showFolderFlushPending = false;
  private _refreshDirtyWhenHidden = false;
  private _diagnosticsDebounceTimer: ReturnType<typeof setTimeout> | undefined;
  private _lastPostedSelectionPath = "";
  /** Last `state` postMessage signature; cleared when the webview is disposed. */
  private _lastPostedStateSignature: string | undefined;

  /**
   * `git`: last bump was Git-only — try badge refresh without `readDirectory` / `stat` if listing cache matches.
   * Reset to `full` after handling or when FS / listing cache is invalidated.
   */
  private _refreshMode: "full" | "git" = "full";
  /** Matches {@link filesListingCacheKey} after a successful full row build. */
  private _rowCacheListingKey: string | undefined;
  /** Last built rows (for Git-only decoration refresh). */
  private _rowCachePayloads: FileViewRowPayload[] | undefined;

  /** Avoids re-reading `filePane.shell.html` on every `resolveWebviewView` (F5 reload clears this cache). */
  private _cachedWebviewShellPath: string | undefined;
  private _cachedWebviewShellTemplate: string | undefined;

  /** Dernière requête « recherche dans les fichiers » (champ filtre, mode contenu). */
  private _contentSearchQuery = "";

  /** Historique de navigation dossier (chemins normalisés) pour Précédent / Suivant dans la webview. */
  private _folderHist: string[] = [];
  private _folderHistPos = -1;

  /** Cache key + sorted entries for the current folder; avoids `readDirectory` when Git or mtime/size refresh only. */
  private _filesListingCacheKey: string | undefined;
  private _filesListingCollected: Array<{ name: string; fileType: vscode.FileType }> | undefined;

  /** Total size per folder (normalized fsPath); invalidated on disk changes, not on Git-only bumps. */
  private _folderSizeCache = new Map<string, number>();
  /** Cancels stale size scans when disk content changes under a cached folder. */
  private _folderSizeJobId = 0;

  private _invalidateFilesListingCache(): void {
    this._filesListingCacheKey = undefined;
    this._filesListingCollected = undefined;
    this._rowCacheListingKey = undefined;
    this._rowCachePayloads = undefined;
    this._refreshMode = "full";
  }

  /**
   * Drops cached sizes for paths touched by FS changes (files or folders):
   * ancestors, keys themselves, and cached descendants.
   * Bumps the folder-size job id once if anything was removed.
   */
  private _invalidateFolderSizeCacheForFsPaths(changedFsPaths: readonly string[]): void {
    if (changedFsPaths.length === 0) {
      return;
    }
    const sep = path.sep;
    const toRemove = new Set<string>();
    for (const changedFsPath of changedFsPaths) {
      const norm = path.normalize(changedFsPath);
      for (const key of this._folderSizeCache.keys()) {
        if (norm === key || norm.startsWith(key + sep) || key.startsWith(norm + sep)) {
          toRemove.add(key);
        }
      }
      let cur = norm;
      for (;;) {
        if (this._folderSizeCache.has(cur)) {
          toRemove.add(cur);
        }
        const parent = path.dirname(cur);
        if (parent === cur) {
          break;
        }
        cur = parent;
      }
    }
    if (toRemove.size === 0) {
      return;
    }
    for (const k of toRemove) {
      this._folderSizeCache.delete(k);
    }
    this._folderSizeJobId++;
  }

  /** Normalized paths from FS events that fall under the current Files folder (tree), or `[]` if none. */
  private _pathsUnderDisplayedFolder(uris: readonly vscode.Uri[]): string[] {
    const folder = this._lastFolderUri;
    if (!folder) {
      return [];
    }
    const root = path.normalize(folder.fsPath);
    const sep = path.sep;
    const out: string[] = [];
    for (const u of uris) {
      const fp = path.normalize(u.fsPath);
      if (fp === root || fp.startsWith(root + sep)) {
        out.push(fp);
      }
    }
    return out;
  }

  /** When subfolders-in-Files toggles via memento (no `configuration` event). */
  invalidateFilesListingCache(): void {
    this._invalidateFilesListingCache();
  }

  /**
   * Native view header: title stays **Files**; counts go in {@link vscode.WebviewView.description}
   * as `(n)` (files only) or `(n/m)` (files / subfolder rows). Pass `null` when no folder is selected.
   */
  private _setFilesViewHeader(
    counts: null | { fileCount: number; folderCount: number; showFoldersInList: boolean }
  ): void {
    const wv = this._view;
    if (!wv) {
      return;
    }
    wv.title = FILES_VIEW_BASE_TITLE;
    if (counts === null) {
      wv.description = undefined;
      return;
    }
    wv.description = counts.showFoldersInList
      ? `(${counts.fileCount}/${counts.folderCount})`
      : `(${counts.fileCount})`;
  }

  constructor(
    private readonly _context: vscode.ExtensionContext,
    /** After rename/delete/new file from the Files webview, refresh Folders + file list. */
    private readonly _onFsChange: (scope?: "both" | "filesOnly") => void,
    private readonly _gitFileStatus: GitFileStatusService,
    /** Double-click folder row: sync Folders selection and show that folder in Files. */
    private readonly _onNavigateToFolder: (uri: vscode.Uri) => Promise<void>,
    /** After toggling “Select Active File”; extension re-runs Folders ↔ editor sync when applicable. */
    private readonly _onSelectActiveFilePolicyChanged?: () => void
  ) {
    const bump = (): void => {
      this._requestRefreshCurrentFolder();
    };
    this._context.subscriptions.push(
      vscode.workspace.onDidCreateFiles((e) => {
        const under = this._pathsUnderDisplayedFolder(e.files);
        if (under.length > 0) {
          this._invalidateFolderSizeCacheForFsPaths(under);
        }
        if (this._touchesDisplayedFolder(e.files)) {
          this._invalidateFilesListingCache();
          bump();
        } else if (under.length > 0) {
          bump();
        }
      }),
      vscode.workspace.onDidDeleteFiles((e) => {
        const under = this._pathsUnderDisplayedFolder(e.files);
        if (under.length > 0) {
          this._invalidateFolderSizeCacheForFsPaths(under);
        }
        if (this._touchesDisplayedFolder(e.files)) {
          this._invalidateFilesListingCache();
          bump();
        } else if (under.length > 0) {
          bump();
        }
      }),
      vscode.workspace.onDidRenameFiles((e) => {
        const folder = this._lastFolderUri;
        if (!folder) {
          return;
        }
        const underPaths: string[] = [];
        for (const x of e.files) {
          underPaths.push(...this._pathsUnderDisplayedFolder([x.oldUri, x.newUri]));
        }
        if (underPaths.length > 0) {
          this._invalidateFolderSizeCacheForFsPaths(underPaths);
        }
        for (const x of e.files) {
          if (this._isDirectFileChild(x.oldUri, folder) || this._isDirectFileChild(x.newUri, folder)) {
            this._invalidateFilesListingCache();
            bump();
            return;
          }
        }
        if (underPaths.length > 0) {
          bump();
        }
      }),
      vscode.window.onDidChangeActiveTextEditor(() => {
        this._postEditorSelectionToWebview();
      }),
      vscode.window.tabGroups.onDidChangeTabs(() => {
        this._postEditorSelectionToWebview();
        this._syncOpenEditorsHighlight();
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration("explorer-enhanced.files") ||
          e.affectsConfiguration("fileViews.files") ||
          e.affectsConfiguration("fileViews.folders")
        ) {
          this._requestRefreshCurrentFolder();
        }
      }),
      this._gitFileStatus.onDidChange(() => {
        if (!getShowGitInFilesFromWorkspaceState(this._context.workspaceState)) {
          return;
        }
        const folder = this._lastFolderUri;
        if (folder && !this._gitFileStatus.gitChangesMayAffectFolder(folder)) {
          return;
        }
        this._refreshMode = "git";
        this._requestRefreshCurrentFolder();
      }),
      vscode.languages.onDidChangeDiagnostics(() => {
        if (!getShowProblemsInFilesFromWorkspaceState(this._context.workspaceState)) {
          return;
        }
        if (this._diagnosticsDebounceTimer !== undefined) {
          clearTimeout(this._diagnosticsDebounceTimer);
        }
        this._diagnosticsDebounceTimer = setTimeout(() => {
          this._diagnosticsDebounceTimer = undefined;
          const folder = this._lastFolderUri;
          if (folder && !diagnosticsMayAffectFolder(folder.fsPath)) {
            return;
          }
          this._requestRefreshCurrentFolder();
        }, DIAGNOSTICS_DEBOUNCE_MS);
      })
    );
  }

  private _requestRefreshCurrentFolder(forceImmediate = false): void {
    const view = this._view;
    if (!view || !view.visible) {
      if (!this._refreshDirtyWhenHidden || forceImmediate) {
        this._refreshDirtyWhenHidden = true;
      }
      return;
    }
    void this.showFolder(this._lastFolderUri, forceImmediate);
  }

  private _postSelectionPathToWebview(pathValue: string): void {
    const wv = this._view?.webview;
    if (!wv) {
      return;
    }
    if (pathValue === this._lastPostedSelectionPath) {
      return;
    }
    this._lastPostedSelectionPath = pathValue;
    void wv.postMessage({ type: "selectPath", path: pathValue });
  }

  /** Highlight the row that matches the active editor file (if it is in the current folder list). */
  private _postEditorSelectionToWebview(): void {
    const view = this._view;
    const wv = view?.webview;
    if (!wv || !view.visible) {
      return;
    }
    if (!getSelectActiveFileFromWorkspaceState(this._context.workspaceState)) {
      this._postSelectionPathToWebview("");
      return;
    }
    const folder = this._lastFolderUri;
    const uri = getActiveWorkspaceFileUri();
    if (!folder || !uri) {
      this._postSelectionPathToWebview("");
      return;
    }
    if (this._isDirectFileChild(uri, folder)) {
      this._postSelectionPathToWebview(path.normalize(uri.fsPath));
    } else {
      this._postSelectionPathToWebview("");
    }
  }

  /** Bold rows for files that still have an open editor tab (optional setting). */
  private _syncOpenEditorsHighlight(): void {
    const view = this._view;
    const wv = view?.webview;
    if (!view?.visible || !wv) {
      return;
    }
    const on = getHighlightOpenFilesFromWorkspaceState(this._context.workspaceState);
    const paths = on ? collectOpenWorkspaceFilePaths() : [];
    void wv.postMessage({ type: "openEditors", highlightOpenFiles: on, paths });
  }

  /** Release the folder watcher; workspace listeners are tied to ExtensionContext. */
  dispose(): void {
    this._cancelShowFolderDebounce();
    if (this._diagnosticsDebounceTimer !== undefined) {
      clearTimeout(this._diagnosticsDebounceTimer);
      this._diagnosticsDebounceTimer = undefined;
    }
    this._disposeFolderWatcher();
  }

  private _normalizeFolderKey(u: vscode.Uri | undefined): string {
    return u ? path.normalize(u.fsPath) : "";
  }

  private _cancelShowFolderDebounce(): void {
    if (this._showFolderDebounceTimer !== undefined) {
      clearTimeout(this._showFolderDebounceTimer);
      this._showFolderDebounceTimer = undefined;
    }
  }

  /** Same-folder updates only; folder changes use {@link showFolder} immediate path. */
  private _scheduleShowFolderFlush(): void {
    this._cancelShowFolderDebounce();
    this._showFolderDebounceTimer = setTimeout(() => {
      this._showFolderDebounceTimer = undefined;
      void this._requestShowFolderFlush();
    }, SHOW_FOLDER_DEBOUNCE_MS);
  }

  private async _requestShowFolderFlush(): Promise<void> {
    const view = this._view;
    if (!view || !view.visible) {
      this._refreshDirtyWhenHidden = true;
      return;
    }
    if (this._showFolderFlushRunning) {
      this._showFolderFlushPending = true;
      return;
    }
    this._showFolderFlushRunning = true;
    try {
      do {
        this._showFolderFlushPending = false;
        await this._showFolderFlush();
      } while (this._showFolderFlushPending);
    } finally {
      this._showFolderFlushRunning = false;
    }
  }

  /**
   * Posts `state` only if the serialized payload differs from the last post (avoids redundant webview redraws).
   * @returns whether a message was posted.
   */
  private _postFilePaneStateIfChanged(
    view: vscode.WebviewView,
    payload: {
      folder: string;
      rows: FileViewRowPayload[];
      revealOsTitle: string;
      dateTimeFormat: DateTimeFormatSetting;
      dateTimeCustomPattern: string;
      showGitStatus: boolean;
      showProblemsInFiles: boolean;
      showFoldersInList: boolean;
      showFilesRowLines: boolean;
      showFilesColumnLines: boolean;
      showFolderSize: boolean;
      selectActiveFile: boolean;
      highlightOpenFiles: boolean;
      showPath: boolean;
      fileContentSearch: boolean;
      contentSearchActive: boolean;
      folderNavCanGoBack: boolean;
      folderNavCanGoForward: boolean;
      folderBreadcrumb: FolderBreadcrumbSegment[];
      openEditorPaths: string[];
      viewLayout: ViewLayoutSetting;
      detailColWidthsPx: readonly [number, number, number];
    },
    titleCounts: null | { fileCount: number; folderCount: number; showFoldersInList: boolean }
  ): boolean {
    const sig = statePayloadSignature(payload);
    if (sig === this._lastPostedStateSignature) {
      return false;
    }
    this._lastPostedStateSignature = sig;
    this._setFilesViewHeader(titleCounts);
    void view.webview.postMessage({ type: "state", ...payload });
    return true;
  }

  getLastFolderUri(): vscode.Uri | undefined {
    return this._lastFolderUri;
  }

  private _isDirectFileChild(file: vscode.Uri, folder: vscode.Uri): boolean {
    const dir = path.normalize(path.dirname(file.fsPath));
    const fold = path.normalize(folder.fsPath);
    return dir === fold;
  }

  private _touchesDisplayedFolder(uris: readonly vscode.Uri[]): boolean {
    const folder = this._lastFolderUri;
    if (!folder) {
      return false;
    }
    return uris.some((u) => this._isDirectFileChild(u, folder));
  }

  private _disposeFolderWatcher(): void {
    this._folderWatcher?.dispose();
    this._folderWatcher = undefined;
    this._watchedFolderKey = undefined;
  }

  /** Watch immediate file children of folderUri; no-op if the same folder is already watched. */
  private _syncFolderWatcher(folderUri: vscode.Uri | undefined): void {
    const key = folderUri ? path.normalize(folderUri.fsPath) : undefined;
    if (key === this._watchedFolderKey && this._folderWatcher) {
      return;
    }
    this._disposeFolderWatcher();
    this._watchedFolderKey = key;
    if (!folderUri) {
      return;
    }
    const pattern = new vscode.RelativePattern(folderUri, "*");
    const w = vscode.workspace.createFileSystemWatcher(pattern);
    const bump = (uri: vscode.Uri): void => {
      this._invalidateFolderSizeCacheForFsPaths([uri.fsPath]);
      this._invalidateFilesListingCache();
      this._requestRefreshCurrentFolder();
    };
    w.onDidCreate(bump);
    w.onDidDelete(bump);
    w.onDidChange(bump);
    this._folderWatcher = w;
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._context.extensionUri],
    };
    webviewView.webview.html = this._getHtml(webviewView.webview);

    this._context.subscriptions.push(
      webviewView.onDidChangeVisibility(() => {
        if (webviewView.visible) {
          this._cancelShowFolderDebounce();
          if (this._refreshDirtyWhenHidden) {
            this._refreshDirtyWhenHidden = false;
            void this.showFolder(this._lastFolderUri, true);
            return;
          }
          void this._requestShowFolderFlush();
          this._syncOpenEditorsHighlight();
        }
      }),
      webviewView.onDidDispose(() => {
        if (this._view === webviewView) {
          this._view = undefined;
          this._lastPostedStateSignature = undefined;
          this._lastPostedSelectionPath = "";
        }
      })
    );

    webviewView.webview.onDidReceiveMessage((msg: FilePaneWebviewInboundMessage) => {
      this._handleWebviewMessage(msg);
    });

    if (this._pendingFolder !== undefined) {
      const u = this._pendingFolder;
      this._pendingFolder = undefined;
      void this.showFolder(u, true);
    } else {
      void this.showFolder(this._lastFolderUri, true);
    }
  }

  private _buildGitCellPayload(
    entryUri: vscode.Uri,
    entryKind: "file" | "folder",
    showGitColumn: boolean
  ): FileViewRowPayload["git"] | undefined {
    if (!showGitColumn) {
      return undefined;
    }
    const inc = entryKind === "file" ? this._gitFileStatus.getUpstreamIncomingModel(entryUri) : undefined;
    const g = this._gitFileStatus.getModelForFile(entryUri, entryKind);
    if (!g && !inc) {
      return undefined;
    }
    const incomingPayload = inc ? gitIncomingToRowPayload(inc) : undefined;
    if (g && "primary" in g) {
      return {
        primary: { letter: g.primary.letter, kind: g.primary.kind },
        ...(g.secondary ? { secondary: { letter: g.secondary.letter, kind: g.secondary.kind } } : {}),
        ...(incomingPayload ? { incoming: incomingPayload } : {}),
      };
    }
    if (g) {
      return {
        primary: { letter: g.letter, kind: g.kind },
        ...(incomingPayload ? { incoming: incomingPayload } : {}),
      };
    }
    // Upstream incoming only (no local SCM row for this file).
    if (!incomingPayload) {
      return undefined;
    }
    return { primary: { letter: "", kind: "modified" }, incoming: incomingPayload };
  }

  private _entryRowPayload(
    name: string,
    entryUri: vscode.Uri,
    entryKind: "file" | "folder",
    mtime: number,
    size: number,
    showGitColumn: boolean,
    showProblemsColumn: boolean,
    problemsByPath: Map<string, FileProblemsCount> | undefined
  ): FileViewRowPayload {
    const base: FileViewRowPayload = {
      name,
      path: path.normalize(entryUri.fsPath),
      mtime,
      size,
      ...(entryKind === "folder" ? { kind: "folder" as const } : {}),
    };
    let row: FileViewRowPayload = base;
    const gitCell = this._buildGitCellPayload(entryUri, entryKind, showGitColumn);
    if (gitCell) {
      row = { ...row, git: gitCell };
    }
    if (showProblemsColumn && entryKind === "file" && problemsByPath) {
      const pc = problemsByPath.get(normalizeProblemsPath(entryUri.fsPath));
      if (pc && (pc.errors > 0 || pc.warnings > 0 || pc.infos > 0)) {
        row = { ...row, problems: { errors: pc.errors, warnings: pc.warnings, infos: pc.infos } };
      }
    }
    return row;
  }

  private async _buildContentSearchRows(
    folderUri: vscode.Uri,
    query: string,
    showGitStatus: boolean,
    showProblemsInFiles: boolean,
    token: vscode.CancellationToken
  ): Promise<FileViewRowPayload[]> {
    const uris = await collectUrisWithTextUnderFolder(folderUri, query, token);
    const problemsByPath =
      showProblemsInFiles && uris.length > 0
        ? buildProblemsCountForFilePaths(uris.map((u) => u.fsPath))
        : undefined;

    return mapPool(uris, FILE_STAT_CONCURRENCY, async (uri) => {
      try {
        const st = await vscode.workspace.fs.stat(uri);
        const displayName = displayNameRelativeToFolder(folderUri, uri);
        return this._entryRowPayload(
          displayName,
          uri,
          "file",
          st.mtime,
          st.size,
          showGitStatus,
          showProblemsInFiles,
          problemsByPath
        );
      } catch {
        return this._entryRowPayload(
          path.basename(uri.fsPath),
          uri,
          "file",
          0,
          0,
          showGitStatus,
          showProblemsInFiles,
          problemsByPath
        );
      }
    });
  }

  private async _runContentSearchWithUi(
    folderUri: vscode.Uri,
    query: string,
    showGitStatus: boolean,
    showProblemsInFiles: boolean
  ): Promise<FileViewRowPayload[]> {
    const view = this._view;
    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: "Explorer Enhanced",
        cancellable: true,
      },
      async (progress, token) => {
        if (view) {
          void view.webview.postMessage({ type: "contentSearchProgress", running: true });
        }
        try {
          progress.report({ message: "Recherche dans les fichiers…" });
          const rows = await this._buildContentSearchRows(
            folderUri,
            query,
            showGitStatus,
            showProblemsInFiles,
            token
          );
          progress.report({ message: `${rows.length} fichier(s)` });
          return rows;
        } finally {
          if (view) {
            void view.webview.postMessage({ type: "contentSearchProgress", running: false });
          }
        }
      }
    );
  }

  /** Refresh Git decorations from cached rows only (no `stat` / `readDirectory`). */
  private _rowWithFreshGit(row: FileViewRowPayload): FileViewRowPayload {
    const entryUri = vscode.Uri.file(row.path);
    const entryKind: "file" | "folder" = row.kind === "folder" ? "folder" : "file";
    const base: FileViewRowPayload = { ...row };
    delete base.git;
    const showGit = getShowGitInFilesFromWorkspaceState(this._context.workspaceState);
    const gitCell = this._buildGitCellPayload(entryUri, entryKind, showGit);
    if (!gitCell) {
      return base;
    }
    return { ...base, git: gitCell };
  }

  private _queueFolderSizeScan(
    folderUri: vscode.Uri,
    listingKey: string,
    rows: FileViewRowPayload[],
    showFolderSize: boolean
  ): void {
    if (!showFolderSize) {
      return;
    }
    const pendingUris = rows
      .filter((r) => r.kind === "folder" && r.folderSizePending === true)
      .map((r) => vscode.Uri.file(r.path));
    if (pendingUris.length === 0) {
      return;
    }
    this._folderSizeJobId++;
    const jobId = this._folderSizeJobId;
    void (async () => {
      await mapPool(pendingUris, FOLDER_SIZE_SCAN_CONCURRENCY, async (uri) => {
        if (this._folderSizeJobId !== jobId) {
          return;
        }
        const key = path.normalize(uri.fsPath);
        if (this._folderSizeCache.has(key)) {
          return;
        }
        try {
          const bytes = await computeDirectorySizeBytes(uri);
          this._folderSizeCache.set(key, bytes);
        } catch {
          this._folderSizeCache.set(key, 0);
        }
        if (this._folderSizeJobId !== jobId) {
          return;
        }
        if (this._filesListingCacheKey !== listingKey) {
          return;
        }
        const last = this._lastFolderUri;
        if (last && path.normalize(last.fsPath) === path.normalize(folderUri.fsPath)) {
          void this._requestShowFolderFlush();
        }
      });
    })();
  }

  private async _buildRowsForFolder(
    folderUri: vscode.Uri,
    showFoldersInList: boolean,
    showGitStatus: boolean,
    showProblemsInFiles: boolean,
    showFolderSize: boolean
  ): Promise<FileViewRowPayload[]> {
    type EntrySort = { name: string; fileType: vscode.FileType };
    const listingKey = filesListingCacheKey(folderUri, showFoldersInList);
    let collected: EntrySort[];
    if (this._filesListingCacheKey === listingKey && this._filesListingCollected) {
      collected = this._filesListingCollected;
    } else {
      const entries = await vscode.workspace.fs.readDirectory(folderUri);
      collected = [];
      for (const [name, type] of entries) {
        if (isFsFile(type)) {
          collected.push({ name, fileType: type });
        } else if (showFoldersInList && isFsDirectory(type)) {
          collected.push({ name, fileType: type });
        }
      }
      collected.sort((a, b) => {
        const aDir = isFsDirectory(a.fileType);
        const bDir = isFsDirectory(b.fileType);
        if (aDir !== bDir) {
          return aDir ? -1 : 1;
        }
        return FILES_NAME_COLLATOR.compare(a.name, b.name);
      });
      this._filesListingCacheKey = listingKey;
      this._filesListingCollected = collected;
    }
    let problemsByPath: Map<string, FileProblemsCount> | undefined;
    if (showProblemsInFiles) {
      const filePaths: string[] = [];
      for (const e of collected) {
        if (isFsFile(e.fileType)) {
          filePaths.push(vscode.Uri.joinPath(folderUri, e.name).fsPath);
        }
      }
      problemsByPath = buildProblemsCountForFilePaths(filePaths);
    }
    return mapPool(collected, FILE_STAT_CONCURRENCY, async (e): Promise<FileViewRowPayload> => {
      const childUri = vscode.Uri.joinPath(folderUri, e.name);
      if (isFsDirectory(e.fileType)) {
        let folderSizeBytes = 0;
        let folderPending = false;
        if (showFolderSize) {
          const ckey = path.normalize(childUri.fsPath);
          if (this._folderSizeCache.has(ckey)) {
            folderSizeBytes = this._folderSizeCache.get(ckey)!;
          } else {
            folderPending = true;
          }
        }
        try {
          const stat = await vscode.workspace.fs.stat(childUri);
          let row = this._entryRowPayload(
            e.name,
            childUri,
            "folder",
            stat.mtime,
            folderSizeBytes,
            showGitStatus,
            showProblemsInFiles,
            problemsByPath
          );
          if (folderPending) {
            row = { ...row, folderSizePending: true };
          }
          return row;
        } catch {
          let row = this._entryRowPayload(
            e.name,
            childUri,
            "folder",
            0,
            folderSizeBytes,
            showGitStatus,
            showProblemsInFiles,
            problemsByPath
          );
          if (folderPending) {
            row = { ...row, folderSizePending: true };
          }
          return row;
        }
      }
      try {
        const stat = await vscode.workspace.fs.stat(childUri);
        return this._entryRowPayload(
          e.name,
          childUri,
          "file",
          stat.mtime,
          stat.size,
          showGitStatus,
          showProblemsInFiles,
          problemsByPath
        );
      } catch {
        return this._entryRowPayload(
          e.name,
          childUri,
          "file",
          0,
          0,
          showGitStatus,
          showProblemsInFiles,
          problemsByPath
        );
      }
    });
  }

  private _getCodiconCssUri(webview: vscode.Webview): vscode.Uri {
    return webview.asWebviewUri(
      vscode.Uri.joinPath(this._context.extensionUri, "node_modules", "@vscode", "codicons", "dist", "codicon.css")
    );
  }

  private _buildStatePayload(
    folder: string,
    rows: FileViewRowPayload[],
    revealOsTitle: string,
    settings: FilesSettingsSnapshot,
    viewLayout: ViewLayoutSetting,
    /** One `collectOpenWorkspaceFilePaths` pass shared by both payloads in the same flush. */
    openEditorPathsResolved: string[],
    contentSearchActive: boolean,
    folderNav: {
      folderNavCanGoBack: boolean;
      folderNavCanGoForward: boolean;
      folderBreadcrumb: FolderBreadcrumbSegment[];
    }
  ): {
    folder: string;
    rows: FileViewRowPayload[];
    revealOsTitle: string;
    dateTimeFormat: DateTimeFormatSetting;
    dateTimeCustomPattern: string;
    showGitStatus: boolean;
    showProblemsInFiles: boolean;
    showFoldersInList: boolean;
    showFilesRowLines: boolean;
    showFilesColumnLines: boolean;
    showFolderSize: boolean;
    selectActiveFile: boolean;
    highlightOpenFiles: boolean;
    showPath: boolean;
    fileContentSearch: boolean;
    contentSearchActive: boolean;
    folderNavCanGoBack: boolean;
    folderNavCanGoForward: boolean;
    folderBreadcrumb: FolderBreadcrumbSegment[];
    openEditorPaths: string[];
    viewLayout: ViewLayoutSetting;
    detailColWidthsPx: readonly [number, number, number];
  } {
    const highlightOpenFiles = settings.highlightOpenFiles;
    return {
      folder,
      rows,
      revealOsTitle,
      dateTimeFormat: settings.dateTimeFormat,
      dateTimeCustomPattern: settings.dateTimeCustomPattern,
      showGitStatus: settings.showGitStatus,
      showProblemsInFiles: settings.showProblemsInFiles,
      showFoldersInList: settings.showFoldersInList,
      showFilesRowLines: settings.showFilesRowLines,
      showFilesColumnLines: settings.showFilesColumnLines,
      showFolderSize: settings.showFolderSize,
      selectActiveFile: settings.selectActiveFile,
      highlightOpenFiles,
      showPath: settings.showPath,
      fileContentSearch: settings.fileContentSearch,
      contentSearchActive,
      folderNavCanGoBack: folderNav.folderNavCanGoBack,
      folderNavCanGoForward: folderNav.folderNavCanGoForward,
      folderBreadcrumb: folderNav.folderBreadcrumb,
      openEditorPaths: openEditorPathsResolved,
      viewLayout,
      detailColWidthsPx: resolvePersistedDetailColWidths(this._context.workspaceState),
    };
  }

  private _tryPersistDetailColWidthsPx(px: number[] | undefined): boolean {
    if (!Array.isArray(px) || px.length !== 3) {
      return false;
    }
    const n = normalizeDetailColWidthsPx(px);
    if (n === null) {
      return false;
    }
    void this._context.workspaceState.update(WORKSPACE_DETAIL_COL_PX_KEY, n).then(() => {
      this._lastPostedStateSignature = undefined;
      const wv = this._view?.webview;
      if (wv) {
        void wv.postMessage({ type: "syncDetailColWidthsPx", detailColWidthsPx: n });
      }
    });
    return true;
  }

  private async _runCtxAction(action: string, uri: vscode.Uri): Promise<void> {
    const bump = (): void => this._onFsChange("both");
    switch (action) {
      case "open":
        await openFileInEditorFromWebview(uri, true);
        return;
      case "openToSide":
        await actions.openToSide(uri);
        return;
      case "revealInExplorer":
        await actions.revealInExplorerView(uri);
        return;
      case "revealInOs":
        await actions.revealInOs(uri);
        return;
      case "openInTerminal":
        await actions.openInIntegratedTerminal(uri);
        return;
      case "openWith":
        await actions.openWithPicker(uri);
        return;
      case "findInFolder":
        await actions.findInFolder(uri);
        return;
      case "explorerCut":
        await actions.explorerCut(uri);
        return;
      case "explorerCopy":
        await actions.explorerCopy(uri);
        return;
      case "explorerPaste":
        await actions.explorerPaste(uri);
        return;
      case "selectForCompare":
        await actions.selectForCompare(uri);
        return;
      case "openTimeline":
        await actions.openTimeline(uri);
        return;
      case "findFileReferences":
        await actions.findFileReferences(uri);
        return;
      case "cursorBlame":
        await actions.cursorOrGitBlame(uri);
        return;
      case "runTests":
        await actions.runTestsForExplorerItem(uri);
        return;
      case "addToCursorChat":
        await actions.addToCursorChat(uri);
        return;
      case "addToNewCursorChat":
        await actions.addToNewCursorChat(uri);
        return;
      case "newFile":
        await actions.newFileInFolder(uri, bump);
        return;
      case "newFolder":
        await actions.newFolderInFolder(uri, bump);
        return;
      case "copyPath":
        await actions.copyPath(uri);
        return;
      case "copyRelativePath":
        await actions.copyRelativePath(uri);
        return;
      case "rename":
        await actions.renameResource(uri, bump);
        return;
      case "delete":
        await actions.deleteResource(uri, bump);
        return;
      default:
        return;
    }
  }

  private _folderNavForState(folderFsPath: string): {
    folderNavCanGoBack: boolean;
    folderNavCanGoForward: boolean;
    folderBreadcrumb: FolderBreadcrumbSegment[];
  } {
    return {
      folderNavCanGoBack: this._folderHistPos > 0,
      folderNavCanGoForward:
        this._folderHistPos >= 0 && this._folderHistPos < this._folderHist.length - 1,
      folderBreadcrumb: folderFsPath ? buildFolderBreadcrumbSegments(folderFsPath) : [],
    };
  }

  /**
   * Met à jour l’historique avant d’afficher un nouveau dossier (sauf navigation Précédent / Suivant).
   * Réutilise une entrée existante si l’utilisateur sélectionne un dossier déjà dans l’historique (ex. arbre).
   */
  private _applyFolderHistoryBeforeShow(folderUri: vscode.Uri | undefined, historyNav: boolean): void {
    if (historyNav) {
      return;
    }
    const next = folderUri ? path.normalize(folderUri.fsPath) : "";
    const prev = this._lastFolderUri ? path.normalize(this._lastFolderUri.fsPath) : "";

    if (!next) {
      this._folderHist = [];
      this._folderHistPos = -1;
      return;
    }
    if (next === prev) {
      return;
    }

    const i = this._folderHist.lastIndexOf(next);
    if (i !== -1) {
      this._folderHistPos = i;
      return;
    }
    this._folderHist = this._folderHist.slice(0, this._folderHistPos + 1);
    this._folderHist.push(next);
    this._folderHistPos = this._folderHist.length - 1;
  }

  private _goFolderHistoryBack(): void {
    if (this._folderHistPos <= 0) {
      return;
    }
    this._folderHistPos--;
    const target = vscode.Uri.file(this._folderHist[this._folderHistPos]);
    void this._applyHistoryFolderAndSyncTree(target);
  }

  private _goFolderHistoryForward(): void {
    if (this._folderHistPos < 0 || this._folderHistPos >= this._folderHist.length - 1) {
      return;
    }
    this._folderHistPos++;
    const target = vscode.Uri.file(this._folderHist[this._folderHistPos]);
    void this._applyHistoryFolderAndSyncTree(target);
  }

  private async _applyHistoryFolderAndSyncTree(target: vscode.Uri): Promise<void> {
    await this.showFolder(target, true, { historyNav: true });
    await this._onNavigateToFolder(target);
  }

  /**
   * Shows files for `folderUri`. Changing folder updates immediately; refreshing the same folder
   * is debounced so Git/FS events do not blank the webview repeatedly.
   * @param forceImmediate Skip debounce (e.g. user Refresh, first webview attach with pending folder).
   */
  async showFolder(
    folderUri: vscode.Uri | undefined,
    forceImmediate = false,
    options?: { historyNav?: boolean }
  ): Promise<void> {
    const view = this._view;
    const nextKey = this._normalizeFolderKey(folderUri);
    const prevKey = this._normalizeFolderKey(this._lastFolderUri);
    const folderChanged = nextKey !== prevKey;
    if (folderChanged) {
      this._applyFolderHistoryBeforeShow(folderUri, options?.historyNav === true);
      this._invalidateFilesListingCache();
      this._contentSearchQuery = "";
    }

    this._lastFolderUri = folderUri;

    if (!view) {
      this._cancelShowFolderDebounce();
      this._pendingFolder = folderUri;
      this._syncFolderWatcher(folderUri);
      return;
    }
    if (!view.visible) {
      this._refreshDirtyWhenHidden = true;
      this._syncFolderWatcher(folderUri);
      return;
    }

    // Empty pane always paints immediately; only coalesce re-scans of the same folder.
    if (forceImmediate || folderChanged || folderUri === undefined) {
      this._cancelShowFolderDebounce();
      await this._requestShowFolderFlush();
      return;
    }

    this._scheduleShowFolderFlush();
  }

  private async _showFolderFlush(): Promise<void> {
    const folderUri = this._lastFolderUri;
    const view = this._view;
    if (!view) {
      return;
    }

    const incomingRefreshMode = this._refreshMode;
    this._refreshMode = "full";

    const settingsConfigs = resolveEnhanceExplorerSettingsConfigs();
    const settings = getFilesSettingsSnapshot(this._context.workspaceState, settingsConfigs);
    const viewLayout = getViewLayoutForFilesPane(this._context.workspaceState, settingsConfigs);
    const showGitStatus = settings.showGitStatus;
    const showProblemsInFiles = settings.showProblemsInFiles;
    const showFoldersInList = settings.showFoldersInList;
    const showFolderSize = settings.showFolderSize;
    const revealOsTitle = actions.revealInOsMenuTitle();
    const openEditorPathsResolved = settings.highlightOpenFiles ? collectOpenWorkspaceFilePaths() : [];

    if (!folderUri) {
      this._rowCacheListingKey = undefined;
      this._rowCachePayloads = undefined;
      const emptyPayload = this._buildStatePayload(
        "",
        [],
        revealOsTitle,
        settings,
        viewLayout,
        openEditorPathsResolved,
        false,
        this._folderNavForState("")
      );
      this._postFilePaneStateIfChanged(view, emptyPayload, null);
      this._syncFolderWatcher(undefined);
      this._postEditorSelectionToWebview();
      return;
    }

    const listingKey = filesListingCacheKey(folderUri, showFoldersInList);
    const qTrim = this._contentSearchQuery.trim();
    const contentSearchOn = settings.fileContentSearch && qTrim.length > 0;
    const contentListingKey = `content\t${listingKey}\t${qTrim}`;
    const contentCacheActive = this._rowCacheListingKey?.startsWith("content\t") === true;

    const gitOnlyEligible =
      incomingRefreshMode === "git" &&
      showGitStatus &&
      this._rowCachePayloads !== undefined &&
      ((contentCacheActive && this._rowCacheListingKey === contentListingKey) ||
        (!contentCacheActive &&
          this._rowCacheListingKey === listingKey &&
          this._filesListingCacheKey === listingKey));

    if (gitOnlyEligible) {
      const newRows = this._rowCachePayloads!.map((r) => this._rowWithFreshGit(r));
      this._rowCachePayloads = newRows;
      const filledPayload = this._buildStatePayload(
        folderUri.fsPath,
        newRows,
        revealOsTitle,
        settings,
        viewLayout,
        openEditorPathsResolved,
        contentCacheActive,
        this._folderNavForState(folderUri.fsPath)
      );
      let fileRowCount = 0;
      let folderRowCount = 0;
      for (const r of newRows) {
        if (r.kind === "folder") {
          folderRowCount++;
        } else {
          fileRowCount++;
        }
      }
      this._postFilePaneStateIfChanged(view, filledPayload, {
        fileCount: fileRowCount,
        folderCount: folderRowCount,
        showFoldersInList,
      });
      this._syncFolderWatcher(folderUri);
      this._postEditorSelectionToWebview();
      return;
    }

    const folderKeyAtStart = this._normalizeFolderKey(folderUri);

    let rows: FileViewRowPayload[] = [];
    let contentSearchActive = false;

    if (contentSearchOn) {
      try {
        rows = await this._runContentSearchWithUi(
          folderUri,
          qTrim,
          showGitStatus,
          showProblemsInFiles
        );
        contentSearchActive = true;
      } catch {
        rows = [];
      }
      if (this._normalizeFolderKey(this._lastFolderUri) !== folderKeyAtStart) {
        return;
      }
      this._rowCacheListingKey = contentListingKey;
      this._rowCachePayloads = rows;
    } else {
      try {
        rows = await this._buildRowsForFolder(
          folderUri,
          showFoldersInList,
          showGitStatus,
          showProblemsInFiles,
          showFolderSize
        );
      } catch {
        rows = [];
        this._rowCacheListingKey = undefined;
        this._rowCachePayloads = undefined;
      }
      if (this._normalizeFolderKey(this._lastFolderUri) !== folderKeyAtStart) {
        return;
      }
      this._rowCacheListingKey = listingKey;
      this._rowCachePayloads = rows;
    }

    const filledPayload = this._buildStatePayload(
      folderUri.fsPath,
      rows,
      revealOsTitle,
      settings,
      viewLayout,
      openEditorPathsResolved,
      contentSearchActive,
      this._folderNavForState(folderUri.fsPath)
    );
    let fileRowCount = 0;
    let folderRowCount = 0;
    for (const r of rows) {
      if (r.kind === "folder") {
        folderRowCount++;
      } else {
        fileRowCount++;
      }
    }
    this._postFilePaneStateIfChanged(view, filledPayload, {
      fileCount: fileRowCount,
      folderCount: folderRowCount,
      showFoldersInList: contentSearchActive ? false : showFoldersInList,
    });
    if (!contentSearchOn) {
      this._queueFolderSizeScan(folderUri, listingKey, rows, showFolderSize);
    }
    this._syncFolderWatcher(folderUri);
    this._postEditorSelectionToWebview();
  }

  private _getResourceWebviewUri(webview: vscode.Webview, ...segments: string[]): vscode.Uri {
    return webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, ...segments));
  }

  private _handleWebviewMessage(msg: FilePaneWebviewInboundMessage): void {
    if (msg?.type === "saveDetailColWidthsPx") {
      void this._tryPersistDetailColWidthsPx(msg.detailColWidthsPx);
      return;
    }
    if (
      msg?.type === "setViewLayout" &&
      (msg.value === "detail" || msg.value === "list" || msg.value === "icons")
    ) {
      void this._context.workspaceState.update(FILES_PANE_VIEW_LAYOUT_STATE_KEY, msg.value).then(() => {
        this._requestRefreshCurrentFolder();
      });
      return;
    }
    if (msg?.type === "setShowFoldersInList" && typeof msg.value === "boolean") {
      void setShowFoldersInFilesList(this._context.workspaceState, msg.value).then(() => {
        this._invalidateFilesListingCache();
        this._requestRefreshCurrentFolder();
      });
      return;
    }
    if (msg?.type === "setFileContentSearch" && typeof msg.value === "boolean") {
      void setFileContentSearch(this._context.workspaceState, msg.value).then(() => {
        this._invalidateFilesListingCache();
        this._requestRefreshCurrentFolder();
      });
      return;
    }
    if (msg?.type === "contentSearchQuery" && typeof msg.value === "string") {
      this._contentSearchQuery = msg.value.length > 500 ? msg.value.slice(0, 500) : msg.value;
      this._invalidateFilesListingCache();
      this._requestRefreshCurrentFolder();
      return;
    }
    if (msg?.type === "setShowGitStatus" && typeof msg.value === "boolean") {
      void setShowGitInFiles(this._context.workspaceState, msg.value).then(() => {
        this._requestRefreshCurrentFolder();
      });
      return;
    }
    if (msg?.type === "setShowProblemsInFiles" && typeof msg.value === "boolean") {
      void setShowProblemsInFiles(this._context.workspaceState, msg.value).then(() => {
        this._requestRefreshCurrentFolder();
      });
      return;
    }
    if (msg?.type === "setShowFilesRowLines" && typeof msg.value === "boolean") {
      void setShowFilesRowLines(this._context.workspaceState, msg.value).then(() => {
        this._requestRefreshCurrentFolder();
      });
      return;
    }
    if (msg?.type === "setShowFilesColumnLines" && typeof msg.value === "boolean") {
      void setShowFilesColumnLines(this._context.workspaceState, msg.value).then(() => {
        this._requestRefreshCurrentFolder();
      });
      return;
    }
    if (msg?.type === "setShowFolderSize" && typeof msg.value === "boolean") {
      void setShowFolderSize(this._context.workspaceState, msg.value).then(() => {
        if (!msg.value) {
          this._folderSizeCache.clear();
          this._folderSizeJobId++;
        }
        this._requestRefreshCurrentFolder();
      });
      return;
    }
    if (msg?.type === "setSelectActiveFile" && typeof msg.value === "boolean") {
      void setSelectActiveFile(this._context.workspaceState, msg.value).then(() => {
        this._requestRefreshCurrentFolder();
        this._onSelectActiveFilePolicyChanged?.();
      });
      return;
    }
    if (msg?.type === "setHighlightOpenFiles" && typeof msg.value === "boolean") {
      void setHighlightOpenFiles(this._context.workspaceState, msg.value).then(() => {
        this._requestRefreshCurrentFolder();
        this._syncOpenEditorsHighlight();
      });
      return;
    }
    if (msg?.type === "setShowPath" && typeof msg.value === "boolean") {
      void setShowPath(this._context.workspaceState, msg.value).then(() => {
        this._requestRefreshCurrentFolder();
      });
      return;
    }
    if (msg?.type === "folderHistoryBack") {
      this._goFolderHistoryBack();
      return;
    }
    if (msg?.type === "folderHistoryForward") {
      this._goFolderHistoryForward();
      return;
    }
    if (msg?.type === "selectFolderRow" && typeof msg.path === "string" && msg.path.length > 0) {
      const displayFolder = this._lastFolderUri;
      const wv = this._view?.webview;
      if (!displayFolder || !wv) {
        return;
      }
      const disp = path.normalize(displayFolder.fsPath);
      const target = path.normalize(msg.path);
      if (!isNormalizedFsPathDescendantOrSelf(disp, target)) {
        return;
      }
      const crumbs = buildFolderBreadcrumbSegments(target);
      void wv.postMessage({ type: "folderRowSelect", path: target, folderBreadcrumb: crumbs });
      return;
    }
    if (msg?.type === "openFolder" && msg.path) {
      void this._onNavigateToFolder(vscode.Uri.file(msg.path));
      return;
    }
    if (msg?.type === "openFile" && msg.path) {
      const uri = vscode.Uri.file(msg.path);
      const preview = msg.preview !== false;
      void openFileInEditorFromWebview(uri, preview);
      return;
    }
    if (msg?.type === "ctx" && msg.path && msg.action) {
      const uri = vscode.Uri.file(msg.path);
      void this._runCtxAction(msg.action, uri).catch((err) => {
        const m = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(m);
      });
    }
  }

  private _getHtml(webview: vscode.Webview): string {
    const nonce = String(Date.now());
    const codiconCssUri = this._getCodiconCssUri(webview);
    const filePaneCssCommonUri = this._getResourceWebviewUri(webview, FILE_PANE_WEBVIEW_DIR, FILE_PANE_WEBVIEW_CSS_COMMON);
    const filePaneCssListUri = this._getResourceWebviewUri(webview, FILE_PANE_WEBVIEW_DIR, FILE_PANE_WEBVIEW_CSS_LAYOUT_LIST);
    const filePaneCssDetailUri = this._getResourceWebviewUri(webview, FILE_PANE_WEBVIEW_DIR, FILE_PANE_WEBVIEW_CSS_LAYOUT_DETAIL);
    const filePaneCssIconsUri = this._getResourceWebviewUri(webview, FILE_PANE_WEBVIEW_DIR, FILE_PANE_WEBVIEW_CSS_LAYOUT_ICONS);
    const filePaneJsIconsUri = this._getResourceWebviewUri(webview, FILE_PANE_WEBVIEW_DIR, FILE_PANE_WEBVIEW_JS_ICONS);
    const filePaneJsColumnsUri = this._getResourceWebviewUri(webview, FILE_PANE_WEBVIEW_DIR, FILE_PANE_WEBVIEW_JS_COLUMNS);
    const filePaneJsMenusUri = this._getResourceWebviewUri(webview, FILE_PANE_WEBVIEW_DIR, FILE_PANE_WEBVIEW_JS_MENUS);
    const filePaneJsFormatUri = this._getResourceWebviewUri(webview, FILE_PANE_WEBVIEW_DIR, FILE_PANE_WEBVIEW_JS_FORMAT);
    const filePaneJsFilterHighlightUri = this._getResourceWebviewUri(
      webview,
      FILE_PANE_WEBVIEW_DIR,
      FILE_PANE_WEBVIEW_JS_FILTER_HIGHLIGHT
    );
    const filePaneJsGitBadgesUri = this._getResourceWebviewUri(webview, FILE_PANE_WEBVIEW_DIR, FILE_PANE_WEBVIEW_JS_GIT_BADGES);
    const filePaneJsTableUri = this._getResourceWebviewUri(webview, FILE_PANE_WEBVIEW_DIR, FILE_PANE_WEBVIEW_JS_TABLE);
    const filePaneJsIconGridUri = this._getResourceWebviewUri(webview, FILE_PANE_WEBVIEW_DIR, FILE_PANE_WEBVIEW_JS_ICON_GRID);
    const filePaneJsUri = this._getResourceWebviewUri(webview, FILE_PANE_WEBVIEW_DIR, FILE_PANE_WEBVIEW_JS);
    const persistedDetailColWidthsPx = resolvePersistedDetailColWidths(this._context.workspaceState);
    const htmlSettingsConfigs = resolveEnhanceExplorerSettingsConfigs();
    const filesSnap = getFilesSettingsSnapshot(this._context.workspaceState, htmlSettingsConfigs);
    const filesPaneLayout = getViewLayoutForFilesPane(this._context.workspaceState, htmlSettingsConfigs);
    const filePaneBoot = {
      persistedDetailColWidthsPx,
      defaultDetailColWidthsPx: [...DEFAULT_DETAIL_COL_PX],
      detailColMinPx: [...MIN_DETAIL_COL_PX],
      detailColMaxPx: [...MAX_DETAIL_COL_PX],
      /** OS path separator for breadcrumb display (`\\` on Windows, `/` on POSIX). */
      fsPathSep: path.sep,
      dateTimeCustomPattern: DEFAULT_DATE_TIME_CUSTOM_PATTERN,
      showGitStatus: filesSnap.showGitStatus,
      showProblemsInFiles: filesSnap.showProblemsInFiles,
      showFilesRowLines: filesSnap.showFilesRowLines,
      showFilesColumnLines: filesSnap.showFilesColumnLines,
      showFolderSize: filesSnap.showFolderSize,
      selectActiveFile: filesSnap.selectActiveFile,
      highlightOpenFiles: filesSnap.highlightOpenFiles,
      showPath: filesSnap.showPath,
      fileContentSearch: filesSnap.fileContentSearch,
      openEditorPaths: filesSnap.highlightOpenFiles ? collectOpenWorkspaceFilePaths() : [],
      viewLayout: filesPaneLayout,
    };
    const csp = buildFilePaneWebviewCsp(webview, nonce);
    const shellPath = path.join(this._context.extensionPath, FILE_PANE_WEBVIEW_DIR, FILE_PANE_WEBVIEW_SHELL);
    let template: string;
    if (this._cachedWebviewShellPath === shellPath && this._cachedWebviewShellTemplate !== undefined) {
      template = this._cachedWebviewShellTemplate;
    } else {
      try {
        template = fs.readFileSync(shellPath, "utf8");
        this._cachedWebviewShellPath = shellPath;
        this._cachedWebviewShellTemplate = template;
      } catch {
        this._cachedWebviewShellPath = undefined;
        this._cachedWebviewShellTemplate = undefined;
        void vscode.window.showErrorMessage(`Explorer Enhanced: missing webview shell (${FILE_PANE_WEBVIEW_SHELL}).`);
        return "<!DOCTYPE html><html><body><p>Explorer Enhanced: missing webview template.</p></body></html>";
      }
    }
    const fragTrigger = `${svgExplorerViewIcons(filesPaneLayout !== "icons", true)}${svgExplorerViewList(
      filesPaneLayout !== "list",
      true
    )}${svgExplorerViewDetail(filesPaneLayout !== "detail", true)}`;
    const subs: Record<string, string> = {
      CSP: csp,
      NONCE: nonce,
      URI_CODICON: codiconCssUri.toString(),
      URI_CSS_COMMON: filePaneCssCommonUri.toString(),
      URI_CSS_LIST: filePaneCssListUri.toString(),
      URI_CSS_DETAIL: filePaneCssDetailUri.toString(),
      URI_CSS_ICONS: filePaneCssIconsUri.toString(),
      URI_JS_ICONS: filePaneJsIconsUri.toString(),
      URI_JS_COLUMNS: filePaneJsColumnsUri.toString(),
      URI_JS_MENUS: filePaneJsMenusUri.toString(),
      URI_JS_FORMAT: filePaneJsFormatUri.toString(),
      URI_JS_FILTER_HIGHLIGHT: filePaneJsFilterHighlightUri.toString(),
      URI_JS_GIT_BADGES: filePaneJsGitBadgesUri.toString(),
      URI_JS_TABLE: filePaneJsTableUri.toString(),
      URI_JS_ICON_GRID: filePaneJsIconGridUri.toString(),
      URI_JS: filePaneJsUri.toString(),
      FRAG_VIEWS_TRIGGER: fragTrigger,
      FRAG_MENU_ICON_LIST: svgExplorerViewList(false, false),
      FRAG_MENU_ICON_DETAIL: svgExplorerViewDetail(false, false),
      FRAG_MENU_ICON_ICONS: svgExplorerViewIcons(false, false),
    };
    let html = template;
    for (const [key, value] of Object.entries(subs)) {
      html = html.split(`@@${key}@@`).join(value);
    }
    html = html.replace(
      "window.__FILE_PANE_BOOT__ = null;",
      `window.__FILE_PANE_BOOT__ = ${JSON.stringify(filePaneBoot)};`
    );
    return html;
  }

}
