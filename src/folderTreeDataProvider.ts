import * as path from "path";
import * as vscode from "vscode";
import { isFsDirectory, isFsFile } from "./fileTypeUtils";
import { getShowFilesInFolderTreeFromWorkspaceState } from "./filePaneSettings";

const MEMENTO_KEY = "explorer-enhanced.folderTree.snapshot.v1";
const PERSIST_DEBOUNCE_MS = 800;
/** Coalesce bursty `refresh()` calls from FS/Git bumps before the tree rebuilds. */
export const FOLDER_TREE_REFRESH_DEBOUNCE_MS = 80;
/** Quiet period after {@link refresh} before `treeView.reveal` (avoids duplicate tree node ids). */
const FOLDER_TREE_REFRESH_SETTLE_MS = 50;
/** Parallelism for the background chevron probe that corrects optimistic chevrons after first paint. */
const CHEVRON_PROBE_CONCURRENCY = 8;
/** Coalesce chevron probes across sibling expands before firing targeted corrections. */
const CHEVRON_PROBE_DEBOUNCE_MS = 120;

function collapsibleIfExpandable(hasExpandableChildren: boolean): vscode.TreeItemCollapsibleState {
  return hasExpandableChildren
    ? vscode.TreeItemCollapsibleState.Collapsed
    : vscode.TreeItemCollapsibleState.None;
}

/** Run `fn` over `items` with bounded concurrency (background chevron probing). */
async function mapPool<T>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const idx = next++;
      await fn(items[idx]);
    }
  });
  await Promise.all(workers);
}

function cacheKey(uri: vscode.Uri): string {
  return path.normalize(uri.fsPath);
}

/** Subfolder names only — stable when memento cache lists dirs-only vs disk lists files+dirs. */
function directoryNamesKey(entries: [string, vscode.FileType][] | undefined): string {
  if (!entries?.length) {
    return "";
  }
  return entries
    .filter(([, t]) => isFsDirectory(t))
    .map(([n]) => n)
    .sort()
    .join("\0");
}

/** Full listing signature (dirs + files) for revalidation when files are shown in the tree. */
function fullEntriesKey(entries: [string, vscode.FileType][] | undefined): string {
  if (!entries?.length) {
    return "";
  }
  return [...entries]
    .map(([n, t]) => n + "\t" + String(t))
    .sort()
    .join("\0");
}

interface PersistedSubdir {
  n: string;
  sub: boolean;
}

interface PersistedSnapshot {
  v: 1;
  roots: string[];
  nodes: Record<string, PersistedSubdir[]>;
}

function sortedWorkspaceRoots(folders: readonly vscode.WorkspaceFolder[]): string[] {
  return folders.map((f) => path.normalize(f.uri.fsPath)).sort();
}

function rootsMatchSnapshot(
  folders: readonly vscode.WorkspaceFolder[],
  snap: PersistedSnapshot
): boolean {
  const a = sortedWorkspaceRoots(folders);
  const b = [...snap.roots].sort();
  if (a.length !== b.length) {
    return false;
  }
  return a.every((x, i) => x === b[i]);
}

function isPersistedSnapshot(raw: unknown): raw is PersistedSnapshot {
  if (!raw || typeof raw !== "object") {
    return false;
  }
  const o = raw as PersistedSnapshot;
  return (
    o.v === 1 &&
    Array.isArray(o.roots) &&
    typeof o.nodes === "object" &&
    o.nodes !== null &&
    !Array.isArray(o.nodes)
  );
}

/**
 * Tree item: workspace folder / subdirectory, or a file when {@link explorer-enhanced.folders.showFilesInTree} is on.
 */
export class FolderTreeItem extends vscode.TreeItem {
  constructor(
    public readonly uri: vscode.Uri,
    label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    /** Leaf file row in Folders (not a directory in the tree model). */
    public readonly isFileEntry = false,
    /** Top-level workspace folder row (multi-root root), not a subfolder. */
    public readonly isWorkspaceRootFolder = false
  ) {
    super(label, collapsibleState);
    if (this.isFileEntry) {
      this.id = "explorer-enhanced.file:" + cacheKey(uri);
      this.contextValue = "explorer-enhanced.treeFile";
      this.iconPath = vscode.ThemeIcon.File;
      this.command = {
        title: "Open",
        command: "vscode.open",
        arguments: [uri],
        tooltip: "Open file",
      };
    } else {
      this.id = "explorer-enhanced.folder:" + cacheKey(uri);
      this.contextValue = isWorkspaceRootFolder
        ? "explorer-enhanced.workspaceRoot"
        : "explorer-enhanced.folder";
      this.iconPath = vscode.ThemeIcon.Folder;
    }
    this.tooltip = uri.fsPath;
    this.resourceUri = uri;
  }
}

