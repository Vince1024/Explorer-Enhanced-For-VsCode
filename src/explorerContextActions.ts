import * as path from "path";
import * as vscode from "vscode";

/** Label for revealFileInOS (Explorer wording varies by platform). */
export function revealInOsMenuTitle(): string {
  switch (process.platform) {
    case "darwin":
      return "Reveal in Finder";
    case "win32":
      return "Reveal in File Explorer";
    default:
      return "Open Containing Folder";
  }
}

export async function revealInExplorerView(uri: vscode.Uri): Promise<void> {
  await vscode.commands.executeCommand("revealInExplorer", uri);
}

export async function revealInOs(uri: vscode.Uri): Promise<void> {
  await vscode.commands.executeCommand("revealFileInOS", uri);
}

export async function openToSide(uri: vscode.Uri): Promise<void> {
  try {
    await vscode.commands.executeCommand("revealInExplorer", uri);
    await vscode.commands.executeCommand("explorer.openToSide");
    return;
  } catch {
    /* fallback */
  }
  await vscode.commands.executeCommand("vscode.open", uri, {
    viewColumn: vscode.ViewColumn.Beside,
  });
}

export async function copyPath(uri: vscode.Uri): Promise<void> {
  await vscode.commands.executeCommand("copyFilePath", uri);
}

export async function copyRelativePath(uri: vscode.Uri): Promise<void> {
  await vscode.commands.executeCommand("copyRelativeFilePath", uri);
}

/** Opens an integrated terminal with cwd = folder, or parent of file. */
export async function openInIntegratedTerminal(uri: vscode.Uri): Promise<void> {
  let folderUri: vscode.Uri;
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    folderUri =
      stat.type === vscode.FileType.Directory ? uri : vscode.Uri.file(path.dirname(uri.fsPath));
  } catch {
    folderUri = vscode.Uri.file(path.dirname(uri.fsPath));
  }
  await vscode.commands.executeCommand("openInIntegratedTerminal", folderUri);
}

function validateSingleName(value: string): string | null {
  const v = value.trim();
  if (!v) {
    return "Enter a name.";
  }
  if (v !== path.basename(v)) {
    return "Use a single file or folder name (no path separators).";
  }
  if (/^\.+$/.test(v)) {
    return "Invalid name.";
  }
  return null;
}

export async function newFileInFolder(parent: vscode.Uri, onChanged: () => void): Promise<void> {
  const name = await vscode.window.showInputBox({
    prompt: "File name",
    validateInput: validateSingleName,
  });
  const trimmed = name?.trim();
  if (!trimmed) {
    return;
  }
  const target = vscode.Uri.joinPath(parent, trimmed);
  try {
    await vscode.workspace.fs.stat(target);
    void vscode.window.showErrorMessage("A file or folder with that name already exists.");
    return;
  } catch {
    /* does not exist */
  }
  await vscode.workspace.fs.writeFile(target, new Uint8Array());
  onChanged();
}

export async function newFolderInFolder(parent: vscode.Uri, onChanged: () => void): Promise<void> {
  const name = await vscode.window.showInputBox({
    prompt: "Folder name",
    validateInput: validateSingleName,
  });
  const trimmed = name?.trim();
  if (!trimmed) {
    return;
  }
  const target = vscode.Uri.joinPath(parent, trimmed);
  try {
    await vscode.workspace.fs.stat(target);
    void vscode.window.showErrorMessage("A file or folder with that name already exists.");
    return;
  } catch {
    /* does not exist */
  }
  await vscode.workspace.fs.createDirectory(target);
  onChanged();
}

export async function renameResource(uri: vscode.Uri, onChanged: () => void): Promise<void> {
  const base = path.basename(uri.fsPath);
  const next = await vscode.window.showInputBox({
    prompt: "New name",
    value: base,
    validateInput: validateSingleName,
  });
  const trimmed = next?.trim();
  if (!trimmed) {
    return;
  }
  if (trimmed === base) {
    return;
  }
  const parent = vscode.Uri.file(path.dirname(uri.fsPath));
  const target = vscode.Uri.joinPath(parent, trimmed);
  try {
    await vscode.workspace.fs.stat(target);
    void vscode.window.showErrorMessage("A file or folder with that name already exists.");
    return;
  } catch {
    /* ok */
  }
  await vscode.workspace.fs.rename(uri, target);
  onChanged();
}

