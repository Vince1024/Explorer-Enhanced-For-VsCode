import { createHash } from "crypto";
import * as path from "path";
import * as vscode from "vscode";
import type { FileViewRowPayload } from "./gitFileStatusService";
import type { DateTimeFormatSetting, ViewLayoutSetting } from "./filePaneSettings";

/** Messages from the Files webview (`postMessage`). */
export interface FilePaneWebviewInboundMessage {
  type?: string;
  path?: string;
  action?: string;
  preview?: boolean;
  /** Details layout: pixel widths for Modified, Size, Status (Name uses leftover width). */
  detailColWidthsPx?: number[];
  value?: unknown;
}

export const FILE_PANE_VIEW_TYPE = "explorer-enhanced.filePane";

/** Sidebar view title from package.json; suffix with count when a folder is selected. */
export const FILES_VIEW_BASE_TITLE = "Files";

/** @deprecated Legacy detail layout: four fractional column widths (replaced by {@link WORKSPACE_DETAIL_COL_PX_KEY}). */
export const WORKSPACE_COL_FRACS_KEY = "explorer-enhanced.filePane.colFracs";

/** Detail layout: pixel widths for Modified, Size, Git/Problems (Name column is not stored; it fills the rest). */
export const WORKSPACE_DETAIL_COL_PX_KEY = "explorer-enhanced.filePane.detailColWidthsPx";

/** Detail layout: Name, Modified, Size, Status — must sum to 1 conceptually when normalized. */
export const DEFAULT_COL_FRACS: readonly [number, number, number, number] = [0.38, 0.32, 0.22, 0.08];

/** Default pixel widths when nothing is persisted (reference ~800px-wide table). */
export const DEFAULT_DETAIL_COL_PX: readonly [number, number, number] = [188, 96, 96];

/** Clamps for [Modified, Size, Status] in px; webview reads the same via boot (keep in sync automatically). */
export const MIN_DETAIL_COL_PX: readonly [number, number, number] = [20, 20, 20];
export const MAX_DETAIL_COL_PX: readonly [number, number, number] = [480, 280, 220];

function clampDetailPxComponent(value: number, index: 0 | 1 | 2): number {
  return Math.min(MAX_DETAIL_COL_PX[index], Math.max(MIN_DETAIL_COL_PX[index], Math.round(value)));
}

/**
 * Validates and clamps persisted detail column pixel triple [Modified, Size, Status].
 */
export function normalizeDetailColWidthsPx(raw: unknown): [number, number, number] | null {
  if (!Array.isArray(raw) || raw.length !== 3) {
    return null;
  }
  const x = raw[0];
  const y = raw[1];
  const z = raw[2];
  if (typeof x !== "number" || typeof y !== "number" || typeof z !== "number") {
    return null;
  }
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
    return null;
  }
  return [
    clampDetailPxComponent(x, 0),
    clampDetailPxComponent(y, 1),
    clampDetailPxComponent(z, 2),
  ];
}

/**
 * One-time migration from legacy fractional widths using a reference table width (px).
 */
export function detailColWidthsFromLegacyFracs(
  fracs: readonly [number, number, number, number],
  refTableWidthPx: number
): [number, number, number] {
  const tw = Math.max(320, refTableWidthPx);
  return [
    clampDetailPxComponent(fracs[1] * tw, 0),
    clampDetailPxComponent(fracs[2] * tw, 1),
    clampDetailPxComponent(fracs[3] * tw, 2),
  ];
}

/** Legacy only: old List % split; migrated into {@link WORKSPACE_DETAIL_COL_PX_KEY} index 2 when no other persisted widths. */
export const WORKSPACE_LIST_NAME_FRAC_KEY = "explorer-enhanced.filePane.listNameColFrac";

export const DEFAULT_LIST_NAME_COL_FRAC = 0.88;

/** Static webview assets (under extension root, see `resources/`). */
export const FILE_PANE_WEBVIEW_DIR = "resources";

export const FILE_PANE_WEBVIEW_CSS_COMMON = "filePane.common.css";
export const FILE_PANE_WEBVIEW_CSS_LAYOUT_LIST = "filePane.layout-list.css";
export const FILE_PANE_WEBVIEW_CSS_LAYOUT_DETAIL = "filePane.layout-detail.css";
export const FILE_PANE_WEBVIEW_CSS_LAYOUT_ICONS = "filePane.layout-icons.css";
export const FILE_PANE_WEBVIEW_JS = "filePane.js";
export const FILE_PANE_WEBVIEW_JS_ICONS = "filePane.icons.js";
export const FILE_PANE_WEBVIEW_JS_ICON_GRID = "filePane.iconGrid.js";
export const FILE_PANE_WEBVIEW_JS_COLUMNS = "filePane.columns.js";
export const FILE_PANE_WEBVIEW_JS_MENUS = "filePane.menus.js";
export const FILE_PANE_WEBVIEW_JS_FORMAT = "filePane.format.js";
export const FILE_PANE_WEBVIEW_JS_GIT_BADGES = "filePane.gitBadges.js";
export const FILE_PANE_WEBVIEW_JS_TABLE = "filePane.table.js";
export const FILE_PANE_WEBVIEW_SHELL = "filePane.shell.html";

