import * as vscode from "vscode";

/** Files pane List / Details / Icons layout: workspace state (not Settings UI). Legacy settings section `fileViews` still read once for migration (`files.viewLayout`). */
export const FILES_PANE_VIEW_LAYOUT_STATE_KEY = "explorer-enhanced.filePane.viewLayout";

/** Git column visibility in Files (workspace memento; legacy config: `fileViews.files.showGitStatus`). */
export const WORKSPACE_SHOW_GIT_IN_FILES_KEY = "explorer-enhanced.workspace.showGitInFiles";

/** Problems column in Files (workspace memento; no Settings UI key). Default: on. */
export const WORKSPACE_SHOW_PROBLEMS_IN_FILES_KEY = "explorer-enhanced.workspace.showProblemsInFiles";

/** Row separator lines between files/folders in List and Details (not Icons). Default: off. */
export const WORKSPACE_SHOW_FILES_ROW_LINES_KEY = "explorer-enhanced.workspace.showFilesRowLines";

/**
 * Vertical separators between columns in List and Details (not Icons). Default: on.
 * Note: legacy key `fileViews.workspace.showFilesTableColumns` (header experiment) is no longer read.
 */
export const WORKSPACE_SHOW_FILES_COLUMN_LINES_KEY = "explorer-enhanced.workspace.showFilesColumnLines";

/** Recursive folder sizes in the Size column (workspace memento). Default: off (heavy I/O). */
export const WORKSPACE_SHOW_FOLDER_SIZE_KEY = "explorer-enhanced.workspace.showFolderSize";

/**
 * When Explorer Enhanced is the active sidebar activity: follow the active editor in Folders + Files (default on).
 * When false, no tree reveal / row highlight on editor changes (while still never syncing when this activity is not active).
 */
export const WORKSPACE_SELECT_ACTIVE_FILE_KEY = "explorer-enhanced.workspace.selectActiveFile";

/** Bold (etc.) rows in Files for files that have an open editor tab. Default: off. */
export const WORKSPACE_HIGHLIGHT_OPEN_FILES_KEY = "explorer-enhanced.workspace.highlightOpenFiles";

/** Folder / file path in the Files pane hint line (above the list). Default: on. */
export const WORKSPACE_SHOW_PATH_KEY = "explorer-enhanced.workspace.showPath";

/** When on, the filter field runs a text search under the displayed folder (workspace state). Default: off. */
export const WORKSPACE_FILE_CONTENT_SEARCH_KEY = "explorer-enhanced.workspace.fileContentSearch";

/** Subfolders as rows in Files (workspace memento; legacy config: `fileViews.files.showFoldersInList`). */
export const WORKSPACE_SHOW_FOLDERS_IN_FILES_LIST_KEY = "explorer-enhanced.workspace.showFoldersInFilesList";

/** Files as tree items under folders (workspace memento; legacy config: `fileViews.folders.showFilesInTree`). */
export const WORKSPACE_SHOW_FILES_IN_FOLDER_TREE_KEY = "explorer-enhanced.workspace.showFilesInFolderTree";

/** `when` clause context for Folders view title actions. */
export const CONTEXT_SHOW_FILES_IN_FOLDER_TREE = "explorer-enhanced.showFilesInTree";

/** Legacy `settings.json` section (read-only migration for booleans / layout / date). */
const LEGACY_SETTINGS_SECTION = "fileViews";

export function getEnhanceExplorerConfiguration(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration("explorer-enhanced");
}

function getLegacyFileViewsConfiguration(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(LEGACY_SETTINGS_SECTION);
}

/** Pair of `settings.json` sections to cap `getConfiguration` calls per refresh. */
export interface EnhanceExplorerSettingsConfigs {
  readonly primary: vscode.WorkspaceConfiguration;
  readonly legacy: vscode.WorkspaceConfiguration;
}

export function resolveEnhanceExplorerSettingsConfigs(): EnhanceExplorerSettingsConfigs {
  return {
    primary: getEnhanceExplorerConfiguration(),
    legacy: getLegacyFileViewsConfiguration(),
  };
}

export const DATE_TIME_FORMAT_VALUES = [
  "locale",
  "localeDate",
  "localeTime",
  "iso",
  "relative",
  "custom",
] as const;
export type DateTimeFormatSetting = (typeof DATE_TIME_FORMAT_VALUES)[number];

export const VIEW_LAYOUT_VALUES = ["detail", "list", "icons"] as const;
export type ViewLayoutSetting = (typeof VIEW_LAYOUT_VALUES)[number];

export const DEFAULT_DATE_TIME_CUSTOM_PATTERN = "DD-MM-YYYY HH:mm:ss";