export async function deleteResource(uri: vscode.Uri, onChanged: () => void): Promise<void> {
  const base = path.basename(uri.fsPath);
  let isDir = false;
  let nonEmptyDir = false;
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    isDir = stat.type === vscode.FileType.Directory;
    if (isDir) {
      const kids = await vscode.workspace.fs.readDirectory(uri);
      nonEmptyDir = kids.length > 0;
    }
  } catch {
    void vscode.window.showErrorMessage(`Could not read: ${base}`);
    return;
  }

  const msg = nonEmptyDir
    ? `Delete folder '${base}' and its contents?`
    : `Delete '${base}'?`;
  const ok = await vscode.window.showWarningMessage(
    msg,
    { modal: true },
    "Move to Trash",
    "Cancel"
  );
  if (ok !== "Move to Trash") {
    return;
  }

  await vscode.workspace.fs.delete(uri, { recursive: isDir, useTrash: true });
  onChanged();
}

async function executeFirstCommand(
  attempts: ReadonlyArray<{ command: string; args?: readonly unknown[] }>
): Promise<boolean> {
  for (const a of attempts) {
    const args = a.args ?? [];
    try {
      await vscode.commands.executeCommand(a.command, ...args);
      return true;
    } catch {
      /* try next */
    }
  }
  return false;
}

/** Focus selection in the built-in Files explorer (required for several `filesExplorer.*` commands). */
async function focusInFilesExplorer(uri: vscode.Uri): Promise<void> {
  await vscode.commands.executeCommand("revealInExplorer", uri);
}

export async function openWithPicker(uri: vscode.Uri): Promise<void> {
  await vscode.window.showTextDocument(uri, { preview: true });
  const ok = await executeFirstCommand([{ command: "workbench.action.reopenWithEditor" }]);
  if (!ok) {
    void vscode.window.showWarningMessage("Open With… n'est pas disponible.");
  }
}

export async function findInFolder(uri: vscode.Uri): Promise<void> {
  try {
    await vscode.commands.executeCommand("filesExplorer.findInFolder", uri);
    return;
  } catch {
    /* continue */
  }
  try {
    await vscode.commands.executeCommand("revealInExplorer", uri);
    await vscode.commands.executeCommand("filesExplorer.findInFolder", uri);
    return;
  } catch {
    /* fallback recherche */
  }
  const rel = vscode.workspace.asRelativePath(uri, false);
  if (rel && !rel.startsWith("..")) {
    const posix = rel.replace(/\\/g, "/");
    const ok = await executeFirstCommand([
      {
        command: "workbench.action.findInFiles",
        args: [{ query: "", filesToInclude: `${posix}/**` }],
      },
    ]);
    if (ok) {
      return;
    }
  }
  void vscode.window.showWarningMessage("Impossible d'ouvrir la recherche dans ce dossier.");
}

export async function explorerCut(uri: vscode.Uri): Promise<void> {
  await focusInFilesExplorer(uri);
  await vscode.commands.executeCommand("filesExplorer.cut");
}

export async function explorerCopy(uri: vscode.Uri): Promise<void> {
  await focusInFilesExplorer(uri);
  await vscode.commands.executeCommand("filesExplorer.copy");
}

export async function explorerPaste(targetFolderUri: vscode.Uri): Promise<void> {
  await focusInFilesExplorer(targetFolderUri);
  await vscode.commands.executeCommand("filesExplorer.paste");
}

export async function selectForCompare(uri: vscode.Uri): Promise<void> {
  await focusInFilesExplorer(uri);
  await vscode.commands.executeCommand("selectForCompare");
}

