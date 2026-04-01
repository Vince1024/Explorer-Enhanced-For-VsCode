import * as vscode from "vscode";

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
      if (type === vscode.FileType.File) {
        try {
          const st = await vscode.workspace.fs.stat(child);
          total += st.size;
        } catch {
          /* File removed or inaccessible. */
        }
      } else if (type === vscode.FileType.Directory) {
        stack.push(child);
      } else if (type === vscode.FileType.Unknown) {
        try {
          const st = await vscode.workspace.fs.stat(child);
          if (st.type === vscode.FileType.Directory) {
            stack.push(child);
          } else if (st.type === vscode.FileType.File) {
            total += st.size;
          }
        } catch {
          /* Ignore broken or inaccessible entries. */
        }
      } else if (type === vscode.FileType.SymbolicLink) {
        try {
          const st = await vscode.workspace.fs.stat(child);
          if (st.type === vscode.FileType.Directory) {
            stack.push(child);
          } else {
            total += st.size;
          }
        } catch {
          /* Ignore broken or inaccessible symlink targets. */
        }
      }
    }
  }
  return total;
}