/**
 * Fallback storage for the custom pattern.
 * We primarily read from Settings UI (`explorer-enhanced.files.dateTimeCustomPattern`), but some users run with
 * transient/ephemeral profiles where settings can be reset (e.g. after restart). Persist last non-default value per
 * workspace to avoid “my pattern resets every morning”.
 */
const WORKSPACE_DATE_TIME_CUSTOM_PATTERN_KEY = "explorer-enhanced.workspace.dateTimeCustomPattern";

export interface FilesSettingsSnapshot {
  showGitStatus: boolean;
  showProblemsInFiles: boolean;
  showFoldersInList: boolean;
  showFilesRowLines: boolean;
  showFilesColumnLines: boolean;
  showFolderSize: boolean;
  selectActiveFile: boolean;
  highlightOpenFiles: boolean;
  /** Hint bar: show `Files: <path>` vs hide path text entirely. */
  showPath: boolean;
  /** Search file contents (Files bar toggle). */
  fileContentSearch: boolean;
  dateTimeFormat: DateTimeFormatSetting;
  dateTimeCustomPattern: string;
}

/** Single `primary` + `legacy` pass to avoid four configuration resolutions per snapshot. */
function readDateTimeFileSettings(
  workspaceState: vscode.Memento,
  primary: vscode.WorkspaceConfiguration,
  legacy: vscode.WorkspaceConfiguration
): Pick<FilesSettingsSnapshot, "dateTimeFormat" | "dateTimeCustomPattern"> {
  const primaryFormat = primary.get<string>("files.dateTimeFormat");
  let dateTimeFormat: DateTimeFormatSetting = "locale";
  if (primaryFormat && (DATE_TIME_FORMAT_VALUES as readonly string[]).includes(primaryFormat)) {
    dateTimeFormat = primaryFormat as DateTimeFormatSetting;
  } else {
    const leg = legacy.get<string>("files.dateTimeFormat");
    if (leg && (DATE_TIME_FORMAT_VALUES as readonly string[]).includes(leg)) {
      dateTimeFormat = leg as DateTimeFormatSetting;
    }
  }

  const fromCfg = primary.get<string>("files.dateTimeCustomPattern");
  const fromLegacy = legacy.get<string>("files.dateTimeCustomPattern");
  const raw =
    typeof fromCfg === "string" && fromCfg.trim() !== ""
      ? fromCfg
      : typeof fromLegacy === "string"
        ? fromLegacy
        : undefined;
  const s = typeof raw === "string" ? raw.trim() : "";
  const capped = !s ? "" : s.length > 120 ? s.slice(0, 120) : s;

  // If Settings are present and not the default, remember them in workspace state.
  if (capped && capped !== DEFAULT_DATE_TIME_CUSTOM_PATTERN) {
    void workspaceState.update(WORKSPACE_DATE_TIME_CUSTOM_PATTERN_KEY, capped);
  }

  // If settings are missing/empty (or were reset to default), fall back to last known workspace value.
  const fallback = workspaceState.get<string | undefined>(WORKSPACE_DATE_TIME_CUSTOM_PATTERN_KEY);
  const coalesced = capped ? capped : fallback && fallback.trim() ? fallback.trim() : DEFAULT_DATE_TIME_CUSTOM_PATTERN;
  return { dateTimeFormat, dateTimeCustomPattern: coalesced };
}

/** Git-style default ON unless explicitly `false`; toggles use strict booleans in memento. */
type LegacyBoolMode = "defaultTrueUnlessFalse" | "defaultFalseUnlessTrue";

function readBoolMementoWithLegacy(
  workspaceState: vscode.Memento,
  mementoKey: string,
  legacyConfigRelativeKey: string,
  mode: LegacyBoolMode,
  configs?: EnhanceExplorerSettingsConfigs
): boolean {
  const stored = workspaceState.get<boolean | undefined>(mementoKey);
  if (stored !== undefined) {
    return mode === "defaultFalseUnlessTrue" ? stored === true : stored !== false;
  }
  const primary = configs?.primary ?? getEnhanceExplorerConfiguration();
  const legacy = configs?.legacy ?? getLegacyFileViewsConfiguration();
  const primaryRaw = primary.get<boolean | undefined>(legacyConfigRelativeKey);
  const legacyRaw = legacy.get<boolean | undefined>(legacyConfigRelativeKey);
  const raw = primaryRaw !== undefined ? primaryRaw : legacyRaw;
  const resolved =
    mode === "defaultFalseUnlessTrue" ? raw === true : raw !== false;
  void workspaceState.update(mementoKey, resolved);
  return resolved;
}

export function getShowFoldersInFilesListFromWorkspaceState(
  workspaceState: vscode.Memento,
  configs?: EnhanceExplorerSettingsConfigs
): boolean {
  return readBoolMementoWithLegacy(
    workspaceState,
    WORKSPACE_SHOW_FOLDERS_IN_FILES_LIST_KEY,
    "files.showFoldersInList",
    "defaultFalseUnlessTrue",
    configs
  );
}