export async function openTimeline(uri: vscode.Uri): Promise<void> {
  const ok = await executeFirstCommand([{ command: "files.openTimeline", args: [uri] }]);
  if (!ok) {
    void vscode.window.showWarningMessage("Impossible d'ouvrir la timeline pour ce fichier.");
  }
}

export async function findFileReferences(uri: vscode.Uri): Promise<void> {
  await vscode.window.showTextDocument(uri, { preview: true });
  const ok = await executeFirstCommand([
    { command: "references-view.findReferences" },
    { command: "editor.action.goToReferences" },
  ]);
  if (!ok) {
    void vscode.window.showWarningMessage(
      "Références introuvables (aucun fournisseur ou commande d'extension)."
    );
  }
}

export async function runTestsForExplorerItem(uri: vscode.Uri): Promise<void> {
  let isDir = false;
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    isDir = stat.type === vscode.FileType.Directory;
  } catch {
    void vscode.window.showWarningMessage("Impossible de lire la ressource.");
    return;
  }
  if (isDir) {
    const ok = await executeFirstCommand([
      { command: "testing.runAll" },
      { command: "workbench.action.debug.selectandstart" },
    ]);
    if (!ok) {
      void vscode.window.showInformationMessage(
        "Pour un dossier, lancez les tests depuis la vue Testing ou un fichier de test."
      );
    }
    return;
  }
  await vscode.window.showTextDocument(uri, { preview: true });
  const ran = await executeFirstCommand([
    { command: "testing.runCurrentFile" },
    { command: "testing.runAtCursor" },
    { command: "workbench.action.debug.run" },
  ]);
  if (!ran) {
    void vscode.window.showInformationMessage(
      "Aucune commande de tests reconnue pour ce fichier (extension Testing / débogage)."
    );
  }
}

export async function cursorOrGitBlame(uri: vscode.Uri): Promise<void> {
  await vscode.window.showTextDocument(uri, { preview: true });
  const ok = await executeFirstCommand([
    { command: "cursor.blame" },
    { command: "cursor.toggleBlame" },
    { command: "gitlens.toggleFileBlame" },
    { command: "gitlens.toggleLineBlame" },
  ]);
  if (!ok) {
    void vscode.window.showInformationMessage(
      "Aucune commande Blame reconnue (Cursor ou GitLens)."
    );
  }
}

const CURSOR_CHAT_ATTACH: readonly string[] = [
  "cursor.chat.attachContext",
  "composer.addFileToChat",
  "workbench.action.chat.attachContext",
  "cursor.addFileToChat",
  "aichat.newchataction.attachfile",
];

const CURSOR_CHAT_NEW: readonly string[] = [
  "cursor.chat.attachContextInNewChat",
  "composer.addFileToNewChat",
  "cursor.addFileToNewChat",
];

async function runCommandWithUriVariants(command: string, uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.commands.executeCommand(command, uri);
    return true;
  } catch {
    /* */
  }
  try {
    await vscode.commands.executeCommand(command, [uri]);
    return true;
  } catch {
    return false;
  }
}

export async function addToCursorChat(uri: vscode.Uri): Promise<void> {
  for (const id of CURSOR_CHAT_ATTACH) {
    if (await runCommandWithUriVariants(id, uri)) {
      return;
    }
  }
  void vscode.window.showInformationMessage(
    "Impossible d'ajouter au chat : commande Cursor / Chat non disponible depuis l'extension."
  );
}

export async function addToNewCursorChat(uri: vscode.Uri): Promise<void> {
  for (const id of CURSOR_CHAT_NEW) {
    if (await runCommandWithUriVariants(id, uri)) {
      return;
    }
  }
  try {
    await vscode.commands.executeCommand("workbench.action.chat.newChat");
    for (const id of CURSOR_CHAT_ATTACH) {
      if (await runCommandWithUriVariants(id, uri)) {
        return;
      }
    }
  } catch {
    /* */
  }
  void vscode.window.showInformationMessage(
    "Impossible d'ajouter à un nouveau chat : commande non disponible."
  );
}
