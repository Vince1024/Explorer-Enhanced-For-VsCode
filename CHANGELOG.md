# Changelog

All notable changes to **Explorer Enhanced** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> [!NOTE]
> Release entries are **newest first** (recommended by Keep a Changelog). Older bullets may reference git tags `v0.0.1`–`v0.0.8` (commit SHAs in parentheses); **`v1.0.1`** is the first stable major line; **patch** releases (ex. `v1.0.2`) are bumped by CI on publish.

## [1.0.3] - 2026-04-10

### Added

- **Focus on Start** (`explorer-enhanced.focusOnStart`): opt-in boolean setting (off by default). When enabled, the sidebar switches to Explorer Enhanced on every window open / reload. Uses `onStartupFinished` activation event and a progressive retry mechanism (300 ms / 800 ms / 2 s, skipped once the view is visible) so the focus command runs after VS Code finishes restoring its own UI. Not equivalent to a native "restore last Activity Bar view" — unconditionally focuses the extension (`extension.ts`, `package.json`).
- **Files** webview: **F2** (rename) and **Delete** — (1) **Webview focus:** same as the **`ctx`** menu (`filePane.js`). (2) **Editor focus** after opening a file from the pane: `package.json` keybindings on `explorer-enhanced.filesPane.renameSelection` / `deleteSelection` when `explorer-enhanced.filesPaneEditorKbActive` (last file opened from Files matches the active editor, or a **folder row** is selected in the list). Avoids stealing F2 from symbol rename when the context is false (`filePaneViewProvider.ts`, `extension.ts`).
- **Files** webview: opening a file from a **content search** result opens the editor’s **native Find** widget (`Ctrl+F`) **prefilled** with the same query (case-insensitive, non-regex, consistent with the scan); use F3 / Shift+F3 to move between matches (`editor.actions.findWithArgs`, `filePaneWebviewSupport.ts`).
- **Files** webview: while **content search** is active, **Select Active File** tree sync no longer calls `showFolder` on the file’s parent subfolder after `reveal`, so the recursive hit list and query are **not reset** when you open a file under a subdirectory (`extension.ts`, `filePaneViewProvider.ts`).

### Changed

- **Startup:** **`vscode.git` is not activated** until the Files pane actually needs Git badges (`showGitStatus` on) — `GitFileStatusService.ensureInitialized()` from `_showFolderFlush` (`gitFileStatusService.ts`, `filePaneViewProvider.ts`). If Git is disabled in the Files settings menu, the built-in Git extension may stay unloaded longer.
- **Startup:** removed **`extensionDependencies: ["vscode.git"]`** from `package.json` — VS Code no longer force-activates the built-in Git extension before Explorer Enhanced loads. The extension already activates `vscode.git` on demand via `ensureInitialized()` when the Git column is enabled; the hard dependency was redundant and added latency even when Git badges were off.
- **Startup:** webview shell template (`filePane.shell.html`) is **pre-loaded asynchronously** in the `FilePaneViewProvider` constructor (`fs.promises.readFile`), so the first `resolveWebviewView` usually hits the in-memory cache and skips the synchronous `fs.readFileSync` fallback (`filePaneViewProvider.ts`).
- **Startup:** recursive workspace `**/*` `FileSystemWatcher`s are registered on the **first macrotask** after `activate` (together with the existing deferred Folders/Files sync), not synchronously in `activate` — lighter handoff back to VS Code; `onDidCreateFiles` / `onDidDeleteFiles` / `onDidRenameFiles` still apply immediately. Timer cleared on extension dispose (`extension.ts`).
- **Settings:** reorganized into three ordered groups — **Explorer Enhanced** (Focus on Start), **Folders** (Folder Expand Interaction), **Files** (Date Time Format, Date Time Custom Pattern) — using VS Code's `configuration` array with `order` (`package.json`).

### Fixed

- **Files** webview: **`margin: 1px`** on **`.files-topbar`** so the filter/breadcrumb block does not sit flush against the webview edge, avoiding the workbench sash / compositor clipping the horizontal separator and right edge (`filePane.common.css`).
- **Files** webview: **native Find** after opening from **content search** keeps the **Replace** row **collapsed** (`filePaneWebviewSupport.ts`). **Do not** pass `replaceString` to `editor.actions.findWithArgs`: VS Code sets `isReplaceRevealed` when `replaceString !== undefined`, so even `""` expanded Replace.

## [1.0.2] - 2026-04-08

### Added

- **Files** webview: **single-click a folder row** (list, details, or icons) **selects** it — inactive list highlight (`files-folder-row-selected`) and **breadcrumb / path line** update to that folder’s path **without** opening it (listing stays on the current folder). Double-click still opens the folder. Cleared when you change the opened folder, click a file, or when an active editor path sync applies (`selectFolderRow` / `folderRowSelect`, `filePane.js`, `filePane.table.js`, `filePane.iconGrid.js`, `filePane.common.css`, `filePane.layout-icons.css`, `filePaneViewProvider.ts`).
- **Files** webview: **Back / Forward** (`codicon-chevron-left` / `chevron-right`) and **clickable breadcrumb** on the path row: history tracks folder navigation (tree, row open, breadcrumb); Back/Forward move within that history; segments open that folder and sync the **Folders** tree (`filePaneViewProvider.ts`, `filePaneWebviewSupport.ts` `buildFolderBreadcrumbSegments`, `filePane.shell.html`, `filePane.common.css`, `filePane.js`).
- **Files** webview: **Search in file contents** — toolbar toggle (`codicon-file-text`) next to the filter field; when on, the same field sends a **debounced** query to the extension, which scans text files under the selected folder (UTF-8, exclusions, per-file size cap, max file count — see `filePaneContentSearch.ts`). **VS Code window progress** (`withProgress`) plus a **webview overlay** (spinner) while the scan runs; listing shows matching **files** only (subfolders column hidden during content search). State persists in workspace (`filePaneSettings.ts`, `filePaneViewProvider.ts`, `filePane.menus.js`, `filePane.js`, `filePane.common.css`, shell).
- **Files** webview: **Filter by name** — instant case-insensitive substring filter on the **Name** column (all layouts); **highlights** each match in the displayed name with theme CSS variables (`--vscode-list-filterValueBackground` / `Foreground`, fallbacks to editor find-match / selection highlight). Cleared when the selected folder changes; **Esc** clears while the field is focused (`filePane.filterHighlight.js`, `filePane.table.js`, `filePane.iconGrid.js`, `filePane.common.css`, `filePane.layout-icons.css`, `filePane.js`, shell + provider).

