'use strict';
(function () {
  const NS = 'http://www.w3.org/2000/svg';
  /** fill: hex string, or omit / null to use currentColor (theme icon foreground). */
  function svgIcon(pathD, fill) {
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('fill', fill != null && fill !== '' ? fill : 'currentColor');
    path.setAttribute('d', pathD);
    svg.appendChild(path);
    return svg;
  }

  const EARMARK =
    'M14 4.5V14a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V2a2 2 0 0 1 2-2h5.5L14 4.5zm-3 0A1.5 1.5 0 0 1 9.5 3V1H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V4.5h-2z';
  const BRACKETS =
    'M5.854 4.854a.5.5 0 1 0-.708-.708l-3.5 3.5a.5.5 0 0 0 0 .708l3.5 3.5a.5.5 0 0 0 .708-.708L2.707 8l3.147-3.146zm4.292 0a.5.5 0 0 1 .708-.708l3.5 3.5a.5.5 0 0 1 0 .708l-3.5 3.5a.5.5 0 0 1-.708-.708L13.293 8l-3.147-3.146z';
  const LINES =
    'M5.5 7a.5.5 0 0 0 0 1h5a.5.5 0 0 0 0-1h-5zm0 2a.5.5 0 0 0 0 1h5a.5.5 0 0 0 0-1h-5zm0 2a.5.5 0 0 0 0 1h5a.5.5 0 0 0 0-1h-5z';
  const LINES4 = LINES + 'M5.5 13a.5.5 0 0 0 0 1h5a.5.5 0 0 0 0-1h-5z';
  const PDFLINES = 'M5.5 8h5v1h-5V8zm0 2h5v1h-5v-1zm0 2h3v1h-3v-1z';
  const ZIP =
    'M3 1h4.5L11 4.5V15a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1zm0 1v12h7V5H8V2H3zm1 1h1v1H4V3zm0 2h1v1H4V5zm0 2h1v1H4V7zm0 2h1v1H4V9zm0 2h1v1H4v-1zm0 2h1v1H4v-1z';

  const PATH = {
    file: EARMARK,
    md: EARMARK + LINES,
    json: BRACKETS,
    media: EARMARK,
    pdf: EARMARK + PDFLINES,
    zip: ZIP,
    code: BRACKETS,
    text: EARMARK + LINES4,
  };

  /**
   * Hex tints roughly matching common Seti / Material-style file icons (not exact theme assets).
   * Unknown extensions use currentColor via the wrapper .file-icon.
   */
  const TINT = {
    md: '#519aba',
    json: '#cbcb41',
    yaml: '#cb7676',
    mediaRaster: '#a074c4',
    mediaSvg: '#ffb74d',
    pdf: '#e53935',
    zip: '#b67e41',
    text: '#6d8086',
    ts: '#519aba',
    js: '#cbcb41',
    html: '#e37933',
    css: '#6a9fb5',
    scss: '#f55385',
    py: '#4584b6',
    cs: '#68217a',
    xml: '#e37933',
    rs: '#dea584',
    go: '#519aba',
    java: '#cc3e44',
    vue: '#42b883',
    svelte: '#ff3e00',
    shell: '#89e051',
    sql: '#ff8787',
    cpp: '#519aba',
    vb: '#519aba',
    fs: '#378bba',
    codeDefault: '#7fdbca',
  };

  function iconForFileName(name) {
    const i = name.lastIndexOf('.');
    const ext = i >= 0 ? name.slice(i).toLowerCase() : '';
    if (ext === '.md') return { d: PATH.md, fill: TINT.md };
    if (ext === '.json') return { d: PATH.json, fill: TINT.json };
    if (['.yaml', '.yml'].includes(ext)) return { d: PATH.json, fill: TINT.yaml };
    if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp'].includes(ext)) {
      return { d: PATH.media, fill: TINT.mediaRaster };
    }
    if (ext === '.svg') return { d: PATH.media, fill: TINT.mediaSvg };
    if (ext === '.pdf') return { d: PATH.pdf, fill: TINT.pdf };
    if (['.zip', '.7z', '.rar', '.tar', '.gz'].includes(ext)) return { d: PATH.zip, fill: TINT.zip };
    if (['.txt', '.log', '.csv'].includes(ext)) return { d: PATH.text, fill: TINT.text };

    const codeMap = {
      '.ts': TINT.ts, '.tsx': TINT.ts, '.mts': TINT.ts, '.cts': TINT.ts,
      '.js': TINT.js, '.jsx': TINT.js, '.mjs': TINT.js, '.cjs': TINT.js,
      '.html': TINT.html, '.htm': TINT.html,
      '.css': TINT.css, '.scss': TINT.scss, '.less': TINT.css,
      '.xml': TINT.xml,
      '.cs': TINT.cs,
      '.py': TINT.py,
      '.rs': TINT.rs,
      '.go': TINT.go,
      '.java': TINT.java,
      '.kt': TINT.java,
      '.cpp': TINT.cpp, '.c': TINT.cpp, '.h': TINT.cpp, '.hpp': TINT.cpp,
      '.vue': TINT.vue,
      '.svelte': TINT.svelte,
      '.sh': TINT.shell, '.ps1': TINT.shell,
      '.sql': TINT.sql,
      '.csproj': TINT.cs, '.vbproj': TINT.vb,
      '.sln': TINT.cs,
      '.props': TINT.xml, '.targets': TINT.xml,
      '.vb': TINT.vb,
      '.fs': TINT.fs, '.fsx': TINT.fs,
    };
    if (codeMap[ext]) {
      return { d: PATH.code, fill: codeMap[ext] };
    }

    const codeOther = [
      '.php', '.rb', '.swift', '.dart', '.r', '.scala', '.clj', '.ex', '.exs', '.erl', '.hrl',
    ];
    if (codeOther.includes(ext)) {
      return { d: PATH.code, fill: TINT.codeDefault };
    }

    return { d: PATH.file, fill: null };
  }

  const FOLDER_ICON_D =
    'M1.75 3.5A1.25 1.25 0 0 0 .5 4.75v9.5c0 .69.56 1.25 1.25 1.25h12.5c.69 0 1.25-.56 1.25-1.25v-7.5c0-.69-.56-1.25-1.25-1.25h-5.2L7.45 3.5H1.75z';

  function iconForEntry(r) {
    if (r.kind === 'folder') return { d: FOLDER_ICON_D, fill: '#dcb67a' };
    return iconForFileName(r.name);
  }

  /**
   * Returns a ready-to-append DOM element for the entry icon.
   * Symlinks get the dedicated codicon; normal entries get the SVG icon.
   */
  function iconElementForEntry(r) {
    if (r.symlink) {
      const el = document.createElement('span');
      el.className = r.kind === 'folder'
        ? 'codicon codicon-file-symlink-directory'
        : 'codicon codicon-file-symlink-file';
      return el;
    }
    const ic = iconForEntry(r);
    return svgIcon(ic.d, ic.fill);
  }

  globalThis.FilePaneIcons = { svgIcon, iconForEntry, iconElementForEntry };
})();
