import * as path from "path";
import * as vscode from "vscode";

/** Counts per file from {@link vscode.languages.getDiagnostics} (Problems / language services). */
export interface FileProblemsCount {
  errors: number;
  warnings: number;
  /** `DiagnosticSeverity.Information` and `Hint`. */
  infos: number;
}

/** Normalize path for Map lookup (consistent with Git path handling on Windows). */
export function normalizeProblemsPath(fsPath: string): string {
  const n = path.normalize(fsPath);
  return process.platform === "win32" ? n.toLowerCase() : n;
}

function pathsEqualNorm(a: string, b: string): boolean {
  const na = path.normalize(a);
  const nb = path.normalize(b);
  return process.platform === "win32" ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

/**
 * `true` when at least one non-empty diagnostic touches the displayed folder (direct files or subtree).
 * When there are no non-empty diagnostics anywhere in the workspace, returns `true` so the Problems column can clear.
 */
export function diagnosticsMayAffectFolder(folderFsPath: string): boolean {
  const F = path.normalize(folderFsPath);
  const sep = path.sep;
  let sawNonEmpty = false;
  for (const [uri, diags] of vscode.languages.getDiagnostics()) {
    if (uri.scheme !== "file" || diags.length === 0) {
      continue;
    }
    sawNonEmpty = true;
    const fp = path.normalize(uri.fsPath);
    if (
      pathsEqualNorm(fp, F) ||
      pathsEqualNorm(path.dirname(fp), F) ||
      (process.platform === "win32"
        ? fp.toLowerCase().startsWith(F.toLowerCase() + sep)
        : fp.startsWith(F + sep))
    ) {
      return true;
    }
  }
  if (!sawNonEmpty) {
    return true;
  }
  return false;
}

function countDiagnostics(diags: readonly vscode.Diagnostic[]): FileProblemsCount {
  let errors = 0;
  let warnings = 0;
  let infos = 0;
  for (const d of diags) {
    switch (d.severity) {
      case vscode.DiagnosticSeverity.Error:
        errors++;
        break;
      case vscode.DiagnosticSeverity.Warning:
        warnings++;
        break;
      default:
        infos++;
    }
  }
  return { errors, warnings, infos };
}

/** Diagnostics only for the listed files (avoids scanning the entire workspace). */
export function buildProblemsCountForFilePaths(fileFsPaths: readonly string[]): Map<string, FileProblemsCount> {
  const map = new Map<string, FileProblemsCount>();
  for (const fsPath of fileFsPaths) {
    const uri = vscode.Uri.file(fsPath);
    const diags = vscode.languages.getDiagnostics(uri);
    if (diags.length === 0) {
      continue;
    }
    map.set(normalizeProblemsPath(fsPath), countDiagnostics(diags));
  }
  return map;
}
