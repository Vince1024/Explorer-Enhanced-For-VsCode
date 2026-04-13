import * as cp from "child_process";
import * as util from "util";
import * as vscode from "vscode";

const execFile = util.promisify(cp.execFile);

const ENV_LNK_PATH = "EE_EXPLORER_LNK_RESOLVE";

/**
 * Reads the Shell Link target path on Windows via WScript.Shell (same as Explorer).
 * Returns undefined if not Windows, resolution fails, or target is empty.
 */
async function resolveWindowsLnkTargetPath(lnkFsPath: string): Promise<string | undefined> {
  if (process.platform !== "win32" || !lnkFsPath) {
    return undefined;
  }
  try {
    const { stdout } = await execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "$ErrorActionPreference = 'Stop'; try { " +
          "$t = (New-Object -ComObject WScript.Shell).CreateShortcut($env:" +
          ENV_LNK_PATH +
          ").TargetPath; " +
          "if ($t -and $t.Length -gt 0) { [Console]::Out.Write($t) } " +
          "} catch { }",
      ],
      {
        env: { ...process.env, [ENV_LNK_PATH]: lnkFsPath },
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      }
    );
    const line = stdout.replace(/\r\n/g, "\n").trim().split("\n")[0]?.trim();
    return line && line.length > 0 ? line : undefined;
  } catch {
    return undefined;
  }
}

/**
 * When **Files: Follow .lnk Links** is on and `uri` is a `.lnk` file on Windows,
 * returns a `file` URI for the shortcut target; otherwise returns `uri` unchanged.
 */
export async function resolveUriForLnkFollow(uri: vscode.Uri): Promise<vscode.Uri> {
  if (uri.scheme !== "file") {
    return uri;
  }
  const follow =
    vscode.workspace.getConfiguration("explorer-enhanced.files").get<boolean>("followLnkLinks") === true;
  if (!follow) {
    return uri;
  }
  const p = uri.fsPath;
  if (!p.toLowerCase().endsWith(".lnk")) {
    return uri;
  }
  const target = await resolveWindowsLnkTargetPath(p);
  if (!target) {
    return uri;
  }
  return vscode.Uri.file(target);
}