export const LOCALE_COMPARE_BASE: Intl.CollatorOptions = { sensitivity: "base" };

/** Single collator for Files pane name sorting (avoids rebuilding collation tables on every `readDirectory`). */
export const FILES_NAME_COLLATOR = new Intl.Collator(undefined, LOCALE_COMPARE_BASE);

export function filesListingCacheKey(folderUri: vscode.Uri, showFoldersInList: boolean): string {
  return `${path.normalize(folderUri.fsPath)}\n${showFoldersInList ? "1" : "0"}`;
}

export function normalizeColFracs(raw: unknown): [number, number, number, number] {
  const fallback = (): [number, number, number, number] => [...DEFAULT_COL_FRACS];
  if (!Array.isArray(raw) || raw.length < 3) {
    return fallback();
  }
  let a: number;
  let b: number;
  let c: number;
  let d: number;
  if (raw.length === 3) {
    const x = raw[0];
    const y = raw[1];
    const z = raw[2];
    if (typeof x !== "number" || typeof y !== "number" || typeof z !== "number") {
      return fallback();
    }
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z) || x <= 0 || y <= 0 || z <= 0) {
      return fallback();
    }
    const take = Math.min(z * 0.28, 0.14);
    a = x;
    b = y;
    c = z - take;
    d = take;
    if (c <= 0) {
      return fallback();
    }
  } else if (raw.length === 4) {
    const x = raw[0];
    const y = raw[1];
    const z = raw[2];
    const w = raw[3];
    if (
      typeof x !== "number" ||
      typeof y !== "number" ||
      typeof z !== "number" ||
      typeof w !== "number"
    ) {
      return fallback();
    }
    if (
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      !Number.isFinite(z) ||
      !Number.isFinite(w) ||
      x <= 0 ||
      y <= 0 ||
      z <= 0 ||
      w <= 0
    ) {
      return fallback();
    }
    a = x;
    b = y;
    c = z;
    d = w;
  } else {
    return fallback();
  }
  const sum = a + b + c + d;
  if (sum <= 0) {
    return fallback();
  }
  return [a / sum, b / sum, c / sum, d / sum];
}

/** Workspace-backed detail widths, migrating from {@link WORKSPACE_COL_FRACS_KEY} or list Name|status % when needed. */
export function resolvePersistedDetailColWidths(workspaceState: vscode.Memento): [number, number, number] {
  const direct = normalizeDetailColWidthsPx(workspaceState.get(WORKSPACE_DETAIL_COL_PX_KEY));
  if (direct !== null) {
    return direct;
  }
  const hadLegacyColFracs = workspaceState.get(WORKSPACE_COL_FRACS_KEY) !== undefined;
  const legacyFracs = normalizeColFracs(workspaceState.get(WORKSPACE_COL_FRACS_KEY));
  const triple = detailColWidthsFromLegacyFracs(legacyFracs, 720);
  if (!hadLegacyColFracs) {
    const lf = workspaceState.get(WORKSPACE_LIST_NAME_FRAC_KEY);
    if (typeof lf === "number" && Number.isFinite(lf)) {
      const frac = Math.min(0.97, Math.max(0.5, lf));
      const tw = 720;
      const statusPx = clampDetailPxComponent((1 - frac) * tw, 2);
      return [triple[0], triple[1], statusPx];
    }
  }
  return triple;
}

/** Clamp List layout Name / Git split (workspace-persisted). */
export function normalizeListNameColFrac(raw: unknown): number {
  const d = typeof raw === "number" && Number.isFinite(raw) ? raw : DEFAULT_LIST_NAME_COL_FRAC;
  return Math.min(0.97, Math.max(0.5, d));
}

/**
 * @param forTrigger When true, include `data-layout-trigger` so the toolbar button can toggle visibility.
 */
export function svgExplorerViewList(hidden: boolean, forTrigger: boolean): string {
  const h = hidden ? " hidden" : "";
  const dt = forTrigger ? ' data-layout-trigger="list"' : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" class="views-ico-explorer" aria-hidden="true" focusable="false"${dt}${h}><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.25" d="M2 4h12M2 8h12M2 12h12"/></svg>`;
}

/** @param forTrigger Same as {@link svgExplorerViewList}. */
export function svgExplorerViewDetail(hidden: boolean, forTrigger: boolean): string {
  const h = hidden ? " hidden" : "";
  const dt = forTrigger ? ' data-layout-trigger="detail"' : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" class="views-ico-explorer" aria-hidden="true" focusable="false"${dt}${h}><rect x="2" y="2.25" width="3.75" height="3.25" rx="0.35" fill="currentColor"/><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.2" d="M7.5 3.875h6.5"/><rect x="2" y="6.375" width="3.75" height="3.25" rx="0.35" fill="currentColor"/><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.2" d="M7.5 8h6.5"/><rect x="2" y="10.5" width="3.75" height="3.25" rx="0.35" fill="currentColor"/><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.2" d="M7.5 12.125h6.5"/></svg>`;
}

