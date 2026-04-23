import * as path from "path";
import * as vscode from "vscode";
import type { FolderTreeItem } from "./folderTreeDataProvider";

/**
 * Must match `application/vnd.code.tree.<viewIdLowercase>` for the contributed view
 * `explorer-enhanced.folderTree`.
 */
const FOLDER_TREE_MIME = "application/vnd.code.tree.explorer-enhanced.foldertree";

/** Whether the Folders tree row is a top-level multi-root workspace folder (not a subfolder). */
export function isWorkspaceRootRow(item: FolderTreeItem): boolean {
  if (item.isFileEntry) {
    return false;
  }
  return item.isWorkspaceRootFolder;
}

function workspaceFolderIndex(uri: vscode.Uri): number {
  const wfs = vscode.workspace.workspaceFolders;
  if (!wfs) {
    return -1;
  }
  const wf = vscode.workspace.getWorkspaceFolder(uri);
  if (!wf) {
    return -1;
  }
  const key = path.normalize(wf.uri.fsPath);
  return wfs.findIndex((f) => path.normalize(f.uri.fsPath) === key);
}

/**
 * Reorder multi-root workspace folders (same idea as the built-in Explorer).
 * Only top-level workspace roots are draggable; drop on another root inserts before it, or on empty tree area appends.
 */
/** Moves a workspace root row by one position in the multi-root folder list (no-op at bounds or if not a root row). */
export function moveWorkspaceRootRelative(item: FolderTreeItem, delta: -1 | 1): void {
  if (!isWorkspaceRootRow(item)) {
    void vscode.window.showInformationMessage(
      "Select a workspace root row in the Folders tree to reorder workspace folders."
    );
    return;
  }
  const wfs = vscode.workspace.workspaceFolders;
  if (!wfs || wfs.length < 2) {
    void vscode.window.showInformationMessage(
      "Add at least two root folders to the workspace to reorder them."
    );
    return;
  }
  const fromIdx = workspaceFolderIndex(item.uri);
  if (fromIdx < 0) {
    return;
  }
  const toIdx = fromIdx + delta;
  if (toIdx < 0 || toIdx >= wfs.length) {
    return;
  }
  const specs = wfs.map((f) => ({ uri: f.uri, name: f.name }));
  const [moved] = specs.splice(fromIdx, 1);
  specs.splice(toIdx, 0, moved);
  vscode.workspace.updateWorkspaceFolders(0, wfs.length, ...specs);
}

function applyWorkspaceRootReorder(source: FolderTreeItem, target: FolderTreeItem | undefined): void {
  if (!isWorkspaceRootRow(source)) {
    return;
  }
  const wfs = vscode.workspace.workspaceFolders;
  if (!wfs || wfs.length < 2) {
    return;
  }

  const fromIdx = workspaceFolderIndex(source.uri);
  if (fromIdx < 0) {
    return;
  }

  const specs = wfs.map((f) => ({ uri: f.uri, name: f.name }));

  if (target === undefined) {
    const [moved] = specs.splice(fromIdx, 1);
    specs.push(moved);
    vscode.workspace.updateWorkspaceFolders(0, wfs.length, ...specs);
    return;
  }

  if (!isWorkspaceRootRow(target)) {
    return;
  }

  const beforeIdx = workspaceFolderIndex(target.uri);
  if (beforeIdx < 0) {
    return;
  }
  if (fromIdx === beforeIdx) {
    return;
  }

  const [moved] = specs.splice(fromIdx, 1);
  let insertAt = beforeIdx;
  if (fromIdx < beforeIdx) {
    insertAt = beforeIdx - 1;
  }
  specs.splice(insertAt, 0, moved);
  vscode.workspace.updateWorkspaceFolders(0, wfs.length, ...specs);
}

export function createFolderTreeDragAndDropController(): vscode.TreeDragAndDropController<FolderTreeItem> {
  return {
    dropMimeTypes: [FOLDER_TREE_MIME],
    dragMimeTypes: [],
    handleDrag(source, dataTransfer, token): void {
      void token;
      const wfs = vscode.workspace.workspaceFolders;
      if (!wfs || wfs.length < 2) {
        return;
      }
      if (source.length !== 1) {
        return;
      }
      const [item] = source;
      if (!isWorkspaceRootRow(item)) {
        return;
      }
      dataTransfer.set(FOLDER_TREE_MIME, new vscode.DataTransferItem(source));
    },
    handleDrop(target, dataTransfer, token): void {
      void token;
      const ti = dataTransfer.get(FOLDER_TREE_MIME);
      if (!ti) {
        return;
      }
      const dragged = ti.value as FolderTreeItem[] | undefined;
      if (!Array.isArray(dragged) || dragged.length !== 1) {
        return;
      }
      applyWorkspaceRootReorder(dragged[0], target);
    },
  };
}
