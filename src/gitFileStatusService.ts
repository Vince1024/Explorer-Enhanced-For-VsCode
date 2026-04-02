import * as path from "path";
import * as vscode from "vscode";

/**
 * Stable view-model for any UI (Files webview, future views). Maps from built-in Git extension statuses.
 * @see https://github.com/microsoft/vscode/blob/main/extensions/git/src/api/git.d.ts
 */
export type FileGitStatusKind =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "copied"
  | "untracked"
  | "ignored"
  | "conflict";

export interface FileGitStatusModel {
  /** Single-letter badge (Explorer-style). */
  readonly letter: string;
  readonly kind: FileGitStatusKind;
}

export interface FileGitStatusPairModel {
  /** Working tree / merge (file-level) status (Explorer left badge). */
  readonly primary: FileGitStatusModel;
  /** Index (staged) status (Explorer right badge). */
  readonly secondary?: FileGitStatusModel;
}

/** Serializable file row for file-list webviews (shared contract for Files and future views). */
export interface FileViewRowPayload {
  name: string;
  path: string;
  mtime: number;
  size: number;
  /** Omitted or `"file"` for files; `"folder"` when subfolders are listed in Files. */
  kind?: "file" | "folder";
  /** Folder size is still being computed (Display folder size option). */
  folderSizePending?: boolean;
  /**
   * Git decorations for this row.
   * Files can have both working-tree and index decorations; folders use roll-up (single badge) to avoid clutter.
   */
  git?: { primary: { letter: string; kind: FileGitStatusKind }; secondary?: { letter: string; kind: FileGitStatusKind } };
  /** From {@link vscode.languages.getDiagnostics} when Problems column is enabled (files only). */
  problems?: { errors: number; warnings: number; infos: number };
}

/** Numeric values must match `Status` in vscode.git `git.d.ts` (order from 0). */
const enum GitStatus {
  INDEX_MODIFIED,
  INDEX_ADDED,
  INDEX_DELETED,
  INDEX_RENAMED,
  INDEX_COPIED,
  MODIFIED,
  DELETED,
  UNTRACKED,
  IGNORED,
  INTENT_TO_ADD,
  INTENT_TO_RENAME,
  TYPE_CHANGED,
  ADDED_BY_US,
  ADDED_BY_THEM,
  DELETED_BY_US,
  DELETED_BY_THEM,
  BOTH_ADDED,
  BOTH_DELETED,
  BOTH_MODIFIED,
}

function gitStatusToModel(status: number): FileGitStatusModel | undefined {
  switch (status) {
    case GitStatus.INDEX_MODIFIED:
    case GitStatus.MODIFIED:
    case GitStatus.TYPE_CHANGED:
      return { letter: "M", kind: "modified" };
    case GitStatus.INDEX_ADDED:
    case GitStatus.INTENT_TO_ADD:
      return { letter: "A", kind: "added" };
    case GitStatus.INDEX_DELETED:
    case GitStatus.DELETED:
    case GitStatus.DELETED_BY_US:
    case GitStatus.DELETED_BY_THEM:
    case GitStatus.BOTH_DELETED:
      return { letter: "D", kind: "deleted" };
    case GitStatus.INDEX_RENAMED:
    case GitStatus.INTENT_TO_RENAME:
      return { letter: "R", kind: "renamed" };
    case GitStatus.INDEX_COPIED:
      return { letter: "C", kind: "copied" };
    case GitStatus.UNTRACKED:
      return { letter: "U", kind: "untracked" };
    case GitStatus.IGNORED:
      return { letter: "—", kind: "ignored" };
    case GitStatus.ADDED_BY_US:
    case GitStatus.ADDED_BY_THEM:
    case GitStatus.BOTH_ADDED:
    case GitStatus.BOTH_MODIFIED:
      return { letter: "!", kind: "conflict" };
    default:
      return undefined;
  }
}

/** Minimal typings for `vscode.git` exports (avoid runtime dependency on git’s types). */
interface GitChange {
  readonly uri: vscode.Uri;
  readonly status: number;
}

interface GitRepositoryState {
  readonly mergeChanges: readonly GitChange[];
  readonly indexChanges: readonly GitChange[];
  readonly workingTreeChanges: readonly GitChange[];
  readonly untrackedChanges: readonly GitChange[];
  readonly onDidChange: vscode.Event<void>;
}