/** @param forTrigger Same as {@link svgExplorerViewList}. */
export function svgExplorerViewIcons(hidden: boolean, forTrigger: boolean): string {
  const h = hidden ? " hidden" : "";
  const dt = forTrigger ? ' data-layout-trigger="icons"' : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" class="views-ico-explorer" aria-hidden="true" focusable="false"${dt}${h}><rect x="2" y="2" width="5" height="5" rx="0.45" fill="currentColor"/><rect x="9" y="2" width="5" height="5" rx="0.45" fill="currentColor"/><rect x="2" y="9" width="5" height="5" rx="0.45" fill="currentColor"/><rect x="9" y="9" width="5" height="5" rx="0.45" fill="currentColor"/></svg>`;
}

/**
 * Stable fingerprint of the `state` payload to skip redundant `postMessage` calls.
 * Uses incremental SHA-256 hashing (no giant concatenated string on large folders).
 */
export function statePayloadSignature(p: {
  folder: string;
  rows: FileViewRowPayload[];
  revealOsTitle: string;
  dateTimeFormat: DateTimeFormatSetting;
  dateTimeCustomPattern: string;
  showGitStatus: boolean;
  showProblemsInFiles: boolean;
  showFoldersInList: boolean;
  showFilesRowLines: boolean;
  showFilesColumnLines: boolean;
  showFolderSize: boolean;
  selectActiveFile: boolean;
  highlightOpenFiles: boolean;
  showPath: boolean;
  openEditorPaths: string[];
  viewLayout: ViewLayoutSetting;
  detailColWidthsPx: readonly [number, number, number];
}): string {
  const hash = createHash("sha256");
  const u = (s: string): void => {
    hash.update(s, "utf8");
  };
  u(p.folder);
  u("\n");
  u(p.revealOsTitle);
  u("\n");
  u(p.dateTimeFormat);
  u("\n");
  u(p.dateTimeCustomPattern);
  u("\n");
  u(
    `${p.showGitStatus ? "1" : "0"}${p.showProblemsInFiles ? "1" : "0"}${p.showFoldersInList ? "1" : "0"}${p.showFilesRowLines ? "1" : "0"}${p.showFilesColumnLines ? "1" : "0"}${p.showFolderSize ? "1" : "0"}${p.selectActiveFile ? "1" : "0"}${p.highlightOpenFiles ? "1" : "0"}${p.showPath ? "1" : "0"}${p.viewLayout}\n`
  );
  u("OPEN\t");
  u(JSON.stringify(p.openEditorPaths));
  u("\n");
  u("COL\t");
  u(JSON.stringify(p.detailColWidthsPx));
  u("\n");
  for (const r of p.rows) {
    const pend = r.folderSizePending === true ? "p" : "";
    u(r.name);
    u("\t");
    u(r.path);
    u("\t");
    u(String(r.mtime));
    u("\t");
    u(String(r.size));
    u("\t");
    u(r.kind === "folder" ? "d" : "f");
    u("\t");
    u(pend);
    u("\t");
    if (r.git) {
      u(r.git.primary.letter);
      u(":");
      u(r.git.primary.kind);
      if (r.git.secondary) {
        u(",");
        u(r.git.secondary.letter);
        u(":");
        u(r.git.secondary.kind);
      }
      if (r.git.incoming) {
        u(",in,");
        u(r.git.incoming.letter);
        u(":");
        u(r.git.incoming.kind);
      }
    }
    u("\t");
    if (r.problems) {
      u(String(r.problems.errors));
      u(";");
      u(String(r.problems.warnings));
      u(";");
      u(String(r.problems.infos));
    }
    u("\n");
  }
  return hash.digest("hex");
}

export async function openFileInEditorFromWebview(uri: vscode.Uri, preview: boolean): Promise<void> {
  try {
    await vscode.window.showTextDocument(uri, { preview });
  } catch {
    try {
      await vscode.commands.executeCommand("vscode.open", uri, { preview });
    } catch {
      void vscode.window.showErrorMessage(`Could not open: ${uri.fsPath}`);
    }
  }
}

export function buildFilePaneWebviewCsp(webview: vscode.Webview, nonce: string): string {
  return [
    "default-src 'none'",
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource}`,
    `img-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}' ${webview.cspSource}`,
  ].join("; ");
}
