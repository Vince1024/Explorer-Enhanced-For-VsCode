# Changelog

All notable changes to **Explorer Enhanced** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Release entries are **newest first** (recommended by Keep a Changelog). Older bullets may reference git tags `v0.0.1`–`v0.0.8` (commit SHAs in parentheses); **`v1.0.0`** is the first stable major line.

## [1.0.0] - 2026-04-04

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
