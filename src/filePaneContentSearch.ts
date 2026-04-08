import * as path from "path";
import * as vscode from "vscode";
import { mapPool } from "./asyncPool";

const BIN_EXT = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".bmp",
  ".avif",
  ".zip",
  ".gz",
  ".7z",
  ".rar",
  ".tar",
  ".tgz",
  ".pdf",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".pdb",
  ".bin",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".otf",
  ".mp3",
  ".mp4",
  ".webm",
  ".mkv",
  ".wav",
  ".wasm",
  ".o",
  ".obj",
  ".class",
  ".jar",
]);

/** Limite de chemins énumérés (findFiles). */
export const CONTENT_SEARCH_MAX_URIS = 2000;
/** Octets lus max par fichier (UTF-8). */
export const CONTENT_SEARCH_MAX_BYTES = 384 * 1024;
/** Parallélisme lecture / scan contenu. */
export const CONTENT_SEARCH_READ_CONCURRENCY = 10;

function binaryExtension(fsPath: string): boolean {
  return BIN_EXT.has(path.extname(fsPath).toLowerCase());
}

function looksBinaryBuffer(buf: Uint8Array): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) {
      return true;
    }
  }
  return false;
}

/**
 * Fichiers sous `folderUri` dont le contenu (UTF-8, tronqué) contient `query` (sous-chaîne, insensible à la casse).
 * Respecte `token` ; ignore binaires / gros fichiers / dossiers d’artefacts courants.
 */
export async function collectUrisWithTextUnderFolder(
  folderUri: vscode.Uri,
  query: string,
  token: vscode.CancellationToken
): Promise<vscode.Uri[]> {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return [];
  }

  const include = new vscode.RelativePattern(folderUri, "**/*");
  const exclude = "**/{node_modules,.git,.svn,.hg,.vs,.idea,target,dist,out,build,.next,.nuxt,coverage}/**";
  const uris = await vscode.workspace.findFiles(include, exclude, CONTENT_SEARCH_MAX_URIS, token);

  const matching: vscode.Uri[] = [];

  await mapPool(uris, CONTENT_SEARCH_READ_CONCURRENCY, async (uri) => {
    if (token.isCancellationRequested) {
      return;
    }
    if (binaryExtension(uri.fsPath)) {
      return;
    }
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.type !== vscode.FileType.File || stat.size > CONTENT_SEARCH_MAX_BYTES) {
        return;
      }
      const buf = await vscode.workspace.fs.readFile(uri);
      if (buf.length > CONTENT_SEARCH_MAX_BYTES) {
        return;
      }
      if (looksBinaryBuffer(buf)) {
        return;
      }
      const text = new TextDecoder("utf-8", { fatal: false }).decode(buf);
      if (text.toLowerCase().includes(needle)) {
        matching.push(uri);
      }
    } catch {
      /* fichier supprimé / verrou : ignorer */
    }
  });

  matching.sort((a, b) => a.fsPath.localeCompare(b.fsPath, undefined, { sensitivity: "base" }));
  return matching;
}

/** Nom affiché : chemin relatif au dossier racine de recherche (slash « / »), sinon base. */
export function displayNameRelativeToFolder(folderUri: vscode.Uri, fileUri: vscode.Uri): string {
  const root = path.normalize(folderUri.fsPath);
  const fp = path.normalize(fileUri.fsPath);
  const rel = path.relative(root, fp);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    return path.basename(fp);
  }
  return rel.split(path.sep).join("/");
}
