<p align="center">
  <a href="https://github.com/Vince1024/Explorer-Enhanced-For-VsCode/releases/latest"><img src="https://img.shields.io/github/v/release/Vince1024/Explorer-Enhanced-For-VsCode?sort=semver&style=for-the-badge&label=release&logo=github" alt="Latest GitHub release" /></a>
  <img src="https://img.shields.io/badge/VS%20Code-%5E1.85.0-1e1e1e?style=for-the-badge&logo=visualstudiocode&logoColor=white" alt="VS Code engine" />
  <img src="https://img.shields.io/badge/platform-VS%20Code%20%7C%20Cursor-2d2d2d?style=for-the-badge" alt="Platform" />
</p>
<p align="center"><sub>Le badge <strong>release</strong> suit la dernière <strong>GitHub Release</strong> (workflow CI). Le <code>version</code> dans <code>package.json</code> est la base locale ; la publication peut l’incrémenter.</sub></p>

<h1 align="center">Explorer Enhanced</h1>

<p align="center">
  <strong>Folder-first</strong> sidebar navigation: a <strong>Folders</strong> tree view and a <strong>Files</strong> webview (table or grid: name, modified time, size, optional Git and Problems), with a codicon-style toolbar, without replacing the built-in Explorer.
</p>

<p align="center">
  <a href="https://github.com/Vince1024/Explorer-Enhanced-For-VsCode">GitHub</a>
  &nbsp;·&nbsp;
  <a href="#screenshots">Screenshots</a>
  &nbsp;·&nbsp;
  <a href="#features">Features</a>
  &nbsp;·&nbsp;
  <a href="#getting-started">Getting started</a>
  &nbsp;·&nbsp;
  <a href="#settings">Settings</a>
  &nbsp;·&nbsp;
  <a href="#development">Development</a>
</p>

<br />

## Screenshots

### Folders View

<p align="center">
  <img src="images/Folders-View.png" alt="Explorer Enhanced: Folders and Files (Details layout)" width="50%" />
</p>
<p align="center"><sub><em><strong>Details</strong> layout: Folders tree + Files table (name, modified, size). Optional <code>images/overview.png</code> can be added later for a wider marketing shot.</em></sub></p>

### Files Views

<table>
  <tr>
    <td align="center" width="30%">
      <img src="images/Files-Icons-View.png" alt="Files — Icons layout" width="90%" /><br />
      <sub><strong>Icons</strong>: name, size, Git/Problems per toggles.</sub>
    </td>
    <td align="center" width="30%">
      <img src="images/Files-List-View.png" alt="Files — List layout" width="90%" /><br />
      <sub><strong>List</strong>: compact row (name + indicators depending on options).</sub>
    </td>
    <td align="center" width="30%">
      <img src="images/Files-Detail-View.png" alt="Files — Details layout" width="90%" /><br />
      <sub><strong>Details</strong>: name, modified, size; Git/Problems columns per toggles, column widths.</sub>
    </td>
  </tr>
</table>

## Features

| Feature | Comment|
|:---|:-------|
| **Tree** | Workspace roots and multi-root workspaces; collapsible folders; optional <strong>files under folder nodes</strong> (Explorer-style), toggled from the view title and commands. |
| **Files** | **List**, **Details**, or **Icons**; sortable columns/rows; toolbar + path bar toggles (layout, subfolders in the list, Git, Problems, and other display options). With subfolders listed, <strong>double-click</strong> a folder row to drill into it. |
| **Look and feel** | <strong>Modified</strong> column formats from Settings (`locale`, `localeDate`, `localeTime`, `iso`, `relative`, <code>custom</code> pattern). Optional <strong>row/column guides</strong>, <strong>hide path</strong> in the hint line, and <strong>recursive folder size</strong> for folder rows (heavier disk I/O). In **Details**, draggable column widths; in **List**, adjustable name vs. status width—both <strong>persist per workspace</strong>. |
| **Git** | Badges / states when the built-in Git extension reports SCM data (can be turned off from the webview). |
| **Problems** | Counts or indicators from workspace diagnostics (can be turned off from the webview). |
| **Sync** | Selecting a folder in <strong>Folders</strong> drives <strong>Files</strong>. Optional <strong>follow active editor</strong> (reveal in the tree + keep Files in step) and <strong>highlight</strong> rows for files that still have editor tabs—workspace toggles. |
| **Actions** | Codicon <strong>toolbar</strong> in <strong>Files</strong>. <strong>Context menus</strong> on <strong>Folders</strong> and on <strong>Files</strong> rows: open (and open to side), reveal in Explorer / OS, integrated terminal, cut/copy/paste, compare, rename, delete, and other Explorer-aligned commands where available. |