export class FolderTreeDataProvider implements vscode.TreeDataProvider<FolderTreeItem> {
  private readonly _onDidChange = new vscode.EventEmitter<FolderTreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  /** In-memory directory listings until {@link refresh}; speeds re-expand and avoids duplicate `readDirectory` while navigating. */
  private readonly _dirListCache = new Map<string, [string, vscode.FileType][]>();

  /**
   * Live folder-item references handed to VS Code by {@link getChildren}, keyed by normalized fsPath.
   * VS Code's tree model is keyed by object reference (`_nodes: Map<T, TreeNode>`), so a targeted
   * `onDidChangeTreeData.fire(element)` only works with the exact reference it still holds. Kept current
   * on every {@link getChildren} and used by {@link applyFsChanges} for native-style incremental refresh.
   */
  private readonly _itemsByKey = new Map<string, FolderTreeItem>();

  /**
   * Known "has visible children" per directory (dirs-only, or any entry when files are shown in the tree).
   * Fills lazily via a background probe so chevrons start optimistic (no blocking IO) then self-correct:
   * a directory proven empty flips `Collapsed` → `None`. Cleared on {@link refresh}, pruned on delete.
   */
  private readonly _hasChildrenCache = new Map<string, boolean>();
  /** Parent key → child directory URIs awaiting a background chevron probe. */
  private readonly _chevronProbePending = new Map<string, vscode.Uri[]>();
  private _chevronProbeTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * When `true`, a persisted folder-only snapshot may hydrate the first paint after reload (dirs-only tree).
   * Set to `false` by {@link refresh} or when disk listing diverges from the snapshot; goes back to `true` only in a new window (new host).
   */
  private _trustMemento = true;

  private _persistTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly _pendingNodeUpdates = new Map<string, PersistedSubdir[]>();
  private _refreshDebounceTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly _refreshDebounceWaiters: Array<() => void> = [];
  private _refreshGeneration = 0;
  private _refreshSettleTail: Promise<void> = Promise.resolve();

  constructor(private readonly _workspaceState: vscode.Memento) {}

  /** Persisted folder-only snapshot is invalid when files are mixed into the tree. */
  private _useFolderTreeMemento(showFilesInFolderTree = this._showFilesInFolderTree()): boolean {
    return this._trustMemento && !showFilesInFolderTree;
  }

  private _showFilesInFolderTree(): boolean {
    return getShowFilesInFolderTreeFromWorkspaceState(this._workspaceState);
  }

  private _listingChanged(
    prev: [string, vscode.FileType][] | undefined,
    next: [string, vscode.FileType][],
    showFilesInFolderTree = this._showFilesInFolderTree()
  ): boolean {
    if (showFilesInFolderTree) {
      return fullEntriesKey(prev) !== fullEntriesKey(next);
    }
    return directoryNamesKey(prev) !== directoryNamesKey(next);
  }

  dispose(): void {
    if (this._persistTimer !== undefined) {
      clearTimeout(this._persistTimer);
      this._persistTimer = undefined;
    }
    if (this._refreshDebounceTimer !== undefined) {
      clearTimeout(this._refreshDebounceTimer);
      this._refreshDebounceTimer = undefined;
    }
    if (this._chevronProbeTimer !== undefined) {
      clearTimeout(this._chevronProbeTimer);
      this._chevronProbeTimer = undefined;
    }
    if (this._pendingNodeUpdates.size > 0) {
      this._runPersist();
    }
  }

