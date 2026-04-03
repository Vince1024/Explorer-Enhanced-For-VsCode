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

/** Webview row slice for `FileViewRowPayload.git.incoming`. */
export function gitIncomingToRowPayload(m: FileGitStatusModel): { letter: string; kind: FileGitStatusKind } {
  return { letter: m.letter, kind: m.kind };
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
  git?: {
    primary: { letter: string; kind: FileGitStatusKind };
    secondary?: { letter: string; kind: FileGitStatusKind };
    /** Upstream side of `git diff HEAD...@{upstream}` — Explorer shows as ↓ + letter (e.g. ↓M). */
    incoming?: { letter: string; kind: FileGitStatusKind };
  };
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

/** `vscode.Uri.isUri` is newer than our `engines.vscode`; duck-type Git `Change.uri` from the API. */
function isFileUriFromGitApi(u: unknown): u is vscode.Uri {
  if (!u || typeof u !== "object") {
    return false;
  }
  const o = u as { scheme?: unknown; fsPath?: unknown };
  return o.scheme === "file" && typeof o.fsPath === "string";
}

interface GitRepositoryState {
  readonly mergeChanges: readonly GitChange[];
  readonly indexChanges: readonly GitChange[];
  readonly workingTreeChanges: readonly GitChange[];
  readonly untrackedChanges: readonly GitChange[];
  readonly onDidChange: vscode.Event<void>;
  /** Present on the real `vscode.git` repository; used for upstream / incoming file set. */
  readonly HEAD?: {
    readonly upstream?: { readonly remote: string; readonly name: string };
    readonly behind?: number;
  };
}

/**
 * `diffBetween(ref1, ref2)` without `path` returns parsed `Change[]` at runtime (`git diff --name-status`), though
 * `git.d.ts` types it as `Promise<string>`.
 */
type GitRepositoryWithDiff = GitRepository & {
  diffBetween(ref1: string, ref2: string, path?: string): Promise<unknown>;
  diffBetweenPatch?(ref1: string, ref2: string, path?: string): Promise<string>;
};

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
 * Stable key for Git path maps: under Windows, `vscode.git` paths and `Uri.fsPath` can differ by **case**, which
 * caused most `Map.get` lookups to miss in the Files view while the built-in Explorer stayed correct.
 */
function gitPathLookupKey(fsPath: string): string {
  const n = path.normalize(fsPath);
  return process.platform === "win32" ? n.toLowerCase() : n;
}

/**
 * Key for Maps that cache per open repository. `GitAPI.getRepository(uri)` is not guaranteed to return the **same
 * object reference** as entries in `api.repositories`, so using `Map<GitRepository, …>` breaks lookups (incoming map
 * appeared empty in Files while `diffBetween` had run on the hooked instance).
 */
function gitRepoRootLookupKey(repo: { rootUri: vscode.Uri }): string {
  return gitPathLookupKey(repo.rootUri.fsPath);
}

function pathsEqualFile(aFs: string, bFs: string): boolean {
  const na = path.normalize(aFs);
  const nb = path.normalize(bFs);
  if (process.platform === "win32") {
    return na.toLowerCase() === nb.toLowerCase();
  }
  return na === nb;
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
  const rootNorm = path.normalize(rootFs);
  let cur = path.normalize(startFs);
  while (true) {
    onSegment(cur);
    if (pathsEqualFile(cur, rootNorm)) {
      break;
    }
    const parent = path.dirname(cur);
    if (pathsEqualFile(parent, cur)) {
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
  const changedFileKeys = new Set<string>();
  /** Single ordering for fill + folder roll-up (merge → index → working → untracked). */
  const scmBuckets: readonly { map: Map<string, GitChange>; changes: readonly GitChange[] }[] = [
    { map: mergeByPath, changes: repo.state.mergeChanges },
    { map: indexByPath, changes: repo.state.indexChanges },
    { map: workingByPath, changes: repo.state.workingTreeChanges },
    { map: untrackedByPath, changes: repo.state.untrackedChanges },
  ];
  const addTo = (m: Map<string, GitChange>, changes: readonly GitChange[]): void => {
    for (const c of changes) {
      const k = gitPathLookupKey(c.uri.fsPath);
      changedFileKeys.add(k);
      // Keep the first entry for that path (stable if Git extension emits duplicates).
      if (!m.has(k)) {
        m.set(k, c);
      }
    }
  };
  for (const { map, changes } of scmBuckets) {
    addTo(map, changes);
  }

  const folderRollupByPath = new Map<string, GitChange>();
  const rootFs = repo.rootUri.fsPath;
  for (const { changes } of scmBuckets) {
    for (const c of changes) {
      const pr = gitStatusPriority(c.status);
      const pNorm = path.normalize(c.uri.fsPath);
      forEachAncestorPathToRoot(pNorm, rootFs, (ancestorNorm) => {
        const ancestorKey = gitPathLookupKey(ancestorNorm);
        const prev = folderRollupByPath.get(ancestorKey);
        const prevPr = prev ? gitStatusPriority(prev.status) : -1;
        if (!prev || pr > prevPr) {
          folderRollupByPath.set(ancestorKey, c);
        }
      });
    }
  }

  return { mergeByPath, indexByPath, workingByPath, untrackedByPath, changedFileKeys, folderRollupByPath };
}

/** Repo-relative paths from unified diff (`diffBetweenPatch` / `git diff`), for fallback when `diffBetween` yields no usable rows. */
function parseRepoRelativePathsFromDiffPatch(patch: string): string[] {
  const out: string[] = [];
  for (const line of patch.split(/\r?\n/)) {
    if (!line.startsWith("diff --git ")) {
      continue;
    }
    const rest = line.slice("diff --git ".length);
    const tab = rest.indexOf("\t");
    const segment = tab >= 0 ? rest.slice(0, tab) : rest;
    const bIdx = segment.lastIndexOf(" b/");
    if (bIdx === -1) {
      continue;
    }
    let bPath = segment.slice(bIdx + 3).trim();
    if ((bPath.startsWith('"') && bPath.endsWith('"')) || (bPath.startsWith("'") && bPath.endsWith("'"))) {
      bPath = bPath.slice(1, -1);
    }
    if (bPath.length > 0) {
      out.push(bPath.replace(/\//g, path.sep));
    }
  }
  return out;
}

const INCOMING_PATHS_DEBOUNCE_MS = 280;

/** When only `diffBetweenPatch` text is available (no per-file `Change[]` status). */
const INCOMING_PATCH_FALLBACK_MODEL: FileGitStatusModel = { letter: "M", kind: "modified" };

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
  /** Per repo root: path key → upstream/incoming badge (see {@link gitRepoRootLookupKey}). */
  private readonly _incomingModelByPathKeyByRepo = new Map<string, ReadonlyMap<string, FileGitStatusModel>>();
  private readonly _incomingTimersByRepo = new Map<GitRepository, ReturnType<typeof setTimeout>>();
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
    for (const t of this._incomingTimersByRepo.values()) {
      clearTimeout(t);
    }
    this._incomingTimersByRepo.clear();
    this._incomingModelByPathKeyByRepo.clear();
    this._emitter.dispose();
  }

  /**
   * Upstream-side status for `fileUri` in `git diff HEAD...@{upstream}` (parsed `Change[]` from `diffBetween`).
   * Letter + kind match Explorer “incoming” badges (e.g. ↓M).
   */
  getUpstreamIncomingModel(fileUri: vscode.Uri): FileGitStatusModel | undefined {
    if (fileUri.scheme !== "file" || !this._api || this._api.state !== "initialized") {
      return undefined;
    }
    const repo = this._api.getRepository(fileUri);
    if (!repo) {
      return undefined;
    }
    const m = this._incomingModelByPathKeyByRepo.get(gitRepoRootLookupKey(repo));
    if (!m || m.size === 0) {
      return undefined;
    }
    return m.get(gitPathLookupKey(fileUri.fsPath));
  }

  /**
   * Whether current SCM state could change Git badges for the folder `folderUri` (listed files or subfolders).
   * When no changed paths exist in any repo, returns `true` so the UI can clear badges.
   */
  gitChangesMayAffectFolder(folderUri: vscode.Uri): boolean {
    if (folderUri.scheme !== "file" || !this._api || this._api.state !== "initialized") {
      return true;
    }
    const fNorm = path.normalize(folderUri.fsPath);
    const sep = path.sep;
    const prefixNonWin = fNorm + sep;
    const prefixWin = process.platform === "win32" ? fNorm.toLowerCase() + sep : undefined;
    let sawAnyPath = false;
    const considerPathKey = (pNorm: string): boolean => {
      sawAnyPath = true;
      const dir = path.dirname(pNorm);
      if (pathsEqualFile(dir, fNorm) || pathsEqualFile(pNorm, fNorm)) {
        return true;
      }
      if (prefixWin !== undefined) {
        return pNorm.toLowerCase().startsWith(prefixWin);
      }
      return pNorm.startsWith(prefixNonWin);
    };

    for (const repo of this._api.repositories) {
      let idx = this._repoIndex.get(repo);
      if (!idx) {
        idx = buildRepoGitIndex(repo);
        this._repoIndex.set(repo, idx);
      }
      // Any file-level SCM decoration under this folder could change the visible badges.
      for (const pNorm of idx.changedFileKeys) {
        if (considerPathKey(pNorm)) {
          return true;
        }
      }
      // Incoming-only files (no local index/working change) still need a Files refresh when the upstream set arrives.
      const incoming = this._incomingModelByPathKeyByRepo.get(gitRepoRootLookupKey(repo));
      if (incoming) {
        for (const pNorm of incoming.keys()) {
          if (considerPathKey(pNorm)) {
            return true;
          }
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
    const key = gitPathLookupKey(fileUri.fsPath);
    const isDirectory = entryKind === "folder";
    if (isDirectory) {
      const rolled = idx.folderRollupByPath.get(key);
      return rolled ? gitStatusToModel(rolled.status) : undefined;
    }

    // File-level: match Explorer behavior — merge/conflict dominates, then working tree, then staged/index.
    const merge = idx.mergeByPath.get(key);
    if (merge) {
      const m = gitStatusToModel(merge.status);
      return m ? { primary: m } : undefined;
    }
    const work = idx.workingByPath.get(key) ?? idx.untrackedByPath.get(key);
    const staged = idx.indexByPath.get(key);
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

  private _scheduleIncomingPathsRefresh(repo: GitRepository): void {
    const prev = this._incomingTimersByRepo.get(repo);
    if (prev !== undefined) {
      clearTimeout(prev);
    }
    const t = setTimeout(() => {
      this._incomingTimersByRepo.delete(repo);
      void this._refreshIncomingPathsForRepo(repo);
    }, INCOMING_PATHS_DEBOUNCE_MS);
    this._incomingTimersByRepo.set(repo, t);
  }

  private _setIncomingModelsForRepo(repo: GitRepository, map: Map<string, FileGitStatusModel>): void {
    this._incomingModelByPathKeyByRepo.set(gitRepoRootLookupKey(repo), map);
  }

  private async _refreshIncomingPathsForRepo(repo: GitRepository): Promise<void> {
    const r = repo as unknown as GitRepositoryWithDiff;
    const head = r.state.HEAD;
    if (!head?.upstream) {
      this._setIncomingModelsForRepo(repo, new Map());
      this._bump();
      return;
    }
    const upRef = `${head.upstream.remote}/${head.upstream.name}`;
    const rootFs = path.normalize(r.rootUri.fsPath);
    try {
      const byKey = await this._buildIncomingModelMap(r, rootFs, upRef);
      this._setIncomingModelsForRepo(repo, byKey);
    } catch {
      this._setIncomingModelsForRepo(repo, new Map());
    }
    this._bump();
  }

  /**
   * Prefer `diffBetween` → `Change[]` (letter per status). If that yields nothing (wrong type, skipped URIs, API quirks),
   * fall back to `diffBetweenPatch` + `diff --git` path list with a generic incoming-modified badge.
   */
  private async _buildIncomingModelMap(
    r: GitRepositoryWithDiff,
    rootFs: string,
    upRef: string
  ): Promise<Map<string, FileGitStatusModel>> {
    const byKey = new Map<string, FileGitStatusModel>();
    let raw: unknown;
    try {
      raw = await r.diffBetween("HEAD", upRef);
    } catch {
      raw = undefined;
    }
    if (Array.isArray(raw)) {
      for (const item of raw) {
        const ch = item as GitChange;
        if (!isFileUriFromGitApi(ch?.uri)) {
          continue;
        }
        const model = gitStatusToModel(ch.status);
        if (!model) {
          continue;
        }
        byKey.set(gitPathLookupKey(ch.uri.fsPath), model);
      }
    }
    if (byKey.size > 0) {
      return byKey;
    }
    if (typeof r.diffBetweenPatch !== "function") {
      return byKey;
    }
    try {
      const patch = await r.diffBetweenPatch("HEAD", upRef);
      if (typeof patch !== "string" || patch.length === 0) {
        return byKey;
      }
      for (const rel of parseRepoRelativePathsFromDiffPatch(patch)) {
        byKey.set(gitPathLookupKey(path.join(rootFs, rel)), INCOMING_PATCH_FALLBACK_MODEL);
      }
    } catch {
      /* empty */
    }
    return byKey;
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
    this._scheduleIncomingPathsRefresh(repo);
    const sub = repo.state.onDidChange(() => {
      this._repoIndex.set(repo, buildRepoGitIndex(repo));
      this._scheduleIncomingPathsRefresh(repo);
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
    const incT = this._incomingTimersByRepo.get(repo);
    if (incT !== undefined) {
      clearTimeout(incT);
      this._incomingTimersByRepo.delete(repo);
    }
    this._incomingModelByPathKeyByRepo.delete(gitRepoRootLookupKey(repo));
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
