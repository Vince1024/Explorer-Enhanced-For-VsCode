import * as vscode from "vscode";

const SETTING_KEY = "explorer-enhanced.folders.folderExpandInteraction";

/**
 * Optional sync of `workbench.tree.expandMode` from Explorer Enhanced settings.
 *
 * VS Code does not let extensions handle “chevron vs label” separately; `doubleClick` means: twistie (>) toggles
 * with one click; the folder label toggles on double-click; single click only selects (for tree items without
 * `TreeItem.command`, i.e. our folder rows).
 */
export function syncFoldersTreeExpandModeWithWorkbench(): void {
  const cfg = vscode.workspace.getConfiguration();
  const mode = cfg.get<string>(SETTING_KEY, "inherit");
  if (mode === "inherit") {
    return;
  }
  if (mode !== "singleClick" && mode !== "doubleClick") {
    return;
  }
  if (!vscode.workspace.workspaceFolders?.length) {
    return;
  }
  const current = cfg.get<string>("workbench.tree.expandMode");
  if (current === mode) {
    return;
  }
  void vscode.workspace.getConfiguration("workbench").update("tree.expandMode", mode, vscode.ConfigurationTarget.Workspace);
}

export function registerFoldersTreeExpandModeSync(context: vscode.ExtensionContext): void {
  syncFoldersTreeExpandModeWithWorkbench();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(SETTING_KEY)) {
        syncFoldersTreeExpandModeWithWorkbench();
      }
    })
  );
}
