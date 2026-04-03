import * as vscode from "vscode";
import { isFsDirectory, isFsFile } from "./fileTypeUtils";

/** Max depth from the folder root (avoids runaway walks on huge trees). */
const FOLDER_SIZE_DEFAULT_MAX_DEPTH = 48;

/**
 * Subdirectory names skipped when summing size (lowercase). Totals exclude typical deps/build outputs
 * so the Files pane stays responsive.
 */
const FOLDER_SIZE_SKIP_DIR_NAMES_LC = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "dist",
  "build",
  "out",
  "bin",
  "obj",
  "__pycache__",
  ".venv",
  "venv",
  "target",
  ".turbo",
  ".next",
  "coverage",
]);

type DirFrame = { uri: vscode.Uri; depth: number };

/**
 * Total size of files under `root` (iterative walk; symbolic links resolved via `stat`).
 * Excludes heavy / generated subtrees and caps depth — see {@link FOLDER_SIZE_SKIP_DIR_NAMES_LC}.
 */
export async function computeDirectorySizeBytes(root: vscode.Uri): Promise<number> {
  let total = 0;
  const stack: DirFrame[] = [{ uri: root, depth: 0 }];
  const maxDepth = FOLDER_SIZE_DEFAULT_MAX_DEPTH;

  while (stack.length > 0) {
    const { uri: dir, depth } = stack.pop()!;
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(dir);
    } catch {
      continue;
    }
    for (const [name, type] of entries) {
      const child = vscode.Uri.joinPath(dir, name);
      if (isFsDirectory(type)) {
        if (FOLDER_SIZE_SKIP_DIR_NAMES_LC.has(name.toLowerCase())) {
          continue;
        }
        if (depth + 1 > maxDepth) {
          continue;
        }
        stack.push({ uri: child, depth: depth + 1 });
      } else if (isFsFile(type)) {
        try {
          const st = await vscode.workspace.fs.stat(child);
          total += st.size;
        } catch {
          /* File removed or inaccessible. */
        }
      } else {
        try {
          const st = await vscode.workspace.fs.stat(child);
          if (isFsDirectory(st.type)) {
            if (FOLDER_SIZE_SKIP_DIR_NAMES_LC.has(name.toLowerCase())) {
              continue;
            }
            if (depth + 1 > maxDepth) {
              continue;
            }
            stack.push({ uri: child, depth: depth + 1 });
          } else if (isFsFile(st.type)) {
            total += st.size;
          }
        } catch {
          /* Ignore broken or inaccessible entries. */
        }
      }
    }
  }
  return total;
}
