import * as path from "path";
import * as vscode from "vscode";

/** Single `file:` resource for the tab input (diff: prefers modified side). */
export function fileUriFromTabInput(input: unknown): vscode.Uri | undefined {
  if (input instanceof vscode.TabInputText && input.uri.scheme === "file") {
    return input.uri;
  }
  if (input instanceof vscode.TabInputCustom && input.uri.scheme === "file") {
    return input.uri;
  }
  if (input instanceof vscode.TabInputNotebook && input.uri.scheme === "file") {
    return input.uri;
  }
  if (input instanceof vscode.TabInputTextDiff) {
    if (input.modified.scheme === "file") {
      return input.modified;
    }
    if (input.original.scheme === "file") {
      return input.original;
    }
    return undefined;
  }
  if (input instanceof vscode.TabInputNotebookDiff) {
    if (input.modified.scheme === "file") {
      return input.modified;
    }
    if (input.original.scheme === "file") {
      return input.original;
    }
    return undefined;
  }
  return undefined;
}

/** All `file:` paths open in editor tabs (normalized), including both sides of diffs. */
export function collectOpenWorkspaceFilePaths(): string[] {
  const into = new Set<string>();
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      addOpenFilePathsFromTabInput(tab.input, into);
    }
  }
  return [...into].sort();
}

function addOpenFilePathsFromTabInput(input: unknown, into: Set<string>): void {
  if (input instanceof vscode.TabInputText && input.uri.scheme === "file") {
    into.add(path.normalize(input.uri.fsPath));
    return;
  }
  if (input instanceof vscode.TabInputCustom && input.uri.scheme === "file") {
    into.add(path.normalize(input.uri.fsPath));
    return;
  }
  if (input instanceof vscode.TabInputNotebook && input.uri.scheme === "file") {
    into.add(path.normalize(input.uri.fsPath));
    return;
  }
  if (input instanceof vscode.TabInputTextDiff) {
    for (const u of [input.original, input.modified]) {
      if (u.scheme === "file") {
        into.add(path.normalize(u.fsPath));
      }
    }
    return;
  }
  if (input instanceof vscode.TabInputNotebookDiff) {
    for (const u of [input.original, input.modified]) {
      if (u.scheme === "file") {
        into.add(path.normalize(u.fsPath));
      }
    }
  }
}

/**
 * `file:` URI for the resource shown in the active editor tab.
 * Covers text editors, image/custom previews ({@link vscode.TabInputCustom}), notebooks, and diffs.
 * Returns `undefined` for terminals, webviews, or when the active tab is not a single workspace file.
 */
export function getActiveWorkspaceFileUri(): vscode.Uri | undefined {
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  if (!tab?.input) {
    return fallbackActiveTextEditorFileUri();
  }

  const input = tab.input;

  const fromTab = fileUriFromTabInput(input);
  if (fromTab) {
    return fromTab;
  }
  if (input instanceof vscode.TabInputTerminal || input instanceof vscode.TabInputWebview) {
    return undefined;
  }
  /* Unknown tab input: do not fall back to text editor (avoids wrong file while preview tab is focused). */
  return undefined;
}

function fallbackActiveTextEditorFileUri(): vscode.Uri | undefined {
  const uri = vscode.window.activeTextEditor?.document.uri;
  return uri?.scheme === "file" ? uri : undefined;
}