export function setShowFoldersInFilesList(
  workspaceState: vscode.Memento,
  value: boolean
): Thenable<void> {
  return workspaceState.update(WORKSPACE_SHOW_FOLDERS_IN_FILES_LIST_KEY, value);
}

export function getShowGitInFilesFromWorkspaceState(
  workspaceState: vscode.Memento,
  configs?: EnhanceExplorerSettingsConfigs
): boolean {
  return readBoolMementoWithLegacy(
    workspaceState,
    WORKSPACE_SHOW_GIT_IN_FILES_KEY,
    "files.showGitStatus",
    "defaultTrueUnlessFalse",
    configs
  );
}

export function setShowGitInFiles(workspaceState: vscode.Memento, value: boolean): Thenable<void> {
  return workspaceState.update(WORKSPACE_SHOW_GIT_IN_FILES_KEY, value);
}

/** Default `true` when unset (first run). */
export function getShowProblemsInFilesFromWorkspaceState(workspaceState: vscode.Memento): boolean {
  const v = workspaceState.get<boolean | undefined>(WORKSPACE_SHOW_PROBLEMS_IN_FILES_KEY);
  if (v !== undefined) {
    return v === true;
  }
  return true;
}

export function setShowProblemsInFiles(workspaceState: vscode.Memento, value: boolean): Thenable<void> {
  return workspaceState.update(WORKSPACE_SHOW_PROBLEMS_IN_FILES_KEY, value);
}

/** Default `false` when unset (first run). */
export function getShowFilesRowLinesFromWorkspaceState(workspaceState: vscode.Memento): boolean {
  const v = workspaceState.get<boolean | undefined>(WORKSPACE_SHOW_FILES_ROW_LINES_KEY);
  if (v !== undefined) {
    return v === true;
  }
  return false;
}

export function setShowFilesRowLines(workspaceState: vscode.Memento, value: boolean): Thenable<void> {
  return workspaceState.update(WORKSPACE_SHOW_FILES_ROW_LINES_KEY, value);
}

/** Default `true` when unset (first run). */
export function getShowFilesColumnLinesFromWorkspaceState(workspaceState: vscode.Memento): boolean {
  const v = workspaceState.get<boolean | undefined>(WORKSPACE_SHOW_FILES_COLUMN_LINES_KEY);
  if (v !== undefined) {
    return v === true;
  }
  return true;
}

export function setShowFilesColumnLines(
  workspaceState: vscode.Memento,
  value: boolean
): Thenable<void> {
  return workspaceState.update(WORKSPACE_SHOW_FILES_COLUMN_LINES_KEY, value);
}

/** Default `false` when unset (first launch). */
export function getShowFolderSizeFromWorkspaceState(workspaceState: vscode.Memento): boolean {
  return workspaceState.get<boolean>(WORKSPACE_SHOW_FOLDER_SIZE_KEY) === true;
}

export function setShowFolderSize(workspaceState: vscode.Memento, value: boolean): Thenable<void> {
  return workspaceState.update(WORKSPACE_SHOW_FOLDER_SIZE_KEY, value);
}

/** Default true when unset. */
export function getSelectActiveFileFromWorkspaceState(workspaceState: vscode.Memento): boolean {
  const v = workspaceState.get<boolean | undefined>(WORKSPACE_SELECT_ACTIVE_FILE_KEY);
  if (v !== undefined) {
    return v === true;
  }
  return true;
}

export function setSelectActiveFile(
  workspaceState: vscode.Memento,
  value: boolean
): Thenable<void> {
  return workspaceState.update(WORKSPACE_SELECT_ACTIVE_FILE_KEY, value);
}

export function getHighlightOpenFilesFromWorkspaceState(workspaceState: vscode.Memento): boolean {
  return workspaceState.get<boolean>(WORKSPACE_HIGHLIGHT_OPEN_FILES_KEY) === true;
}

export function setHighlightOpenFiles(
  workspaceState: vscode.Memento,
  value: boolean
): Thenable<void> {
  return workspaceState.update(WORKSPACE_HIGHLIGHT_OPEN_FILES_KEY, value);
}

/** Default `true` when unset (first run). */
export function getShowPathFromWorkspaceState(workspaceState: vscode.Memento): boolean {
  const v = workspaceState.get<boolean | undefined>(WORKSPACE_SHOW_PATH_KEY);
  if (v !== undefined) {
    return v !== false;
  }
  return true;
}

export function setShowPath(workspaceState: vscode.Memento, value: boolean): Thenable<void> {
  return workspaceState.update(WORKSPACE_SHOW_PATH_KEY, value);
}

