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
import { FolderTreeDataProvider, FolderTreeItem } from "./folderTreeDataProvider";
import { GitFileStatusService } from "./gitFileStatusService";

function uriInWorkspace(uri: vscode.Uri): boolean {
  return uri.scheme === "file" && vscode.workspace.getWorkspaceFolder(uri) !== undefined;
}

/**
 * After activation, indexers, Git, and AV often emit many workspace FS events. Without coalescing,
 * repeated debounced refreshes can make the Folders tree thrash. For `STARTUP_FS_COALESCE_MS`, bumps are
 * folded into one refresh at the end of that window; afterward only `FS_BUMP_DEBOUNCE_MS` applies.
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

  void syncShowFilesInTreeContext(context.workspaceState);

  /** Filled after {@link syncFolderTreeToActiveEditor} is defined; used when the Files menu toggles “Select Active File”. */
  let notifySelectActiveFilePolicyChanged: () => void = () => {};

  const filePaneHost: { current?: FilePaneViewProvider } = {};
  const bumpAfterFsChange = (): void => {
    folderData.refresh();
    const p = filePaneHost.current;
    if (p) {
      void p.showFolder(p.getLastFolderUri());
    }
  };

  const treeView = vscode.window.createTreeView("explorer-enhanced.folderTree", {
    treeDataProvider: folderData,
    showCollapseAll: true,
  });

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
        void p.showFolder(folderUri, true);
      }
    } else {
      void p.showFolder(folderUri, true);
    }
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
  let startupFsBumpPending = false;

  const scheduleBumpAfterFsChange = (): void => {
    const now = Date.now();
    if (now < startupPhaseEndsAt) {
      startupFsBumpPending = true;
      if (startupCoalesceTimer === undefined) {
        const delay = Math.max(0, startupPhaseEndsAt - now);
        startupCoalesceTimer = setTimeout(() => {
          startupCoalesceTimer = undefined;
          if (startupFsBumpPending) {
            startupFsBumpPending = false;
            bumpAfterFsChange();
          }
        }, delay);
      }
      return;
    }
    if (fsBumpDebounceTimer !== undefined) {
      clearTimeout(fsBumpDebounceTimer);
    }
    fsBumpDebounceTimer = setTimeout(() => {
      fsBumpDebounceTimer = undefined;
      bumpAfterFsChange();
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
      w.onDidCreate(() => scheduleBumpAfterFsChange());
      w.onDidDelete(() => scheduleBumpAfterFsChange());
      rootRecursiveWatchers.push(w);
    }
  };
  setupRootRecursiveWatchers();

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
      for (const w of rootRecursiveWatchers) {
        w.dispose();
      }
      rootRecursiveWatchers.length = 0;
    }),
    new vscode.Disposable(() => filePane.dispose()),
    treeView,
    vscode.window.registerWebviewViewProvider(FilePaneViewProvider.viewType, filePane),
    vscode.workspace.onDidCreateFiles((e) => {
      if (e.files.some(uriInWorkspace)) {
        scheduleBumpAfterFsChange();
      }
    }),
    vscode.workspace.onDidDeleteFiles((e) => {
      if (e.files.some(uriInWorkspace)) {
        scheduleBumpAfterFsChange();
      }
    }),
    vscode.workspace.onDidRenameFiles((e) => {
      if (e.files.some((x) => uriInWorkspace(x.oldUri) || uriInWorkspace(x.newUri))) {
        scheduleBumpAfterFsChange();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      folderData.refresh();
      updateFolderTreeChrome();
      setupRootRecursiveWatchers();
      if ((vscode.workspace.workspaceFolders?.length ?? 0) === 0) {
        void filePane.showFolder(undefined);
      }
    }),
    vscode.commands.registerCommand("explorer-enhanced.focus", async () => {
      await vscode.commands.executeCommand("workbench.action.focusSideBar");
      await vscode.commands.executeCommand("explorer-enhanced.folderTree.focus");
    }),
    vscode.commands.registerCommand("explorer-enhanced.showFoldersInList", () => {
      void setShowFoldersInFilesList(context.workspaceState, true).then(() => {
        filePane.invalidateFilesListingCache();
        bumpAfterFsChange();
      });
    }),
    vscode.commands.registerCommand("explorer-enhanced.hideFoldersInList", () => {
      void setShowFoldersInFilesList(context.workspaceState, false).then(() => {
        filePane.invalidateFilesListingCache();
        bumpAfterFsChange();
      });
    }),
    vscode.commands.registerCommand("explorer-enhanced.viewLayout.list", () => {
      void context.workspaceState.update(FILES_PANE_VIEW_LAYOUT_STATE_KEY, "list").then(() => {
        bumpAfterFsChange();
      });
    }),
    vscode.commands.registerCommand("explorer-enhanced.viewLayout.detail", () => {
      void context.workspaceState.update(FILES_PANE_VIEW_LAYOUT_STATE_KEY, "detail").then(() => {
        bumpAfterFsChange();
      });
    }),
    vscode.commands.registerCommand("explorer-enhanced.viewLayout.icons", () => {
      void context.workspaceState.update(FILES_PANE_VIEW_LAYOUT_STATE_KEY, "icons").then(() => {
        bumpAfterFsChange();
      });
    }),
    vscode.commands.registerCommand("explorer-enhanced.folders.showFilesInTree", () => {
      void setShowFilesInFolderTree(context.workspaceState, true).then(() =>
        syncShowFilesInTreeContext(context.workspaceState).then(() => {
          folderData.refresh();
          bumpAfterFsChange();
        })
      );
    }),
    vscode.commands.registerCommand("explorer-enhanced.folders.hideFilesInTree", () => {
      void setShowFilesInFolderTree(context.workspaceState, false).then(() =>
        syncShowFilesInTreeContext(context.workspaceState).then(() => {
          folderData.refresh();
          bumpAfterFsChange();
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
    )
  );

  const syncFilesToFolderSelection = (): void => {
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

    if (showFilesInTree && docStat?.type === vscode.FileType.File) {
      const fileItem = await folderData.getTreeItemForFileUri(docUri);
      if (fileItem) {
        try {
          await treeView.reveal(fileItem, { select: true, focus: false, expand: true });
          return;
        } catch {
          /* Tree not ready or node missing — fall back to folder below */
        }
      }
    }

    let folderFs = path.normalize(path.dirname(docUri.fsPath));
    if (docStat?.type === vscode.FileType.Directory) {
      folderFs = path.normalize(docUri.fsPath);
    }
    const folderUri = vscode.Uri.file(folderFs);
    const item = await folderData.getTreeItemForFolderUri(folderUri);
    if (!item) {
      return;
    }
    try {
      await treeView.reveal(item, { select: true, focus: false, expand: true });
    } catch {
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

  /** Yield one turn so Folders can paint before reveal + Files sync (lighter perceived first load). */
  setTimeout(() => {
    if (treeView.selection.length > 0) {
      syncFilesToFolderSelection();
    }
    runSyncFolderTreeToActiveEditor();
  }, 0);
}

export function deactivate(): void {}