interface GitRepository {
  readonly rootUri: vscode.Uri;
  readonly state: GitRepositoryState;
}

type APIState = "uninitialized" | "initialized";

interface GitAPI {
  readonly state: APIState;
  readonly onDidChangeState: vscode.Event<void>;
  readonly repositories: readonly GitRepository[];
  readonly onDidOpenRepository: vscode.Event<GitRepository>;
  readonly onDidCloseRepository: vscode.Event<GitRepository>;
  getRepository(uri: vscode.Uri): GitRepository | null | undefined;
}

interface GitExtensionExports {
  getAPI(version: 1): GitAPI;
}

/** Coalesce bursty git state signals into one UI refresh. */
const GIT_BUMP_DEBOUNCE_MS = 90;

/**
 * Canonical key for matching Git SCM paths to `Uri.fsPath` from the workspace.
 * Multi-root / Cursor sometimes surfaces `%20` in `fsPath` while `vscode.git` uses decoded spaces — strict
 * `path.normalize` alone makes Map lookups miss (one file shows M in native Explorer, none in Files).
 */
function gitPathLookupKey(fsPath: string): string {
  const decoded = fsPath.replace(/%20/gi, " ");
  const n = path.normalize(decoded);
  return process.platform === "win32" ? n.toLowerCase() : n;
}

/** Priority for folder roll-up: when several changes apply under one folder, the highest value wins. */
function gitStatusPriority(status: number): number {
  switch (status) {
    case GitStatus.ADDED_BY_US:
    case GitStatus.ADDED_BY_THEM:
    case GitStatus.BOTH_ADDED:
    case GitStatus.BOTH_MODIFIED:
      return 100;
    case GitStatus.INDEX_DELETED:
    case GitStatus.DELETED:
    case GitStatus.DELETED_BY_US:
    case GitStatus.DELETED_BY_THEM:
    case GitStatus.BOTH_DELETED:
      return 90;
    case GitStatus.INDEX_MODIFIED:
    case GitStatus.MODIFIED:
    case GitStatus.TYPE_CHANGED:
      return 70;
    case GitStatus.INDEX_RENAMED:
    case GitStatus.INTENT_TO_RENAME:
      return 65;
    case GitStatus.INDEX_COPIED:
      return 60;
    case GitStatus.INDEX_ADDED:
    case GitStatus.INTENT_TO_ADD:
      return 50;
    case GitStatus.UNTRACKED:
      return 40;
    case GitStatus.IGNORED:
      return 10;
    default:
      return 0;
  }
}

/**
 * Walk from `startFs` up to `rootFs` (inclusive): invokes `onSegment` for the start path, then each parent directory.
 * Used to propagate folder roll-up to every ancestor of a changed path.
 */
function forEachAncestorPathToRoot(startFs: string, rootFs: string, onSegment: (segmentNorm: string) => void): void {
  const rootNorm = gitPathLookupKey(rootFs);
  let cur = gitPathLookupKey(startFs);
  while (true) {
    onSegment(cur);
    if (cur === rootNorm) {
      break;
    }
    const parent = gitPathLookupKey(path.dirname(cur));
    if (parent === cur) {
      break;
    }
    cur = parent;
  }
}

interface RepoGitIndex {
  /** Per-path SCM buckets for file-level decorations (Explorer shows working + index). */
  readonly mergeByPath: ReadonlyMap<string, GitChange>;
  readonly indexByPath: ReadonlyMap<string, GitChange>;
  readonly workingByPath: ReadonlyMap<string, GitChange>;
  readonly untrackedByPath: ReadonlyMap<string, GitChange>;
  /** Deduplicated normalized file paths with any SCM decoration (avoids rebuilding a Set on each folder check). */
  readonly changedFileKeys: ReadonlySet<string>;
  /** Per directory path: best change among all repo changes at or below that path (Explorer-style folder roll-up). */
  readonly folderRollupByPath: ReadonlyMap<string, GitChange>;
}