## Getting started

1. Open a **folder** or multi-root **workspace**.
2. Click the **Explorer Enhanced** icon in the **activity bar** (folder glyph).
3. In **Folders**, select a folder: **Files** lists its immediate children (and optional flat subfolder rows when enabled).
4. Open a file from the table; with subfolders listed, **double-click** a folder row to drill in.

**Command Palette:** run **Explorer Enhanced: Show** (`explorer-enhanced.focus`) to reveal the container and focus **Folders**.

## Settings

### Declared in Settings UI (`explorer-enhanced.*`)

These keys are defined in `package.json`:

| Key | Role |
|:-----|:------|
| `explorer-enhanced.files.dateTimeFormat` | **Modified** column format: `locale`, `localeDate`, `localeTime`, `iso`, `relative`, `custom`. |
| `explorer-enhanced.files.dateTimeCustomPattern` | Pattern when format is `custom` (see the in-product setting description). |

### Stored in workspace state (no dedicated settings row for these toggles)

The following toggles live in **workspace state** (and may be migrated once from legacy `fileViews.*` keys in `settings.json` if still present):

| Topic | Legacy `fileViews` key (migration) | Behavior |
|:-------|:-------------------------------------|:----------|
| Git column / status | `fileViews.files.showGitStatus` | On by default unless explicitly turned off. |
| Problems in Files | — | On by default; toggle from the webview. |
| Subfolders as rows in Files | `fileViews.files.showFoldersInList` | Off until enabled. |
| Files under folder nodes | `fileViews.folders.showFilesInTree` | Off by default; also **Folders** title-bar commands. |
| Row separator lines | — | Default: off. |
| Recursive folder size | — | Default: off (heavier disk scan). |
| Files layout (List / Details / Icons) | `fileViews.files.viewLayout` | Migrated once into workspace state; `explorer-enhanced.files.viewLayout` is read first when memento is empty. |

**Details** column widths are draggable and **persist per workspace**.

<details>
<summary><strong>Commands</strong> (click to expand)</summary>

| ID | Title |
|:----|:--------|
| `explorer-enhanced.focus` | Explorer Enhanced: Show |
| `explorer-enhanced.showFoldersInList` | Show subfolders in Files list |
| `explorer-enhanced.hideFoldersInList` | Hide subfolders in Files list |
| `explorer-enhanced.viewLayout.list` | List |
| `explorer-enhanced.viewLayout.detail` | Details |
| `explorer-enhanced.viewLayout.icons` | Icons |
| `explorer-enhanced.folders.showFilesInTree` | Show files in Folders tree |
| `explorer-enhanced.folders.hideFilesInTree` | Hide files in Folders tree (folders only) |

**Folders** context menu: New File / Folder, Refresh, Reveal in Explorer / OS, Open in Integrated Terminal, Copy Path / Relative Path, Rename, Delete.

</details>

## Requirements

- **VS Code** `^1.85.0` (see `package.json` → `engines`).
- A **workspace folder** (empty window shows a hint in **Folders**).
- **Git column:** built-in **Git** extension enabled and a repository detected.

## Development

```bash
npm install
npm run lint       # ESLint (TypeScript, type-aware rules)
npm run lint:fix   # same + auto-fix where applicable
npm run compile    # one-off build
npm run watch      # TypeScript watch
npm run package    # vsce package (runs prepublish compile)
```

**CI:** on every **push** and **pull request**, [`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs `npm ci`, `npm run lint`, and `npm run compile`.

**Publish (Visual Studio Marketplace):** pushes to **`main`** or **`master`** trigger [`.github/workflows/Publish.yml`](.github/workflows/Publish.yml) (semver tag + `vsce publish`). Configure repository secrets `VSCE_TOKEN` and `PAT_TOKEN` as described in that workflow file.

## License

Add a `LICENSE` file and a one-line note here before public publishing (e.g. MIT).

---

## Marketplace

Extension ID: `Vincent1024.explorer-enhanced`.