  /**
   * Debounced {@link refresh} for high-frequency FS signals; user commands should call {@link refresh} directly.
   */
  scheduleRefresh(): void {
    if (this._refreshDebounceTimer !== undefined) {
      clearTimeout(this._refreshDebounceTimer);
    }
    this._refreshDebounceTimer = setTimeout(() => {
      this._refreshDebounceTimer = undefined;
      const waiters = this._refreshDebounceWaiters.splice(0);
      this.refresh();
      for (const done of waiters) {
        done();
      }
    }, FOLDER_TREE_REFRESH_DEBOUNCE_MS);
  }

  refresh(): void {
    this._dirListCache.clear();
    this._itemsByKey.clear();
    this._hasChildrenCache.clear();
    this._chevronProbePending.clear();
    if (this._chevronProbeTimer !== undefined) {
      clearTimeout(this._chevronProbeTimer);
      this._chevronProbeTimer = undefined;
    }
    this._trustMemento = false;
    this._pendingNodeUpdates.clear();
    if (this._persistTimer !== undefined) {
      clearTimeout(this._persistTimer);
      this._persistTimer = undefined;
    }
    const generation = ++this._refreshGeneration;
    this._onDidChange.fire();
    this._refreshSettleTail = this._refreshSettleTail.then(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            if (this._refreshGeneration === generation) {
              resolve();
            } else {
              resolve();
            }
          }, FOLDER_TREE_REFRESH_SETTLE_MS);
        })
    );
  }

  /** Wait until debounced refresh (if any) has run and the tree has been quiet briefly. */
  async whenRefreshSettled(): Promise<void> {
    if (this._refreshDebounceTimer !== undefined) {
      await new Promise<void>((resolve) => {
        this._refreshDebounceWaiters.push(resolve);
      });
    }
    await this._refreshSettleTail;
  }

  private _loadSnapshot(): PersistedSnapshot | undefined {
    const raw = this._workspaceState.get<unknown>(MEMENTO_KEY);
    return isPersistedSnapshot(raw) ? raw : undefined;
  }

  private _schedulePersist(): void {
    if (this._persistTimer !== undefined) {
      clearTimeout(this._persistTimer);
    }
    this._persistTimer = setTimeout(() => {
      this._persistTimer = undefined;
      this._runPersist();
    }, PERSIST_DEBOUNCE_MS);
  }

  private _runPersist(): void {
    if (this._pendingNodeUpdates.size === 0) {
      return;
    }
    const base = this._loadSnapshot() ?? { v: 1, roots: [], nodes: {} };
    const folders = vscode.workspace.workspaceFolders ?? [];
    base.roots = sortedWorkspaceRoots(folders);
    for (const [k, dirs] of this._pendingNodeUpdates) {
      base.nodes[k] = dirs;
    }
    this._pendingNodeUpdates.clear();
    void this._workspaceState.update(MEMENTO_KEY, base);
  }

  private _queueNodePersist(parentKey: string, childFolderItems: FolderTreeItem[]): void {
    const row: PersistedSubdir[] = childFolderItems.map((it) => ({
      n: String(it.label ?? path.basename(it.uri.fsPath)),
      sub: it.collapsibleState !== vscode.TreeItemCollapsibleState.None,
    }));
    this._pendingNodeUpdates.set(parentKey, row);
    this._schedulePersist();
  }

  private async _revalidateRoots(folders: readonly vscode.WorkspaceFolder[]): Promise<void> {
    const showFilesInFolderTree = this._showFilesInFolderTree();
    let anyChange = false;
    for (const wf of folders) {
      const pk = cacheKey(wf.uri);
      let entries: [string, vscode.FileType][];
      try {
        entries = await vscode.workspace.fs.readDirectory(wf.uri);
      } catch {
        entries = [];
      }
      const prev = this._dirListCache.get(pk);
      if (this._listingChanged(prev, entries, showFilesInFolderTree)) {
        anyChange = true;
      }
      this._dirListCache.set(pk, entries);
    }
    if (anyChange) {
      this._trustMemento = false;
      this._onDidChange.fire();
    }
  }

  private async _revalidateNode(element: FolderTreeItem): Promise<void> {
    const showFilesInFolderTree = this._showFilesInFolderTree();
    const pk = cacheKey(element.uri);
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(element.uri);
    } catch {
      entries = [];
    }
    const prev = this._dirListCache.get(pk);
    if (this._listingChanged(prev, entries, showFilesInFolderTree)) {
      this._trustMemento = false;
      this._dirListCache.set(pk, entries);
      this._onDidChange.fire(element);
    }
  }

  private async listDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const key = cacheKey(uri);
    const hit = this._dirListCache.get(key);
    if (hit) {
      return hit;
    }
    try {
      const entries = await vscode.workspace.fs.readDirectory(uri);
      this._dirListCache.set(key, entries);
      return entries;
    } catch {
      const empty: [string, vscode.FileType][] = [];
      this._dirListCache.set(key, empty);
      return empty;
    }
  }

  private _rootHasVisibleChildren(
    entries: [string, vscode.FileType][],
    showFilesInFolderTree = this._showFilesInFolderTree()
  ): boolean {
    const hasDir = entries.some(([, t]) => isFsDirectory(t));
    if (hasDir) {
      return true;
    }
    return showFilesInFolderTree && entries.some(([, t]) => isFsFile(t));
  }

  /** Build sorted child rows: folders first, then files (when enabled). */
  private async _buildChildItems(parentUri: vscode.Uri): Promise<FolderTreeItem[]> {
    const entries = await this.listDirectory(parentUri);
    const showFiles = this._showFilesInFolderTree();
    const dirEntries = entries.filter(([, t]) => isFsDirectory(t));
    /**
     * One `readDirectory` per parent. Chevrons start optimistic (`Collapsed`) to avoid an IO probe per
     * child, then a debounced background probe ({@link _scheduleChevronProbe}) flips proven-empty dirs to
     * `None` — accurate chevrons without blocking first paint. Known-empty dirs render correctly at once.
     */
    const childDirUris = dirEntries.map(([name]) => vscode.Uri.joinPath(parentUri, name));
    const dirs = dirEntries.map(([name], i) => {
      const childUri = childDirUris[i];
      return new FolderTreeItem(childUri, name, this._collapsibleForDir(childUri), false);
    });
    this._scheduleChevronProbe(parentUri, childDirUris);
    dirs.sort((a, b) =>
      String(a.label ?? a.uri.fsPath).localeCompare(String(b.label ?? b.uri.fsPath), undefined, {
        sensitivity: "base",
      })
    );
    if (!showFiles) {
      return dirs;
    }
    const fileEntries = entries.filter(([, t]) => isFsFile(t));
    fileEntries.sort(([a], [b]) => a.localeCompare(b, undefined, { sensitivity: "base" }));
    const files = fileEntries.map(([name]) =>
      new FolderTreeItem(
        vscode.Uri.joinPath(parentUri, name),
        name,
        vscode.TreeItemCollapsibleState.None,
        true
      )
    );
    return [...dirs, ...files];
  }

  private _tryChildrenFromMemento(
    parentUri: vscode.Uri,
    snap: PersistedSnapshot
  ): FolderTreeItem[] | undefined {
    const pk = cacheKey(parentUri);
    if (!Object.prototype.hasOwnProperty.call(snap.nodes, pk)) {
      return undefined;
    }
    const dirs = snap.nodes[pk];
    if (!Array.isArray(dirs)) {
      return undefined;
    }
    this._dirListCache.set(
      pk,
      dirs.map((d) => [d.n, vscode.FileType.Directory] as [string, vscode.FileType])
    );
    const childDirUris = dirs.map((d) => vscode.Uri.joinPath(parentUri, d.n));
    const items = dirs.map((d, i) => {
      const childUri = childDirUris[i];
      /**
       * Prefer the probed chevron cache; fall back to the snapshot `sub` flag only while unknown.
       * The snapshot can be stale (pre-1.0.11 persisted every folder as expandable), so the probe below
       * always verifies and corrects.
       */
      const known = this._hasChildrenCache.get(cacheKey(childUri));
      const collapsible =
        known === undefined
          ? collapsibleIfExpandable(d.sub)
          : known
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None;
      return new FolderTreeItem(childUri, d.n, collapsible);
    });
    this._scheduleChevronProbe(parentUri, childDirUris);
    items.sort((a, b) =>
      String(a.label ?? a.uri.fsPath).localeCompare(String(b.label ?? b.uri.fsPath), undefined, {
        sensitivity: "base",
      })
    );
    return items;
  }

  /**
   * Build a tree item for a workspace folder path (same labels as {@link getChildren}).
   * Used with {@link vscode.TreeView.reveal} when syncing selection from the active editor.
   */
  getTreeItemForFolderUri(folderUri: vscode.Uri): FolderTreeItem | undefined {
    const wf = vscode.workspace.getWorkspaceFolder(folderUri);
    if (!wf) {
      return undefined;
    }
    const rootNorm = path.normalize(wf.uri.fsPath);
    const targetNorm = path.normalize(folderUri.fsPath);
    const rel = path.relative(rootNorm, targetNorm);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      return undefined;
    }
    if (targetNorm === rootNorm) {
      return new FolderTreeItem(
        wf.uri,
        wf.name,
        vscode.TreeItemCollapsibleState.Collapsed,
        false,
        true
      );
    }
    return new FolderTreeItem(
      vscode.Uri.file(targetNorm),
      path.basename(targetNorm),
      vscode.TreeItemCollapsibleState.Collapsed
    );
  }

  /**
   * Tree row for a file child when {@link explorer-enhanced.folders.showFilesInTree} is on.
   * Used with {@link vscode.TreeView.reveal} so the file stays selected (not the parent folder).
   */
  async getTreeItemForFileUri(fileUri: vscode.Uri): Promise<FolderTreeItem | undefined> {
    if (!this._showFilesInFolderTree()) {
      return undefined;
    }
    const wf = vscode.workspace.getWorkspaceFolder(fileUri);
    if (!wf) {
      return undefined;
    }
    let stat: vscode.FileStat;
    try {
      stat = await vscode.workspace.fs.stat(fileUri);
    } catch {
      return undefined;
    }
    if (!isFsFile(stat.type)) {
      return undefined;
    }
    const name = path.basename(fileUri.fsPath);
    return new FolderTreeItem(
      fileUri,
      name,
      vscode.TreeItemCollapsibleState.None,
      true
    );
  }

  getTreeItem(element: FolderTreeItem): vscode.TreeItem {
    return element;
  }

  /** Track the folder-item references VS Code now holds so {@link applyFsChanges} can fire the exact ones. */
  private _registerItems(items: readonly FolderTreeItem[]): void {
    for (const it of items) {
      if (!it.isFileEntry) {
        this._itemsByKey.set(cacheKey(it.uri), it);
      }
    }
  }

  /** Optimistic chevron: `None` only when a prior probe proved the directory empty; otherwise `Collapsed`. */
  private _collapsibleForDir(dirUri: vscode.Uri): vscode.TreeItemCollapsibleState {
    return this._hasChildrenCache.get(cacheKey(dirUri)) === false
      ? vscode.TreeItemCollapsibleState.None
      : vscode.TreeItemCollapsibleState.Collapsed;
  }

  /** True when `dirUri` would show at least one row (subdir, or any entry when files are shown in the tree). */
  private async _dirHasVisibleChildren(dirUri: vscode.Uri, showFiles: boolean): Promise<boolean> {
    try {
      const entries = await vscode.workspace.fs.readDirectory(dirUri);
      return showFiles ? entries.length > 0 : entries.some(([, t]) => isFsDirectory(t));
    } catch {
      return false;
    }
  }

  /** Compute "has visible children" from an already-read listing (no extra IO). */
  private _entriesHaveVisibleChildren(
    entries: [string, vscode.FileType][],
    showFiles: boolean
  ): boolean {
    return showFiles ? entries.length > 0 : entries.some(([, t]) => isFsDirectory(t));
  }

  /** Queue unknown child directories for a debounced background probe to correct their chevrons. */
  private _scheduleChevronProbe(parentUri: vscode.Uri, childDirUris: readonly vscode.Uri[]): void {
    const unknown = childDirUris.filter((u) => !this._hasChildrenCache.has(cacheKey(u)));
    if (unknown.length === 0) {
      return;
    }
    const pk = cacheKey(parentUri);
    const existing = this._chevronProbePending.get(pk);
    this._chevronProbePending.set(pk, existing ? [...existing, ...unknown] : unknown);
    if (this._chevronProbeTimer !== undefined) {
      clearTimeout(this._chevronProbeTimer);
    }
    this._chevronProbeTimer = setTimeout(() => {
      this._chevronProbeTimer = undefined;
      void this._flushChevronProbe();
    }, CHEVRON_PROBE_DEBOUNCE_MS);
  }

  private async _flushChevronProbe(): Promise<void> {
    const batch = [...this._chevronProbePending];
    this._chevronProbePending.clear();
    const showFiles = this._showFilesInFolderTree();
    for (const [parentKey, childUris] of batch) {
      let needsRerender = false;
      await mapPool(childUris, CHEVRON_PROBE_CONCURRENCY, async (childUri) => {
        const key = cacheKey(childUri);
        if (this._hasChildrenCache.has(key)) {
          return;
        }
        const has = await this._dirHasVisibleChildren(childUri, showFiles);
        this._hasChildrenCache.set(key, has);
        if (!has) {
          /** Was rendered optimistically as `Collapsed`; now proven empty → chevron must disappear. */
          needsRerender = true;
        }
      });
      if (needsRerender) {
        const parentEl = this._itemsByKey.get(parentKey);
        if (parentEl) {
          this._onDidChange.fire(parentEl);
        }
        /** Heal the persisted snapshot so corrected chevrons survive reloads without re-probing. */
        this._persistChevronCorrection(parentKey);
      }
    }
  }

  /** Re-persist a parent's subdir `sub` flags from the probed chevron cache (dirs-only snapshot). */
  private _persistChevronCorrection(parentKey: string): void {
    if (this._showFilesInFolderTree()) {
      return;
    }
    const entries = this._dirListCache.get(parentKey);
    if (!entries) {
      return;
    }
    const parentUri = vscode.Uri.file(parentKey);
    const rows: PersistedSubdir[] = entries
      .filter(([, t]) => isFsDirectory(t))
      .map(([n]) => ({
        n,
        sub: this._hasChildrenCache.get(cacheKey(vscode.Uri.joinPath(parentUri, n))) !== false,
      }));
    this._pendingNodeUpdates.set(parentKey, rows);
    this._schedulePersist();
  }

  /** Drop cached listing + tracked references for `key` and everything beneath it (deleted/renamed subtree). */
  private _pruneSubtree(key: string): void {
    const prefix = key + path.sep;
    for (const k of [...this._dirListCache.keys()]) {
      if (k === key || k.startsWith(prefix)) {
        this._dirListCache.delete(k);
      }
    }
    for (const k of [...this._itemsByKey.keys()]) {
      if (k === key || k.startsWith(prefix)) {
        this._itemsByKey.delete(k);
      }
    }
    for (const k of [...this._hasChildrenCache.keys()]) {
      if (k === key || k.startsWith(prefix)) {
        this._hasChildrenCache.delete(k);
      }
    }
  }

  /**
   * Native-style incremental refresh after an FS change (mirrors VS Code's `ExplorerService.onDidFilesChange`).
   * Only parents already resolved/visible in the tree are re-read; each affected parent gets a targeted
   * `fire(parent)` instead of clearing the whole cache. Changes in collapsed/unknown branches are ignored
   * (re-read lazily on expand), which avoids the full-tree "big job" for churn outside the visible tree.
   */
  async applyFsChanges(changedUris: readonly vscode.Uri[]): Promise<void> {
    if (changedUris.length === 0) {
      return;
    }
    /** A deleted/renamed directory must not keep serving stale children if it reappears. */
    for (const u of changedUris) {
      this._pruneSubtree(cacheKey(u));
    }
    const parentKeys = new Set<string>();
    for (const u of changedUris) {
      parentKeys.add(path.normalize(path.dirname(u.fsPath)));
    }
    const showFilesInFolderTree = this._showFilesInFolderTree();
    for (const parentKey of parentKeys) {
      const element = this._itemsByKey.get(parentKey);
      if (!element) {
        /** Parent not resolved/visible → native would not refresh; fresh listing is read on next expand. */
        continue;
      }
      let entries: [string, vscode.FileType][];
      try {
        entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(parentKey));
      } catch {
        entries = [];
      }
      const prev = this._dirListCache.get(parentKey);
      this._dirListCache.set(parentKey, entries);
      if (this._listingChanged(prev, entries, showFilesInFolderTree)) {
        this._trustMemento = false;
        this._onDidChange.fire(element);
      }
      /** Keep this folder's own chevron correct: if it just became empty/non-empty, re-render its parent. */
      const hadChildren = this._hasChildrenCache.get(parentKey);
      const hasChildren = this._entriesHaveVisibleChildren(entries, showFilesInFolderTree);
      this._hasChildrenCache.set(parentKey, hasChildren);
      if (hadChildren !== undefined && hadChildren !== hasChildren) {
        const grandParent = this._itemsByKey.get(path.normalize(path.dirname(parentKey)));
        if (grandParent) {
          this._onDidChange.fire(grandParent);
        }
      }
    }
  }

  async getChildren(element?: FolderTreeItem): Promise<FolderTreeItem[]> {
    const showFilesInFolderTree = this._showFilesInFolderTree();
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (!element) {
      if (!folders.length) {
        return [];
      }
      if (this._useFolderTreeMemento(showFilesInFolderTree)) {
        const snap = this._loadSnapshot();
        if (snap && rootsMatchSnapshot(folders, snap)) {
          const allKnown = folders.every((wf) =>
            Object.prototype.hasOwnProperty.call(snap.nodes, cacheKey(wf.uri))
          );
          if (allKnown) {
            for (const wf of folders) {
              const pk = cacheKey(wf.uri);
              const dirs = snap.nodes[pk];
              this._dirListCache.set(
                pk,
                dirs.map((d) => [d.n, vscode.FileType.Directory] as [string, vscode.FileType])
              );
            }
            const items = folders.map((wf) => {
              const dirs = snap.nodes[cacheKey(wf.uri)];
              return new FolderTreeItem(
                wf.uri,
                wf.name,
                collapsibleIfExpandable(dirs.length > 0),
                false,
                true
              );
            });
            void this._revalidateRoots(folders);
            this._registerItems(items);
            return items;
          }
        }
      }
      const rootItems = await Promise.all(
        folders.map(async (wf) => {
          const pk = cacheKey(wf.uri);
          const items = await this._buildChildItems(wf.uri);
          const entries = this._dirListCache.get(pk) ?? [];
          if (!showFilesInFolderTree) {
            this._queueNodePersist(
              pk,
              items.filter((i) => !i.isFileEntry)
            );
          }
          return new FolderTreeItem(
            wf.uri,
            wf.name,
            collapsibleIfExpandable(this._rootHasVisibleChildren(entries, showFilesInFolderTree)),
            false,
            true
          );
        })
      );
      this._registerItems(rootItems);
      return rootItems;
    }

    if (this._useFolderTreeMemento(showFilesInFolderTree)) {
      const snap = this._loadSnapshot();
      if (snap && folders.length > 0 && rootsMatchSnapshot(folders, snap)) {
        const fromMem = this._tryChildrenFromMemento(element.uri, snap);
        if (fromMem) {
          void this._revalidateNode(element);
          this._registerItems(fromMem);
          return fromMem;
        }
      }
    }

    const items = await this._buildChildItems(element.uri);
    if (!showFilesInFolderTree) {
      this._queueNodePersist(
        cacheKey(element.uri),
        items.filter((i) => !i.isFileEntry)
      );
    }
    this._registerItems(items);
    return items;
  }

  getParent(element: FolderTreeItem): FolderTreeItem | undefined {
    const wf = vscode.workspace.getWorkspaceFolder(element.uri);
    if (!wf) {
      return undefined;
    }
    if (element.uri.fsPath === wf.uri.fsPath) {
      return undefined;
    }
    const parentUri = vscode.Uri.joinPath(element.uri, "..");
    const atWorkspaceRoot = parentUri.fsPath === wf.uri.fsPath;
    const name = atWorkspaceRoot
      ? wf.name
      : parentUri.fsPath.split(/[/\\]/).filter(Boolean).pop() ?? parentUri.fsPath;
    const isWorkspaceRootRow =
      path.normalize(parentUri.fsPath) === path.normalize(wf.uri.fsPath);
    /* The parent of `element` always contains at least `element` → always expandable (no `readDirectory`). */
    return new FolderTreeItem(
      parentUri,
      name,
      vscode.TreeItemCollapsibleState.Collapsed,
      false,
      isWorkspaceRootRow
    );
  }
}