/** Snapshot of Git SCM lists into maps; rebuilt whenever that repository’s state changes. */
function buildRepoGitIndex(repo: GitRepository): RepoGitIndex {
  const mergeByPath = new Map<string, GitChange>();
  const indexByPath = new Map<string, GitChange>();
  const workingByPath = new Map<string, GitChange>();
  const untrackedByPath = new Map<string, GitChange>();
  const addTo = (m: Map<string, GitChange>, changes: readonly GitChange[]): void => {
    for (const c of changes) {
      const k = gitPathLookupKey(c.uri.fsPath);
      // Keep the first entry for that path (stable if Git extension emits duplicates).
      if (!m.has(k)) {
        m.set(k, c);
      }
    }
  };
  addTo(mergeByPath, repo.state.mergeChanges);
  addTo(indexByPath, repo.state.indexChanges);
  addTo(workingByPath, repo.state.workingTreeChanges);
  addTo(untrackedByPath, repo.state.untrackedChanges);

  const folderRollupByPath = new Map<string, GitChange>();
  const rootFs = repo.rootUri.fsPath;
  const buckets: readonly (readonly GitChange[])[] = [
    repo.state.mergeChanges,
    repo.state.indexChanges,
    repo.state.workingTreeChanges,
    repo.state.untrackedChanges,
  ];
  for (const changes of buckets) {
    for (const c of changes) {
      const pr = gitStatusPriority(c.status);
      const pNorm = gitPathLookupKey(c.uri.fsPath);
      forEachAncestorPathToRoot(pNorm, rootFs, (ancestorNorm) => {
        const prev = folderRollupByPath.get(ancestorNorm);
        if (!prev || pr > gitStatusPriority(prev.status)) {
          folderRollupByPath.set(ancestorNorm, c);
        }
      });
    }
  }

  const changedFileKeys = new Set<string>([
    ...mergeByPath.keys(),
    ...indexByPath.keys(),
    ...workingByPath.keys(),
    ...untrackedByPath.keys(),
  ]);

  return { mergeByPath, indexByPath, workingByPath, untrackedByPath, changedFileKeys, folderRollupByPath };
}

/**
 * Subscribes to the built-in Git extension and exposes {@link getModelForFile} + {@link onDidChange}.
 * Maintains a {@link RepoGitIndex} per open repository so lookups stay O(1) instead of scanning SCM lists.
 */
export class GitFileStatusService implements vscode.Disposable {
  private readonly _emitter = new vscode.EventEmitter<void>();
  /** Fires after debounce when any tracked repository’s SCM state may have changed. */
  readonly onDidChange = this._emitter.event;

