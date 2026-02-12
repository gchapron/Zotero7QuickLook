/* eslint-disable no-unused-vars */
/* global Zotero, ChromeUtils, PathUtils, IOUtils, Services */

var QuickLook = {
	id: null,
	version: null,
	rootURI: null,
	initialized: false,

	// Process state
	_proc: null,
	_isActive: false,
	_launching: false,
	_tempDir: null,
	_contactSheetBinary: null,

	// Per-window cleanup tracking
	_windowListeners: new Map(),

	log(msg) {
		Zotero.debug("QuickLook: " + msg);
	},

	init({ id, version, rootURI }) {
		if (this.initialized) return;
		this.id = id;
		this.version = version;
		this.rootURI = rootURI;
		this.initialized = true;

		// Clean up any leftover temp files from previous sessions
		this._cleanTempDir();
	},

	// ── Window management ─────────────────────────────────────────────

	addToAllWindows() {
		let windows = Zotero.getMainWindows();
		for (let win of windows) {
			if (!win.ZoteroPane) continue;
			this.addToWindow(win);
		}
	},

	removeFromAllWindows() {
		let windows = Zotero.getMainWindows();
		for (let win of windows) {
			if (!win.ZoteroPane) continue;
			this.removeFromWindow(win);
		}
	},

	addToWindow(window) {
		if (!Zotero.isMac) {
			this.log("QuickLook is only supported on macOS");
			return;
		}

		let doc = window.document;

		// Keyboard listener on items tree (capture phase to intercept
		// before VirtualizedTable's bubble-phase Space handler)
		let itemsTree = doc.getElementById("zotero-items-tree");
		if (!itemsTree) {
			this.log("Could not find zotero-items-tree");
			return;
		}

		let keydownHandler = (event) => this._onKeyDown(event, window);
		itemsTree.addEventListener("keydown", keydownHandler, true);

		let listeners = { keydownHandler, itemsTree };

		// Context menu items
		let menuPopup = doc.getElementById("zotero-itemmenu");
		if (menuPopup) {
			let menuItem = doc.createXULElement("menuitem");
			menuItem.id = "quicklook-menu-item";
			menuItem.setAttribute("label", "Quick Look");
			menuItem.addEventListener("command", () => {
				let items = window.ZoteroPane.getSelectedItems();
				if (items.length > 0) {
					this._openQuickLook(items);
				}
			});
			menuPopup.appendChild(menuItem);

			let contactMenuItem = doc.createXULElement("menuitem");
			contactMenuItem.id = "quicklook-contactsheet-menu-item";
			contactMenuItem.setAttribute("label", "Quick Look Contact Sheet");
			contactMenuItem.addEventListener("command", () => {
				let items = window.ZoteroPane.getSelectedItems();
				if (items.length > 0) {
					this._openContactSheet(items);
				}
			});
			menuPopup.appendChild(contactMenuItem);

			let popupShowHandler = () => this._onMenuShowing(doc);
			menuPopup.addEventListener("popupshowing", popupShowHandler);

			listeners.popupShowHandler = popupShowHandler;
			listeners.menuPopup = menuPopup;
		}

		this._windowListeners.set(window, listeners);
		this.log("Added to window");
	},

	removeFromWindow(window) {
		let listeners = this._windowListeners.get(window);
		if (!listeners) return;

		// Remove keyboard listener
		listeners.itemsTree.removeEventListener(
			"keydown",
			listeners.keydownHandler,
			true
		);

		// Remove context menu listener and elements
		if (listeners.menuPopup && listeners.popupShowHandler) {
			listeners.menuPopup.removeEventListener(
				"popupshowing",
				listeners.popupShowHandler
			);
		}

		let doc = window.document;
		let menuItem = doc.getElementById("quicklook-menu-item");
		if (menuItem) menuItem.remove();
		let contactMenuItem = doc.getElementById(
			"quicklook-contactsheet-menu-item"
		);
		if (contactMenuItem) contactMenuItem.remove();

		this._windowListeners.delete(window);
		this.log("Removed from window");
	},

	// ── Keyboard handling ─────────────────────────────────────────────

	_onKeyDown(event, window) {
		let isSpace =
			event.code === "Space" &&
			!event.ctrlKey &&
			!event.altKey &&
			!event.metaKey;
		let isOptionSpace =
			event.code === "Space" &&
			event.altKey &&
			!event.ctrlKey &&
			!event.metaKey;
		let isCmdY =
			event.key === "y" &&
			event.metaKey &&
			!event.ctrlKey &&
			!event.altKey;
		let isEscape = event.key === "Escape";

		// Option+Space: contact sheet mode
		if (isOptionSpace) {
			event.preventDefault();
			event.stopPropagation();

			if (this._isActive) {
				this._closeQuickLook();
			} else {
				let items = window.ZoteroPane.getSelectedItems();
				if (items.length > 0) {
					this._openContactSheet(items);
				}
			}
			return;
		}

		// Space or Cmd+Y: normal QuickLook
		if (isSpace || isCmdY) {
			event.preventDefault();
			event.stopPropagation();

			if (this._isActive) {
				this._closeQuickLook();
			} else {
				let items = window.ZoteroPane.getSelectedItems();
				if (items.length > 0) {
					this._openQuickLook(items);
				}
			}
			return;
		}

		if (isEscape) {
			if (this._isActive) {
				this._closeQuickLook();
				event.preventDefault();
				event.stopPropagation();
			}
			return;
		}
	},

	// ── Context menu ──────────────────────────────────────────────────

	_onMenuShowing(doc) {
		let menuItem = doc.getElementById("quicklook-menu-item");
		let contactMenuItem = doc.getElementById(
			"quicklook-contactsheet-menu-item"
		);
		let items = doc.defaultView.ZoteroPane.getSelectedItems();
		let hasItems = items.length > 0;

		if (menuItem) menuItem.hidden = !hasItems;

		// Only show contact sheet option if there are PDF attachments
		if (contactMenuItem) {
			contactMenuItem.hidden = !hasItems;
		}
	},

	// ── QuickLook open/close ──────────────────────────────────────────

	async _openQuickLook(items) {
		if (this._launching) return false;

		let paths = await this._getFilePaths(items);
		if (paths.length === 0) {
			this.log("No files to preview");
			return false;
		}

		await this._launchQlmanage(paths);
		return true;
	},

	async _openContactSheet(items) {
		if (this._launching) return false;

		// Get only PDF file paths
		let paths = await this._getFilePaths(items);
		let pdfPaths = paths.filter(
			(p) => p.toLowerCase().endsWith(".pdf")
		);

		if (pdfPaths.length === 0) {
			this.log("No PDF files for contact sheet");
			return false;
		}

		// Ensure the contact sheet binary is deployed
		let binary = await this._ensureContactSheetBinary();
		if (!binary) {
			this.log("Contact sheet binary not available");
			return false;
		}

		// Generate contact sheet for the first PDF
		let pdfPath = pdfPaths[0];
		let tempDir = this._getTempDirPath();
		await IOUtils.makeDirectory(tempDir, { ignoreExisting: true });
		let outputPath = PathUtils.join(tempDir, "contactsheet.html");

		const { Subprocess } = ChromeUtils.importESModule(
			"resource://gre/modules/Subprocess.sys.mjs"
		);

		this.log("Generating contact sheet for: " + pdfPath);

		try {
			let proc = await Subprocess.call({
				command: binary,
				arguments: [pdfPath, outputPath, "5", "200"],
			});
			let result = await proc.wait();
			if (result.exitCode !== 0) {
				this.log(
					"Contact sheet generation failed with code " +
						result.exitCode
				);
				return false;
			}
		} catch (e) {
			this.log("Contact sheet generation error: " + e);
			return false;
		}

		// QuickLook the generated contact sheet HTML
		await this._launchQlmanage([outputPath]);
		return true;
	},

	async _ensureContactSheetBinary() {
		if (this._contactSheetBinary) {
			if (await IOUtils.exists(this._contactSheetBinary)) {
				return this._contactSheetBinary;
			}
		}

		let tempDir = this._getTempDirPath();
		await IOUtils.makeDirectory(tempDir, { ignoreExisting: true });

		let binaryPath = PathUtils.join(tempDir, "contactsheet");

		// Check if already deployed
		if (await IOUtils.exists(binaryPath)) {
			this._contactSheetBinary = binaryPath;
			return binaryPath;
		}

		// Copy the pre-compiled binary from the plugin bundle to temp
		this.log("Deploying contact sheet binary...");

		try {
			let binaryURI = this.rootURI + "contactsheet";
			let response = await fetch(binaryURI);
			let data = await response.arrayBuffer();
			await IOUtils.write(binaryPath, new Uint8Array(data));

			// Make executable
			await IOUtils.setPermissions(binaryPath, 0o755);

			this.log("Contact sheet binary deployed");
			this._contactSheetBinary = binaryPath;
			return binaryPath;
		} catch (e) {
			this.log("Failed to deploy contact sheet binary: " + e);
			return null;
		}
	},

	async _launchQlmanage(filePaths) {
		if (this._launching) return;
		this._launching = true;

		const { Subprocess } = ChromeUtils.importESModule(
			"resource://gre/modules/Subprocess.sys.mjs"
		);

		let args = ["-p", ...filePaths];
		this.log("Launching: qlmanage " + args.join(" "));

		try {
			this._proc = await Subprocess.call({
				command: "/usr/bin/qlmanage",
				arguments: args,
			});
			this._isActive = true;

			// Monitor process exit (user may close qlmanage externally)
			this._proc.wait().then(() => {
				this.log("qlmanage exited");
				this._isActive = false;
				this._proc = null;
			});
		} catch (e) {
			this.log("Failed to launch qlmanage: " + e);
			this._isActive = false;
			this._proc = null;
		} finally {
			this._launching = false;
		}
	},

	_closeQuickLook() {
		if (this._proc) {
			this.log("Killing qlmanage");
			this._proc.kill();
			this._proc = null;
			this._isActive = false;
		}
	},

	// ── File path resolution ──────────────────────────────────────────

	async _getFilePaths(items) {
		let paths = [];

		for (let item of items) {
			if (item.isAttachment() && !item.isNote()) {
				let path = await this._getAttachmentPath(item);
				if (path) paths.push(path);
			} else if (item.isNote()) {
				let path = await this._writeNoteToTempFile(item);
				if (path) paths.push(path);
			} else {
				// Regular item: collect child attachments and notes
				let attachmentIDs = item.getAttachments(false);
				for (let attID of attachmentIDs) {
					let attachment = Zotero.Items.get(attID);
					let path = await this._getAttachmentPath(attachment);
					if (path) paths.push(path);
				}

				let noteIDs = item.getNotes(false);
				for (let noteID of noteIDs) {
					let note = Zotero.Items.get(noteID);
					let path = await this._writeNoteToTempFile(note);
					if (path) paths.push(path);
				}
			}
		}

		return paths;
	},

	async _getAttachmentPath(item) {
		if (!item.isAttachment()) return null;

		// Skip web-only attachments
		if (
			item.attachmentLinkMode ===
			Zotero.Attachments.LINK_MODE_LINKED_URL
		) {
			return null;
		}

		let path = await item.getFilePathAsync();
		if (!path) {
			this.log("No file path for attachment " + item.id);
			return null;
		}

		let exists = await IOUtils.exists(path);
		if (!exists) {
			this.log("File does not exist: " + path);

			// Try downloading synced file
			if (
				item.isImportedAttachment() &&
				Zotero.Sync.Storage.Local.getEnabledForLibrary(item.libraryID)
			) {
				try {
					this.log("Attempting to download synced file...");
					await Zotero.Sync.Runner.downloadFile(item);
					path = await item.getFilePathAsync();
					if (path && (await IOUtils.exists(path))) {
						return path;
					}
				} catch (e) {
					this.log("Download failed: " + e);
				}
			}
			return null;
		}

		return path;
	},

	// ── Note preview ──────────────────────────────────────────────────

	async _writeNoteToTempFile(item) {
		if (!item.isNote()) return null;

		let noteContent = item.getNote();
		if (!noteContent) return null;

		let title = item.getNoteTitle() || "Note";
		let safeTitle = title
			.replace(/[^a-zA-Z0-9._-]/g, "_")
			.substring(0, 100);

		let tempDir = this._getTempDirPath();
		await IOUtils.makeDirectory(tempDir, { ignoreExisting: true });

		let html =
			"<!DOCTYPE html>\n" +
			"<html>\n" +
			"<head>\n" +
			'<meta charset="UTF-8">\n' +
			"<title>" +
			this._escapeHtml(title) +
			"</title>\n" +
			"<style>\n" +
			"body { font-family: -apple-system, BlinkMacSystemFont, sans-serif;\n" +
			"       padding: 20px; max-width: 800px; margin: 0 auto; }\n" +
			"</style>\n" +
			"</head>\n" +
			"<body>\n" +
			noteContent +
			"\n</body>\n" +
			"</html>";

		let filePath = PathUtils.join(tempDir, safeTitle + ".html");
		if (await IOUtils.exists(filePath)) {
			filePath = PathUtils.join(
				tempDir,
				safeTitle + "_" + Date.now() + ".html"
			);
		}

		await IOUtils.writeUTF8(filePath, html);
		this.log("Wrote note to: " + filePath);

		return filePath;
	},

	_getTempDirPath() {
		if (!this._tempDir) {
			let base = Zotero.getTempDirectory().path;
			this._tempDir = PathUtils.join(base, "QuickLook");
		}
		return this._tempDir;
	},

	_escapeHtml(str) {
		return str
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;");
	},

	// ── Shutdown ──────────────────────────────────────────────────────

	shutdown() {
		this._closeQuickLook();
		this._cleanTempDir();
		this.initialized = false;
	},

	async _cleanTempDir() {
		if (this._tempDir) {
			try {
				await IOUtils.remove(this._tempDir, { recursive: true });
				this.log("Cleaned temp directory");
			} catch (e) {
				// Temp dir may not exist yet, that's fine
			}
			this._tempDir = null;
		}
	},
};
