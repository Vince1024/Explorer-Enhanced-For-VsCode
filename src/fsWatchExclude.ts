import * as path from "path";
import * as vscode from "vscode";

/**
 * Compile a VS Code `files.watcherExclude` glob into a `RegExp`.
 * Supports the subset actually used by watcher-exclude patterns: `**`, `**` + `/`, `*`, `?`, and `{a,b}` alternations.
 * Patterns are matched against a path relative to the watched folder, using forward slashes.
 */
function globToRegExp(glob: string): RegExp {
  let re = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 3;
        } else {
          re += ".*";
          i += 2;
        }
      } else {
        re += "[^/]*";
        i += 1;
      }
    } else if (c === "?") {
      re += "[^/]";
      i += 1;
    } else if (c === "{") {
      re += "(?:";
      i += 1;
    } else if (c === "}") {
      re += ")";
      i += 1;
    } else if (c === ",") {
      re += "|";
      i += 1;
    } else if (".+^$()[]\\|/".includes(c)) {
      re += "\\" + c;
      i += 1;
    } else {
      re += c;
      i += 1;
    }
  }
  return new RegExp("^" + re + "$");
}

/** Build a matcher for a single workspace folder from its effective `files.watcherExclude` config. */
function createWatchExcludeMatcher(folderUri: vscode.Uri): (uri: vscode.Uri) => boolean {
  const cfg =
    vscode.workspace
      .getConfiguration("files", folderUri)
      .get<Record<string, boolean>>("watcherExclude") ?? {};
  const regexes: RegExp[] = [];
  for (const [pattern, enabled] of Object.entries(cfg)) {
    if (!enabled) {
      continue;
    }
    regexes.push(globToRegExp(pattern));
    /** Excluding a directory also excludes its whole subtree (e.g. `**\/node_modules` → everything under it). */
    const subtree = pattern.replace(/\/+$/, "") + "/**";
    regexes.push(globToRegExp(subtree));
  }
  const rootFs = path.normalize(folderUri.fsPath);
  return (uri: vscode.Uri): boolean => {
    const abs = path.normalize(uri.fsPath);
    let rel = path.relative(rootFs, abs);
    if (!rel || rel.startsWith("..")) {
      return false;
    }
    rel = rel.split(path.sep).join("/");
    return regexes.some((r) => r.test(rel));
  };
}

/**
 * Mirrors the native Explorer's background watcher: file events under `files.watcherExclude`
 * (defaults include `**\/node_modules`, `**\/.git/objects`, `**\/bower_components`) are ignored so that
 * churn in dependency/VCS/build folders never triggers an Explorer Enhanced refresh.
 */
export function createFsWatchExcludeFilter(): {
  isExcluded: (uri: vscode.Uri) => boolean;
  dispose: () => void;
} {
  const cache = new Map<string, (uri: vscode.Uri) => boolean>();
  const getMatcher = (wf: vscode.WorkspaceFolder): ((uri: vscode.Uri) => boolean) => {
    const key = path.normalize(wf.uri.fsPath);
    let m = cache.get(key);
    if (!m) {
      m = createWatchExcludeMatcher(wf.uri);
      cache.set(key, m);
    }
    return m;
  };
  const sub = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration("files.watcherExclude")) {
      cache.clear();
    }
  });
  return {
    isExcluded: (uri: vscode.Uri): boolean => {
      const wf = vscode.workspace.getWorkspaceFolder(uri);
      if (!wf) {
        return false;
      }
      return getMatcher(wf)(uri);
    },
    dispose: (): void => {
      cache.clear();
      sub.dispose();
    },
  };
}