export function getFileContentSearchFromWorkspaceState(workspaceState: vscode.Memento): boolean {
  return workspaceState.get<boolean>(WORKSPACE_FILE_CONTENT_SEARCH_KEY) === true;
}

export function setFileContentSearch(
  workspaceState: vscode.Memento,
  value: boolean
): Thenable<void> {
  return workspaceState.update(WORKSPACE_FILE_CONTENT_SEARCH_KEY, value);
}

export function getShowFilesInFolderTreeFromWorkspaceState(
  workspaceState: vscode.Memento,
  configs?: EnhanceExplorerSettingsConfigs
): boolean {
  return readBoolMementoWithLegacy(
    workspaceState,
    WORKSPACE_SHOW_FILES_IN_FOLDER_TREE_KEY,
    "folders.showFilesInTree",
    "defaultFalseUnlessTrue",
    configs
  );
}

export function setShowFilesInFolderTree(
  workspaceState: vscode.Memento,
  value: boolean
): Thenable<void> {
  return workspaceState.update(WORKSPACE_SHOW_FILES_IN_FOLDER_TREE_KEY, value);
}

export async function syncShowFilesInTreeContext(workspaceState: vscode.Memento): Promise<void> {
  await vscode.commands.executeCommand(
    "setContext",
    CONTEXT_SHOW_FILES_IN_FOLDER_TREE,
    getShowFilesInFolderTreeFromWorkspaceState(workspaceState)
  );
}

/**
 * List vs Details vs Icons for the Files webview: `workspaceState` first; if unset, one-time migrate from
 * `explorer-enhanced.files.viewLayout`, then fall back to `fileViews.files.viewLayout` in settings.json.
 */
export function getViewLayoutForFilesPane(
  workspaceState: vscode.Memento,
  configs?: EnhanceExplorerSettingsConfigs
): ViewLayoutSetting {
  const stored = workspaceState.get<string>(FILES_PANE_VIEW_LAYOUT_STATE_KEY);
  if (stored && (VIEW_LAYOUT_VALUES as readonly string[]).includes(stored)) {
    return stored as ViewLayoutSetting;
  }
  const primaryCfg = configs?.primary ?? getEnhanceExplorerConfiguration();
  const legacyCfg = configs?.legacy ?? getLegacyFileViewsConfiguration();
  const primary = primaryCfg.get<string>("files.viewLayout");
  const legacy = legacyCfg.get<string>("files.viewLayout");
  const migrated =
    primary && (VIEW_LAYOUT_VALUES as readonly string[]).includes(primary)
      ? primary
      : legacy && (VIEW_LAYOUT_VALUES as readonly string[]).includes(legacy)
        ? legacy
        : undefined;
  if (migrated) {
    void workspaceState.update(FILES_PANE_VIEW_LAYOUT_STATE_KEY, migrated);
    return migrated as ViewLayoutSetting;
  }
  return "detail";
}

export function getFilesSettingsSnapshot(
  workspaceState: vscode.Memento,
  configs?: EnhanceExplorerSettingsConfigs
): FilesSettingsSnapshot {
  const primaryCfg = configs?.primary ?? getEnhanceExplorerConfiguration();
  const legacyCfg = configs?.legacy ?? getLegacyFileViewsConfiguration();
  const pair: EnhanceExplorerSettingsConfigs = configs ?? { primary: primaryCfg, legacy: legacyCfg };
  const { dateTimeFormat, dateTimeCustomPattern } = readDateTimeFileSettings(
    workspaceState,
    primaryCfg,
    legacyCfg
  );

  const showGitStatus = getShowGitInFilesFromWorkspaceState(workspaceState, pair);
  const showProblemsInFiles = getShowProblemsInFilesFromWorkspaceState(workspaceState);
  const showFoldersInList = getShowFoldersInFilesListFromWorkspaceState(workspaceState, pair);

  const showFilesRowLines = getShowFilesRowLinesFromWorkspaceState(workspaceState);
  const showFilesColumnLines = getShowFilesColumnLinesFromWorkspaceState(workspaceState);
  const showFolderSize = getShowFolderSizeFromWorkspaceState(workspaceState);
  const selectActiveFile = getSelectActiveFileFromWorkspaceState(workspaceState);
  const highlightOpenFiles = getHighlightOpenFilesFromWorkspaceState(workspaceState);
  const showPath = getShowPathFromWorkspaceState(workspaceState);
  const fileContentSearch = getFileContentSearchFromWorkspaceState(workspaceState);

  return {
    showGitStatus,
    showProblemsInFiles,
    showFoldersInList,
    showFilesRowLines,
    showFilesColumnLines,
    showFolderSize,
    selectActiveFile,
    highlightOpenFiles,
    showPath,
    fileContentSearch,
    dateTimeFormat,
    dateTimeCustomPattern,
  };
}