  private readonly _disposables: vscode.Disposable[] = [];
  private readonly _repoSubs = new Map<GitRepository, vscode.Disposable>();
  /** Precomputed {@link RepoGitIndex} per repository reference; cleared when the repository closes. */
  private readonly _repoIndex = new Map<GitRepository, RepoGitIndex>();
  private _api: GitAPI | undefined;
  private _wiredApi = false;
  private _bumpTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    void this._tryInit();
  }

  dispose(): void {
    if (this._bumpTimer !== undefined) {
      clearTimeout(this._bumpTimer);
      this._bumpTimer = undefined;
    }
    for (const d of this._disposables) {
      d.dispose();
    }
    this._disposables.length = 0;
    for (const d of this._repoSubs.values()) {
      d.dispose();
    }
    this._repoSubs.clear();
    this._repoIndex.clear();
    this._emitter.dispose();
  }

  /**
   * Whether current SCM state could change Git badges for the folder `folderUri` (listed files or subfolders).
   * When no changed paths exist in any repo, returns `true` so the UI can clear badges.
   */
  gitChangesMayAffectFolder(folderUri: vscode.Uri): boolean {
    if (folderUri.scheme !== "file" || !this._api || this._api.state !== "initialized") {
      return true;
    }
    const F = gitPathLookupKey(folderUri.fsPath);
    const sep = path.sep;
    let sawAnyPath = false;
    for (const repo of this._api.repositories) {
      let idx = this._repoIndex.get(repo);
      if (!idx) {
        idx = buildRepoGitIndex(repo);
        this._repoIndex.set(repo, idx);
      }
      // Any file-level decoration under this folder could change the visible badges.
      for (const pKey of idx.changedFileKeys) {
        sawAnyPath = true;
        const dirKey = gitPathLookupKey(path.dirname(pKey));
        if (pKey === F || dirKey === F || pKey.startsWith(F + sep)) {
          return true;
        }
      }
    }
    if (!sawAnyPath) {
      return true;
    }
    return false;
  }

  /**
   * Returns a badge for a file or folder `fileUri` if it is under a Git repo and SCM reports a non-clean status
   * (aligned with Explorer). Folders use roll-up when there is no direct path entry. Returns `undefined` if Git is
   * unavailable, the path is outside a repo, or the status is not mapped.
   */
  getModelForFile(fileUri: vscode.Uri, entryKind?: "file" | "folder"): FileGitStatusModel | FileGitStatusPairModel | undefined {
    if (fileUri.scheme !== "file" || !this._api || this._api.state !== "initialized") {
      return undefined;
    }
    const repo = this._api.getRepository(fileUri);
    if (!repo) {
      return undefined;
    }
    let idx = this._repoIndex.get(repo);
    if (!idx) {
      idx = buildRepoGitIndex(repo);
      this._repoIndex.set(repo, idx);
    }
    const norm = gitPathLookupKey(fileUri.fsPath);
    const isDirectory = entryKind === "folder";
    if (isDirectory) {
      const rolled = idx.folderRollupByPath.get(norm);
      return rolled ? gitStatusToModel(rolled.status) : undefined;
    }

    // File-level: match Explorer behavior — merge/conflict dominates, then working tree, then staged/index.
    const merge = idx.mergeByPath.get(norm);
    if (merge) {
      const m = gitStatusToModel(merge.status);
      return m ? { primary: m } : undefined;
    }
    const work = idx.workingByPath.get(norm) ?? idx.untrackedByPath.get(norm);
    const staged = idx.indexByPath.get(norm);
    const workModel = work ? gitStatusToModel(work.status) : undefined;
    const stagedModel = staged ? gitStatusToModel(staged.status) : undefined;

    if (workModel && stagedModel) {
      return { primary: workModel, secondary: stagedModel };
    }
    if (workModel) {
      return workModel;
    }
    if (stagedModel) {
      return stagedModel;
    }
    return undefined;
  }

  private _bump(): void {
    if (this._bumpTimer !== undefined) {
      clearTimeout(this._bumpTimer);
    }
    this._bumpTimer = setTimeout(() => {
      this._bumpTimer = undefined;
      this._emitter.fire();
    }, GIT_BUMP_DEBOUNCE_MS);
  }

  private _hookRepository(repo: GitRepository): void {
    if (this._repoSubs.has(repo)) {
      return;
    }
    this._repoIndex.set(repo, buildRepoGitIndex(repo));
    const sub = repo.state.onDidChange(() => {
      this._repoIndex.set(repo, buildRepoGitIndex(repo));
      this._bump();
    });
    this._repoSubs.set(repo, sub);
  }

  private _unhookRepository(repo: GitRepository): void {
    const sub = this._repoSubs.get(repo);
    if (sub) {
      sub.dispose();
      this._repoSubs.delete(repo);
    }
    this._repoIndex.delete(repo);
  }

  private _wireApi(api: GitAPI): void {
    if (this._wiredApi) {
      return;
    }
    this._wiredApi = true;
    this._api = api;
    for (const r of api.repositories) {
      this._hookRepository(r);
    }
    this._disposables.push(
      api.onDidOpenRepository((repo) => {
        this._hookRepository(repo);
        this._bump();
      }),
      api.onDidCloseRepository((repo) => {
        this._unhookRepository(repo);
        this._bump();
      })
    );
  }

  private async _tryInit(): Promise<void> {
    const ext = vscode.extensions.getExtension<GitExtensionExports>("vscode.git");
    if (!ext) {
      return;
    }
    try {
      if (!ext.isActive) {
        await ext.activate();
      }
      const api = ext.exports.getAPI(1);
      const attach = (): void => {
        if (api.state !== "initialized") {
          return;
        }
        this._wireApi(api);
        this._bump();
      };
      if (api.state === "initialized") {
        attach();
      } else {
        this._disposables.push(
          api.onDidChangeState(() => {
            if (api.state === "initialized") {
              attach();
            }
          })
        );
      }
    } catch {
      /* Git disabled or API failure */
    }
  }
}
