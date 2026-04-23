import * as path from "path";
import * as vscode from "vscode";
import { getActiveWorkspaceFileUri } from "./activeFileUri";
import * as actions from "./explorerContextActions";
import { FilePaneViewProvider } from "./filePaneViewProvider";
import {
  FILES_PANE_VIEW_LAYOUT_STATE_KEY,
  getSelectActiveFileFromWorkspaceState,
  setShowFilesInFolderTree,
  setShowFoldersInFilesList,
  syncShowFilesInTreeContext,
  getShowFilesInFolderTreeFromWorkspaceState,
} from "./filePaneSettings";
import { isFsDirectory, isFsFile } from "./fileTypeUtils";
import {
  createFolderTreeDragAndDropController,
  moveWorkspaceRootRelative,
} from "./folderTreeDragAndDropController";
import { registerFoldersTreeExpandModeSync } from "./folderTreeExpandMode";
import { FolderTreeDataProvider, FolderTreeItem } from "./folderTreeDataProvider";
import { GitFileStatusService } from "./gitFileStatusService";

function uriInWorkspace(uri: vscode.Uri): boolean {
  return uri.scheme === "file" && vscode.workspace.getWorkspaceFolder(uri) !== undefined;
}

/** One coalesced FS signal for debounced bump (Folders tree vs Files pane). */
type FsBumpOp =
  | { kind: "create"; uri: vscode.Uri }
  | { kind: "delete" }
  | { kind: "rename"; newUri: vscode.Uri };

async function classifyCreateUrisForTreeBump(
  uris: readonly vscode.Uri[],
  workspaceState: vscode.Memento
): Promise<"both" | "filesOnly"> {
  if (uris.length === 0) {
    return "both";
  }
  if (getShowFilesInFolderTreeFromWorkspaceState(workspaceState)) {
    return "both";
  }
  for (const u of uris) {
    try {
      const st = await vscode.workspace.fs.stat(u);
      if (isFsDirectory(st.type)) {
        return "both";
      }
    } catch {
      return "both";
    }
  }
  return "filesOnly";
}

async function classifyRenameNewUrisForTreeBump(
  newUris: readonly vscode.Uri[],
  workspaceState: vscode.Memento
): Promise<"both" | "filesOnly"> {
  if (newUris.length === 0) {
    return "both";
  }
  if (getShowFilesInFolderTreeFromWorkspaceState(workspaceState)) {
    return "both";
  }
  for (const u of newUris) {
    try {
      const st = await vscode.workspace.fs.stat(u);
      if (isFsDirectory(st.type)) {
        return "both";
      }
    } catch {
      return "both";
    }
  }
  return "filesOnly";
}

async function flushFsBumpQueue(
  ops: FsBumpOp[],
  workspaceState: vscode.Memento,
  bumpAfterFsChange: (scope: "both" | "filesOnly") => void
): Promise<void> {
  if (ops.length === 0) {
    return;
  }
  if (ops.some((o) => o.kind === "delete")) {
    bumpAfterFsChange("both");
    return;
  }
  const creates = ops.filter((o): o is { kind: "create"; uri: vscode.Uri } => o.kind === "create");
  const renames = ops.filter((o): o is { kind: "rename"; newUri: vscode.Uri } => o.kind === "rename");
  if (creates.length > 0 && renames.length > 0) {
    bumpAfterFsChange("both");
    return;
  }
  if (renames.length > 0) {
    bumpAfterFsChange(await classifyRenameNewUrisForTreeBump(renames.map((r) => r.newUri), workspaceState));
    return;
  }
  if (creates.length > 0) {
    bumpAfterFsChange(await classifyCreateUrisForTreeBump(creates.map((c) => c.uri), workspaceState));
    return;
  }
  bumpAfterFsChange("both");
}

