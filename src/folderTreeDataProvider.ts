import * as path from "path";
import * as vscode from "vscode";
import { mapPool } from "./asyncPool";
import { isFsDirectory, isFsFile } from "./fileTypeUtils";
import { getShowFilesInFolderTreeFromWorkspaceState } from "./filePaneSettings";

/** Max parallel directory reads (avoids FS / AV thrashing on huge folders). */
const LIST_DIR_CONCURRENCY = 32;

const MEMENTO_KEY = "explorer-enhanced.folderTree.snapshot.v1";
const PERSIST_DEBOUNCE_MS = 800;

function collapsibleIfExpandable(hasExpandableChildren: boolean): vscode.TreeItemCollapsibleState {
  return hasExpandableChildren
    ? vscode.TreeItemCollapsibleState.Collapsed
    : vscode.TreeItemCollapsibleState.None;
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
   * When `true`, a persisted folder-only snapshot may hydrate the first paint after reload (dirs-only tree).
   * Set to `false` by {@link refresh} or when disk listing diverges from the snapshot; goes back to `true` only in a new window (new host).
   */
  private _trustMemento = true;

  private _persistTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly _pendingNodeUpdates = new Map<string, PersistedSubdir[]>();

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
    if (this._pendingNodeUpdates.size > 0) {
      this._runPersist();
    }
  }

  refresh(): void {
    this._dirListCache.clear();
    this._trustMemento = false;
    this._pendingNodeUpdates.clear();
    if (this._persistTimer !== undefined) {
      clearTimeout(this._persistTimer);
      this._persistTimer = undefined;
    }
    this._onDidChange.fire();
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

  /** Subfolders, or files when {@link explorer-enhanced.folders.showFilesInTree} is on — drives chevrons and expansion. */
  private async directoryHasVisibleChildren(
    uri: vscode.Uri,
    showFilesInFolderTree = this._showFilesInFolderTree()
  ): Promise<boolean> {
    const entries = await this.listDirectory(uri);
    if (entries.some(([, t]) => isFsDirectory(t))) {
      return true;
    }
    return showFilesInFolderTree && entries.some(([, t]) => isFsFile(t));
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
    const dirs = await mapPool(dirEntries, LIST_DIR_CONCURRENCY, async ([name]) => {
      const childUri = vscode.Uri.joinPath(parentUri, name);
      const hasKids = await this.directoryHasVisibleChildren(childUri, showFiles);
      return new FolderTreeItem(childUri, name, collapsibleIfExpandable(hasKids), false);
    });
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
    const items = dirs.map(
      (d) =>
        new FolderTreeItem(
          vscode.Uri.joinPath(parentUri, d.n),
          d.n,
          collapsibleIfExpandable(d.sub)
        )
    );
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
  async getTreeItemForFolderUri(folderUri: vscode.Uri): Promise<FolderTreeItem | undefined> {
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
    const hasKids = await this.directoryHasVisibleChildren(folderUri);
    const state = collapsibleIfExpandable(hasKids);
    if (targetNorm === rootNorm) {
      return new FolderTreeItem(wf.uri, wf.name, state, false, true);
    }
    return new FolderTreeItem(vscode.Uri.file(targetNorm), path.basename(targetNorm), state);
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
            return items;
          }
        }
      }
      return Promise.all(
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
    }

    if (this._useFolderTreeMemento(showFilesInFolderTree)) {
      const snap = this._loadSnapshot();
      if (snap && folders.length > 0 && rootsMatchSnapshot(folders, snap)) {
        const fromMem = this._tryChildrenFromMemento(element.uri, snap);
        if (fromMem) {
          void this._revalidateNode(element);
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
    return items;
  }

  async getParent(element: FolderTreeItem): Promise<FolderTreeItem | undefined> {
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
    const hasKids = await this.directoryHasVisibleChildren(parentUri);
    const isWorkspaceRootRow =
      path.normalize(parentUri.fsPath) === path.normalize(wf.uri.fsPath);
    return new FolderTreeItem(parentUri, name, collapsibleIfExpandable(hasKids), false, isWorkspaceRootRow);
  }
}
