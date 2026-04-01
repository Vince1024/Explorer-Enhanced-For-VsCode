import * as vscode from "vscode";
import { isFsDirectory, isFsFile } from "./fileTypeUtils";

/**
 * Total size of files under `root` (iterative walk; symbolic links resolved via `stat`).
 * Can be expensive on large trees (e.g. `node_modules`).
 */
export async function computeDirectorySizeBytes(root: vscode.Uri): Promise<number> {
  let total = 0;
  const stack: vscode.Uri[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(dir);
    } catch {
      continue;
    }
    for (const [name, type] of entries) {
      const child = vscode.Uri.joinPath(dir, name);
      if (isFsDirectory(type)) {
        stack.push(child);
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
            stack.push(child);
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