/**
 * After activation, indexers, Git, and AV often emit many workspace FS events. Without coalescing,
 * repeated debounced refreshes can make the Folders tree thrash. For `STARTUP_FS_COALESCE_MS`, bumps are
 * folded into one refresh at the end of that window; afterward only `FS_BUMP_DEBOUNCE_MS` applies.
 * When the Folders tree is dirs-only and new paths are files, coalesced bumps may refresh Files only
 * (`filesOnly`) and skip `folderData.refresh()`; deletes, renames that touch folders, or “files in tree”
 * still use a full tree refresh (`both`).
 */
const STARTUP_FS_COALESCE_MS = 2800;
const FS_BUMP_DEBOUNCE_MS = 200;
/** Reduces bursts of `stat` + `reveal` when switching tabs quickly (editor ↔ tree sync). */
const SYNC_FOLDER_TREE_DEBOUNCE_MS = 60;

export function activate(context: vscode.ExtensionContext): void {
  const startupPhaseEndsAt = Date.now() + STARTUP_FS_COALESCE_MS;
  const folderData = new FolderTreeDataProvider(context.workspaceState);
  const gitFileStatus = new GitFileStatusService();
  context.subscriptions.push(gitFileStatus, new vscode.Disposable(() => folderData.dispose()));

  registerFoldersTreeExpandModeSync(context);

  void syncShowFilesInTreeContext(context.workspaceState);

  /** Filled after {@link syncFolderTreeToActiveEditor} is defined; used when the Files menu toggles “Select Active File”. */
  let notifySelectActiveFilePolicyChanged: () => void = () => {};

  const filePaneHost: { current?: FilePaneViewProvider } = {};
  const bumpAfterFsChange = (scope: "both" | "filesOnly" = "both"): void => {
    if (scope === "both") {
      folderData.refresh();
    }
    const p = filePaneHost.current;
    if (p) {
      void p.showFolder(p.getLastFolderUri());
    }
  };

  const treeView = vscode.window.createTreeView("explorer-enhanced.folderTree", {
    treeDataProvider: folderData,
    showCollapseAll: true,
    dragAndDropController: createFolderTreeDragAndDropController(),
  });

  const syncExplorerEnhancedFolderContexts = (): void => {
    const n = vscode.workspace.workspaceFolders?.length ?? 0;
    void vscode.commands.executeCommand("setContext", "explorer-enhanced.multiRootWorkspace", n > 1);
  };

  syncExplorerEnhancedFolderContexts();

  const navigateFilesToFolder = async (folderUri: vscode.Uri): Promise<void> => {
    const p = filePaneHost.current;
    if (!p) {
      return;
    }
    const item = await folderData.getTreeItemForFolderUri(folderUri);
    if (item) {
      try {
        await treeView.reveal(item, { select: true, focus: false, expand: true });
      } catch {
        /* reveal can fail (outside the tree); showFolder below still refreshes the Files pane */
      }
    }
    /* Always align the Files pane on this folder: do not rely solely on onDidChangeSelection
       (missing or delayed after reveal → stale path / listing). After reveal, no showFolder
       before to avoid a webview re-render in the middle of a double-click. */
    void p.showFolder(folderUri, true);
  };

  filePaneHost.current = new FilePaneViewProvider(
    context,
    bumpAfterFsChange,
    gitFileStatus,
    navigateFilesToFolder,
    () => notifySelectActiveFilePolicyChanged()
  );
  const filePane = filePaneHost.current;

  const updateFolderTreeChrome = (): void => {
    const has = (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
    treeView.message = has ? undefined : "Open a folder or add workspace folders to browse.";
    /** Section header: workspace name (single-folder basename or multi-root .code-workspace stem), not the static package.json label. */
    treeView.title = vscode.workspace.name ?? "Folders";
  };
  updateFolderTreeChrome();

  /** Keep Folders in sync with disk like Files (webview + workspace file events). */
  let fsBumpDebounceTimer: ReturnType<typeof setTimeout> | undefined;
  let startupCoalesceTimer: ReturnType<typeof setTimeout> | undefined;
  const fsBumpPendingOps: FsBumpOp[] = [];

  const scheduleBumpAfterFsChange = (op: FsBumpOp): void => {
    fsBumpPendingOps.push(op);
    const now = Date.now();
    if (now < startupPhaseEndsAt) {
      if (startupCoalesceTimer === undefined) {
        const delay = Math.max(0, startupPhaseEndsAt - now);
        startupCoalesceTimer = setTimeout(() => {
          startupCoalesceTimer = undefined;
          const batch = fsBumpPendingOps.splice(0, fsBumpPendingOps.length);
          void flushFsBumpQueue(batch, context.workspaceState, bumpAfterFsChange);
        }, delay);
      }
      return;
    }
    if (fsBumpDebounceTimer !== undefined) {
      clearTimeout(fsBumpDebounceTimer);
    }
    fsBumpDebounceTimer = setTimeout(() => {
      fsBumpDebounceTimer = undefined;
      const batch = fsBumpPendingOps.splice(0, fsBumpPendingOps.length);
      void flushFsBumpQueue(batch, context.workspaceState, bumpAfterFsChange);
    }, FS_BUMP_DEBOUNCE_MS);
  };

  const rootRecursiveWatchers: vscode.FileSystemWatcher[] = [];
  const setupRootRecursiveWatchers = (): void => {
    for (const w of rootRecursiveWatchers) {
      w.dispose();
    }
    rootRecursiveWatchers.length = 0;
    for (const wf of vscode.workspace.workspaceFolders ?? []) {
      const pattern = new vscode.RelativePattern(wf, "**/*");
      const w = vscode.workspace.createFileSystemWatcher(pattern, false, true, false);
      w.onDidCreate((uri) => {
        if (uriInWorkspace(uri)) {
          scheduleBumpAfterFsChange({ kind: "create", uri });
        }
      });
      w.onDidDelete((uri) => {
        if (uriInWorkspace(uri)) {
          scheduleBumpAfterFsChange({ kind: "delete" });
        }
      });
      rootRecursiveWatchers.push(w);
    }
  };

  /**
   * First macrotask after `activate` returns: install recursive FS watchers + initial Folders/Files sync.
   * Watchers are deferred so `activate` is lighter; `onDidCreateFiles` / `onDidDeleteFiles` / `onDidRenameFiles`
   * still cover editor-driven changes during the gap. Cleared on dispose if the window shuts down immediately.
   */
  let startupKickoffTimer: ReturnType<typeof setTimeout> | undefined;

  const registerFolderCtx = (
    command: string,
    run: (item: FolderTreeItem) => Promise<void>
  ): vscode.Disposable =>
    vscode.commands.registerCommand(command, async (item: FolderTreeItem | undefined) => {
      if (!item?.uri) {
        return;
      }
      try {
        await run(item);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        void vscode.window.showErrorMessage(msg);
      }
    });

  context.subscriptions.push(
    new vscode.Disposable(() => {
      if (fsBumpDebounceTimer !== undefined) {
        clearTimeout(fsBumpDebounceTimer);
      }
      if (startupCoalesceTimer !== undefined) {
        clearTimeout(startupCoalesceTimer);
      }
      if (startupKickoffTimer !== undefined) {
        clearTimeout(startupKickoffTimer);
        startupKickoffTimer = undefined;
      }
      for (const w of rootRecursiveWatchers) {
        w.dispose();
      }
      rootRecursiveWatchers.length = 0;
    }),
    new vscode.Disposable(() => filePane.dispose()),
    treeView,
    vscode.window.registerWebviewViewProvider(FilePaneViewProvider.viewType, filePane),
    vscode.window.onDidChangeActiveTextEditor(() => {
      filePane.syncFilesPaneKeyboardContextKeys();
    }),
    vscode.commands.registerCommand("explorer-enhanced.filesPane.renameSelection", async () => {
      await filePane.runFilesPaneKeyboardRename();
    }),
    vscode.commands.registerCommand("explorer-enhanced.filesPane.deleteSelection", async () => {
      await filePane.runFilesPaneKeyboardDelete();
    }),
    vscode.workspace.onDidCreateFiles((e) => {
      for (const uri of e.files) {
        if (uriInWorkspace(uri)) {
          scheduleBumpAfterFsChange({ kind: "create", uri });
        }
      }
    }),
    vscode.workspace.onDidDeleteFiles((e) => {
      if (e.files.some(uriInWorkspace)) {
        scheduleBumpAfterFsChange({ kind: "delete" });
      }
    }),
    vscode.workspace.onDidRenameFiles((e) => {
      for (const x of e.files) {
        if (uriInWorkspace(x.oldUri) || uriInWorkspace(x.newUri)) {
          scheduleBumpAfterFsChange({ kind: "rename", newUri: x.newUri });
        }
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      syncExplorerEnhancedFolderContexts();
      folderData.refresh();
      updateFolderTreeChrome();
      setupRootRecursiveWatchers();
      if ((vscode.workspace.workspaceFolders?.length ?? 0) === 0) {
        void filePane.showFolder(undefined);
      }
    }),
    vscode.commands.registerCommand("explorer-enhanced.focus", async () => {
      await vscode.commands.executeCommand("workbench.view.extension.explorer-enhanced");
    }),
    vscode.commands.registerCommand("explorer-enhanced.showFoldersInList", () => {
      void setShowFoldersInFilesList(context.workspaceState, true).then(() => {
        filePane.invalidateFilesListingCache();
        bumpAfterFsChange("filesOnly");
      });
    }),
    vscode.commands.registerCommand("explorer-enhanced.hideFoldersInList", () => {
      void setShowFoldersInFilesList(context.workspaceState, false).then(() => {
        filePane.invalidateFilesListingCache();
        bumpAfterFsChange("filesOnly");
      });
    }),
    vscode.commands.registerCommand("explorer-enhanced.viewLayout.list", () => {
      void context.workspaceState.update(FILES_PANE_VIEW_LAYOUT_STATE_KEY, "list").then(() => {
        bumpAfterFsChange("filesOnly");
      });
    }),
    vscode.commands.registerCommand("explorer-enhanced.viewLayout.detail", () => {
      void context.workspaceState.update(FILES_PANE_VIEW_LAYOUT_STATE_KEY, "detail").then(() => {
        bumpAfterFsChange("filesOnly");
      });
    }),
    vscode.commands.registerCommand("explorer-enhanced.viewLayout.icons", () => {
      void context.workspaceState.update(FILES_PANE_VIEW_LAYOUT_STATE_KEY, "icons").then(() => {
        bumpAfterFsChange("filesOnly");
      });
    }),
    vscode.commands.registerCommand("explorer-enhanced.folders.showFilesInTree", () => {
      void setShowFilesInFolderTree(context.workspaceState, true).then(() =>
        syncShowFilesInTreeContext(context.workspaceState).then(() => {
          folderData.refresh();
          bumpAfterFsChange("filesOnly");
        })
      );
    }),
    vscode.commands.registerCommand("explorer-enhanced.folders.hideFilesInTree", () => {
      void setShowFilesInFolderTree(context.workspaceState, false).then(() =>
        syncShowFilesInTreeContext(context.workspaceState).then(() => {
          folderData.refresh();
          bumpAfterFsChange("filesOnly");
        })
      );
    }),
    registerFolderCtx("explorer-enhanced.ctx.folder.newFile", (item) =>
      actions.newFileInFolder(item.uri, bumpAfterFsChange)
    ),
    registerFolderCtx("explorer-enhanced.ctx.folder.newFolder", (item) =>
      actions.newFolderInFolder(item.uri, bumpAfterFsChange)
    ),
    vscode.commands.registerCommand("explorer-enhanced.ctx.folder.refresh", () => {
      folderData.refresh();
      void filePane.showFolder(filePane.getLastFolderUri(), true);
    }),
    registerFolderCtx("explorer-enhanced.ctx.folder.revealInExplorer", (item) =>
      actions.revealInExplorerView(item.uri)
    ),
    ...(
      [
        "explorer-enhanced.ctx.folder.revealInOs.win",
        "explorer-enhanced.ctx.folder.revealInOs.macos",
        "explorer-enhanced.ctx.folder.revealInOs.linux",
        "explorer-enhanced.ctx.folder.revealInOs.other",
      ] as const
    ).map((cmd) => registerFolderCtx(cmd, (item) => actions.revealInOs(item.uri))),
    registerFolderCtx("explorer-enhanced.ctx.folder.openInTerminal", (item) =>
      actions.openInIntegratedTerminal(item.uri)
    ),
    registerFolderCtx("explorer-enhanced.ctx.folder.copyPath", (item) => actions.copyPath(item.uri)),
    registerFolderCtx("explorer-enhanced.ctx.folder.copyRelativePath", (item) =>
      actions.copyRelativePath(item.uri)
    ),
    registerFolderCtx("explorer-enhanced.ctx.folder.rename", (item) =>
      actions.renameResource(item.uri, bumpAfterFsChange)
    ),
    registerFolderCtx("explorer-enhanced.ctx.folder.delete", (item) =>
      actions.deleteResource(item.uri, bumpAfterFsChange)
    ),
    vscode.commands.registerCommand(
      "explorer-enhanced.ctx.folder.moveWorkspaceRootUp",
      (item: FolderTreeItem | undefined) => {
        const it = item ?? treeView.selection[0];
        if (!it?.uri) {
          return;
        }
        moveWorkspaceRootRelative(it, -1);
      }
    ),
    vscode.commands.registerCommand(
      "explorer-enhanced.ctx.folder.moveWorkspaceRootDown",
      (item: FolderTreeItem | undefined) => {
        const it = item ?? treeView.selection[0];
        if (!it?.uri) {
          return;
        }
        moveWorkspaceRootRelative(it, 1);
      }
    ),
    vscode.commands.registerCommand(
      "explorer-enhanced.ctx.folder.removeFromWorkspace",
      (item: FolderTreeItem | undefined) => {
        const it = item ?? treeView.selection[0];
        if (!it?.uri || it.isFileEntry) {
          return;
        }
        void actions.removeFolderFromWorkspace(it.uri);
      }
    )
  );

  const syncFilesToFolderSelection = (): void => {
    if (filePane.consumeSkipFilesListingSyncOnNextTreeSelection()) {
      return;
    }
    const sel = treeView.selection[0];
    if (sel) {
      const folderUri = sel.isFileEntry ? vscode.Uri.file(path.dirname(sel.uri.fsPath)) : sel.uri;
      void filePane.showFolder(folderUri);
    } else {
      void filePane.showFolder(undefined);
    }
  };

  let syncFolderTreeDebounceTimer: ReturnType<typeof setTimeout> | undefined;

  /** Select + expand the folder that contains the active editor file (reciprocal of Files highlight). */
  const syncFolderTreeToActiveEditor = async (): Promise<void> => {
    /** Never sync when Explorer Enhanced is not the active sidebar activity (`reveal` would show this view). */
    if (!treeView.visible) {
      return;
    }
    if (!getSelectActiveFileFromWorkspaceState(context.workspaceState)) {
      return;
    }
    const docUri = getActiveWorkspaceFileUri();
    if (!docUri) {
      return;
    }
    const showFilesInTree = getShowFilesInFolderTreeFromWorkspaceState(context.workspaceState);

    let docStat: vscode.FileStat | undefined;
    try {
      docStat = await vscode.workspace.fs.stat(docUri);
    } catch {
      docStat = undefined;
    }

    if (showFilesInTree && docStat && isFsFile(docStat.type)) {
      const fileItem = await folderData.getTreeItemForFileUri(docUri);
      if (fileItem) {
        try {
          if (filePane.isContentSearchSessionActive()) {
            filePane.markSkipFilesListingSyncOnNextTreeSelection();
          }
          await treeView.reveal(fileItem, { select: true, focus: false, expand: true });
          return;
        } catch {
          filePane.clearSkipFilesListingSyncMarker();
          /* Tree not ready or node missing — fall back to folder below */
        }
      }
    }

    let folderFs = path.normalize(path.dirname(docUri.fsPath));
    if (docStat && isFsDirectory(docStat.type)) {
      folderFs = path.normalize(docUri.fsPath);
    }
    const folderUri = vscode.Uri.file(folderFs);
    const item = await folderData.getTreeItemForFolderUri(folderUri);
    if (!item) {
      return;
    }
    try {
      if (filePane.isContentSearchSessionActive()) {
        filePane.markSkipFilesListingSyncOnNextTreeSelection();
      }
      await treeView.reveal(item, { select: true, focus: false, expand: true });
    } catch {
      filePane.clearSkipFilesListingSyncMarker();
      /* Item not yet in model or view hidden — ignore */
    }
  };

  const runSyncFolderTreeToActiveEditor = (): void => {
    void syncFolderTreeToActiveEditor();
  };

  const scheduleSyncFolderTreeToActiveEditor = (): void => {
    if (syncFolderTreeDebounceTimer !== undefined) {
      clearTimeout(syncFolderTreeDebounceTimer);
    }
    syncFolderTreeDebounceTimer = setTimeout(() => {
      syncFolderTreeDebounceTimer = undefined;
      runSyncFolderTreeToActiveEditor();
    }, SYNC_FOLDER_TREE_DEBOUNCE_MS);
  };

  notifySelectActiveFilePolicyChanged = () => {
    if (syncFolderTreeDebounceTimer !== undefined) {
      clearTimeout(syncFolderTreeDebounceTimer);
      syncFolderTreeDebounceTimer = undefined;
    }
    runSyncFolderTreeToActiveEditor();
  };

  context.subscriptions.push(
    new vscode.Disposable(() => {
      if (syncFolderTreeDebounceTimer !== undefined) {
        clearTimeout(syncFolderTreeDebounceTimer);
        syncFolderTreeDebounceTimer = undefined;
      }
    }),
    treeView.onDidChangeSelection(() => syncFilesToFolderSelection()),
    treeView.onDidChangeVisibility((e) => {
      if (e.visible) {
        if (syncFolderTreeDebounceTimer !== undefined) {
          clearTimeout(syncFolderTreeDebounceTimer);
          syncFolderTreeDebounceTimer = undefined;
        }
        runSyncFolderTreeToActiveEditor();
      }
    }),
    vscode.window.onDidChangeActiveTextEditor(() => {
      scheduleSyncFolderTreeToActiveEditor();
    }),
    vscode.window.tabGroups.onDidChangeTabs(() => {
      scheduleSyncFolderTreeToActiveEditor();
    })
  );

  /** One macrotask after `activate`: recursive watchers, then Folders/Files sync (see `startupKickoffTimer` dispose). */
  startupKickoffTimer = setTimeout(() => {
    startupKickoffTimer = undefined;
    setupRootRecursiveWatchers();
    if (treeView.selection.length > 0) {
      syncFilesToFolderSelection();
    }
    runSyncFolderTreeToActiveEditor();
  }, 0);

  if (vscode.workspace.getConfiguration("explorer-enhanced").get<boolean>("focusOnStart")) {
    const FOCUS_DELAYS_MS = [300, 800, 2000];
    const timers: ReturnType<typeof setTimeout>[] = [];
    for (const ms of FOCUS_DELAYS_MS) {
      timers.push(setTimeout(() => {
        if (!treeView.visible) {
          void vscode.commands.executeCommand("workbench.view.extension.explorer-enhanced");
        }
      }, ms));
    }
    context.subscriptions.push(new vscode.Disposable(() => timers.forEach(clearTimeout)));
  }
}

export function deactivate(): void {}
