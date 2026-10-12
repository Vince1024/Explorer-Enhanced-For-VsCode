import * as path from "path";
import * as vscode from "vscode";
import { isFsDirectory } from "./fileTypeUtils";
import { getShowFilesInFolderTreeFromWorkspaceState } from "./filePaneSettings";

/** Folders tree needs a full rebuild (`both`) vs Files-only refresh (`filesOnly`) after an FS change. */
export type TreeBumpScope = "both" | "filesOnly";

/**
 * Decides whether changed `uris` require a full Folders tree rebuild (`both`) or just a Files refresh (`filesOnly`).
 * `both` when the tree lists files, any path is (or looks like) a directory, or `stat` fails ambiguously.
 * @param treatStatErrorAsDirectory For deleted paths (already gone), fall back to a name heuristic instead of `both`.
 */
export async function classifyUrisForTreeBump(
  uris: readonly vscode.Uri[],
  workspaceState: vscode.Memento,
  treatStatErrorAsDirectory: (uri: vscode.Uri) => boolean = () => true
): Promise<TreeBumpScope> {
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
      if (treatStatErrorAsDirectory(u)) {
        return "both";
      }
    }
  }
  return "filesOnly";
}

/** Deleted paths can no longer be `stat`ed: treat extension-less names (e.g. `src`, `Dockerfile`) as folders. */
export function deletedPathLooksLikeDirectory(uri: vscode.Uri): boolean {
  return !path.basename(uri.fsPath).includes(".");
}
