# Zotero QuickLook

A Zotero 7/8 plugin for macOS that lets you preview attachments with QuickLook by pressing **Space** — just like in Finder.

Spiritual successor to [ZoteroQuickLook](https://github.com/mronkko/ZoteroQuickLook), which supported Zotero 4–6 but broke with Zotero 7's new plugin architecture.

## Features

- **Space** — Toggle QuickLook preview on the selected item
- **Cmd+Y** — Alternative toggle shortcut
- **Escape** — Close the preview
- **Right-click → Quick Look** — Context menu entry
- Works with PDFs, images, HTML, and any file type that macOS QuickLook supports
- Selecting a parent item previews its first child attachment
- Notes are rendered as HTML and previewed
- Synced files that aren't downloaded locally are fetched automatically

## Requirements

- **macOS** (uses the native `qlmanage` QuickLook command)
- **Zotero 7** or later

## Installation

1. Download the latest `.xpi` file from the [Releases](https://github.com/gchapron/zotero7quicklook/releases) page
2. In Zotero, go to **Tools → Add-ons**
3. Click the gear icon → **Install Add-on From File...**
4. Select the downloaded `.xpi` file
5. Restart Zotero

## Building from source

No build system or dependencies required — the plugin is plain JavaScript.

```bash
git clone https://github.com/gchapron/zotero7quicklook.git
cd zotero7quicklook
zip -r zotero7quicklook.xpi manifest.json bootstrap.js quicklook.js prefs.js
```

The resulting `zotero7quicklook.xpi` can be installed in Zotero as described above.

## How it works

The plugin registers a keyboard listener on Zotero's items tree. When you press Space, it resolves the file path of the selected item's attachment and launches `/usr/bin/qlmanage -p <file>` as a subprocess. The subprocess handle is retained so that pressing Space again (or Escape) kills the process and closes the preview.

## License

MIT
