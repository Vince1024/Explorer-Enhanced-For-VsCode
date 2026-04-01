import * as vscode from "vscode";

/**
 * `readDirectory` / `stat` can return combined flags, e.g. `Directory | SymbolicLink` on Windows.
 * Strict `=== FileType.Directory` misses symlinked folders — they disappear from the tree.
 */
export function isFsDirectory(type: vscode.FileType): boolean {
  return (type & vscode.FileType.Directory) !== 0;
}

/** File or symlink-to-file; not a directory (directory symlinks use the Directory bit). */
export function isFsFile(type: vscode.FileType): boolean {
  return (type & vscode.FileType.File) !== 0 && (type & vscode.FileType.Directory) === 0;
}