### Fixed

- **Files** webview: opening a **folder** from the list/icons (`openFolder` / double-click) **reveals in the Folders tree first**, then **`showFolder` runs unconditionally** so the **path / breadcrumb** and listing always match the target even when `onDidChangeSelection` is late or unreliable — **without** calling `showFolder` before `reveal` (which could refresh the webview mid–double-click and break interaction) (`extension.ts` `navigateFilesToFolder`, `filePaneViewProvider.ts`).

### Changed

- **Files** webview top bar: **filter + icon toolbar on one row** (aligned); **path** on the next row with **multi-line wrap** for long paths (`filePane.shell.html`, `filePane.common.css`, `filePane.js`).
- **Files** filter field: **`type=text` + `role=searchbox`** with a visible **clear** control — `codicon-close` button inside the field (native `type=search` clear is unreliable in the webview; prior CSS mask rendered invisible). Theme via **`--vscode-icon-foreground`** / toolbar hover (`filePane.shell.html`, `filePane.common.css`, `filePane.js`).
- **Refactor (no behavior change):** `isNormalizedFsPathDescendantOrSelf` in `filePaneWebviewSupport.ts` centralizes « path under displayed folder » checks for webview messages; `filePane.js` uses `postSelectFolderRow`, `applyFolderRowSelectFromHost`, and `clearFolderRowListSelectionDomOnly` to dedupe folder-row selection logic.

## [1.0.1] - 2026-04-07

### Added

- **Folders**: drag-and-drop **workspace roots** (multi-root only) to reorder like the built-in Explorer; drop on empty tree background moves the folder to the **end**. Subfolders / file rows are not draggable (single root selected per drag).

### Changed

- **Files webview** (`filePane.columns.js`): column min/max limits come from extension boot (`MIN_DETAIL_COL_PX` / `MAX_DETAIL_COL_PX` in `filePaneWebviewSupport.ts`) so TS validation and webview clamping cannot drift; refactored resize and fourth-column width logic (`tripleAfterEdgeDrag`, `setFourthColGitProb`).

## [0.0.9] - 2026-04-03

### Added

- **Folders**: setting `explorer-enhanced.folders.folderExpandInteraction` (`inherit` | `doubleClick` | `singleClick`) to optionally sync **`workbench.tree.expandMode`** at **workspace** scope — **double-click** mode gives Explorer-like behavior (single click selects a folder; **twistie (`>`)** or **double-click** on the name expands/collapses). **File** rows in the tree still open on single click (VS Code limitation for `TreeItem.command`).

### Changed

- **Performance (Git)**: precompute `changedFileKeys` for `gitChangesMayAffectFolder` instead of rebuilding a `Set` from four maps on every folder check (`4e10063`). _Not yet tagged; current `main` after `v0.0.8`._
- **Files webview**: shared `resources/filePane.gitBadges.js` for incoming/local Git badge markup (table + icon layout); minor CSS consolidation for `.git-incoming-pair`.

## [0.0.8] - 2026-04-02

### Fixed

- **Git path keys**: align lookup keys between the Git extension and filesystem paths (e.g. `%20` vs space, Windows case) so status and incoming decorations match listed files (`5bcca19`).

## [0.0.7] - 2026-04-02

### Fixed

- **Settings**: workspace fallback for `dateTimeCustomPattern` when settings are reset (`a7a7e7a`).

## [0.0.6] - 2026-04-02

### Added

- **Git in Files**: dual badges for working tree and index (staged), merge/conflict handling, and **incoming (upstream)** indicators aligned with the built-in Explorer (`12e42e8`). Depends on the built-in `vscode.git` extension.

## [0.0.5] - 2026-04-01

### Fixed

- **CI / publishing**: `package.json` `version` is aligned with the `VERSION` input before packaging the VSIX so Open VSX and the Visual Studio Marketplace use the same version (`8fa373a`).

## [0.0.4] - 2026-04-01

### Fixed

- **CI / publishing**: Open VSX publish uses `OVSX_PAT` so the token is not confused with `ovsx`’s `-t` / `--target` flag (`756554f`).

## [0.0.3] - 2026-04-01

### Fixed

- **Symlinks**: folders and files that are symbolic links are listed correctly by masking `FileType` like the native Explorer (`4381dff`).

## [0.0.2] - 2026-04-01

### Fixed

- **Debug / F5**: explicit `preLaunchTask` (`npm: compile`) and default build configuration (`0d8044f`).

## [0.0.1] - 2026-04-01

### Added

- Initial extension: activity bar container, folder tree view, **Files** webview (table: name, modified, size, status), codicon-based toolbar, and CI publishing to the Visual Studio Marketplace and Open VSX (`f09e4ce`).
