'use strict';

const vscode = require('vscode');
const path = require('path');
const { LibraryScanner } = require('../scanner/LibraryScanner');

// ─── Tree item context values (used in package.json menu whens) ──────────────
const CTX_CATEGORY  = 'aemLibraryCategory';
const CTX_SKILL     = 'aemLibrarySkill';
const CTX_AGENT     = 'aemLibraryAgent';
const CTX_GUIDE     = 'aemLibraryGuide';
const CTX_EMPTY     = 'aemLibraryEmpty';

// ─── Item classes ─────────────────────────────────────────────────────────────

class CategoryItem extends vscode.TreeItem {
  constructor(label, type, count, collapsibleState = vscode.TreeItemCollapsibleState.Expanded) {
    super(`${label}  (${count})`, collapsibleState);
    this.type        = type;
    this.contextValue = CTX_CATEGORY;

    const icons = { skills: 'symbol-method', agents: 'robot', guides: 'book' };
    this.iconPath = new vscode.ThemeIcon(icons[type] || 'folder');
  }
}

class EntryItem extends vscode.TreeItem {
  constructor(entry, type) {
    super(entry.name, vscode.TreeItemCollapsibleState.None);
    this.entry        = entry;
    this.entryType    = type;
    this.description  = entry.description;
    this.tooltip      = new vscode.MarkdownString(
      `**${entry.name}**\n\n${entry.description}\n\n*Topic:* ${entry.topic || '—'}${
        entry.tags && entry.tags.length ? `\n\n*Tags:* ${entry.tags.join(', ')}` : ''
      }${
        type === 'agents' ? `\n\n*Model:* ${entry.model || 'claude-sonnet-4-6'}` : ''
      }`
    );
    this.contextValue = type === 'skills' ? CTX_SKILL
                      : type === 'agents' ? CTX_AGENT
                      : CTX_GUIDE;

    if (entry.path) {
      this.command = {
        command: 'vscode.open',
        title: 'Open file',
        arguments: [vscode.Uri.file(entry.path)]
      };
    }

    const icons = { skills: 'symbol-method', agents: 'robot', guides: 'book' };
    this.iconPath = new vscode.ThemeIcon(icons[type] || 'file');

    // Badge the source so developers know local vs shared
    if (entry.source === 'shared' && entry.path) {
      this.resourceUri = vscode.Uri.file(entry.path);
    }
  }
}

class EmptyItem extends vscode.TreeItem {
  constructor(message) {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.contextValue = CTX_EMPTY;
    this.iconPath     = new vscode.ThemeIcon('info');
  }
}

// ─── Tree data provider ───────────────────────────────────────────────────────

class LibraryTreeProvider {
  constructor() {
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData  = this._onDidChangeTreeData.event;
    this._library = null;

    // Re-scan when workspace folders change or settings change
    vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh());
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('aem-copilot.libraryPath')) this.refresh();
    });

    // Re-scan when any file inside .aem-library/ is saved
    vscode.workspace.onDidSaveTextDocument(doc => {
      if (doc.uri.fsPath.includes('.aem-library')) this.refresh();
    });
  }

  refresh() {
    this._library = null;
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element) {
    return element;
  }

  async getChildren(element) {
    if (!element) {
      return this._getRootCategories();
    }

    if (element instanceof CategoryItem) {
      return this._getEntriesForCategory(element.type);
    }

    return [];
  }

  async _loadLibrary() {
    if (!this._library) {
      this._library = await LibraryScanner.scan();
    }
    return this._library;
  }

  async _getRootCategories() {
    const lib = await this._loadLibrary();

    const isEmpty =
      lib.skills.length === 0 &&
      lib.agents.length === 0 &&
      lib.guides.length === 0;

    if (isEmpty) {
      return [
        new EmptyItem('No library found — click + to create your first entry'),
        new EmptyItem('Or add .aem-library/ to your workspace root')
      ];
    }

    const collapsed = vscode.TreeItemCollapsibleState.Collapsed;
    const expanded  = vscode.TreeItemCollapsibleState.Expanded;

    return [
      new CategoryItem('Skills', 'skills', lib.skills.length),
      new CategoryItem('Agents', 'agents', lib.agents.length),
      new CategoryItem('Guides', 'guides', lib.guides.length,
        lib.guides.length > 0 ? expanded : collapsed)
    ];
  }

  async _getEntriesForCategory(type) {
    const lib = await this._loadLibrary();
    const entries = lib[type] || [];

    if (entries.length === 0) {
      const typeLabel = type.slice(0, -1); // 'skills' → 'skill'
      return [new EmptyItem(`No ${typeLabel}s yet — click + to create one`)];
    }

    return entries.map(entry => new EntryItem(entry, type));
  }

  // ── Public helpers used by LibraryCommands ──────────────────────────────────

  /**
   * Returns the resolved write target for new files: prefers local .aem-library/,
   * falls back to the shared libraryPath if configured.
   */
  static async resolveWriteRoot(type) {
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
      return path.join(folders[0].uri.fsPath, '.aem-library', type);
    }

    const config = vscode.workspace.getConfiguration('aem-copilot');
    const shared = config.get('libraryPath', '').trim();
    if (shared) {
      return path.isAbsolute(shared)
        ? path.join(shared, type)
        : path.join(folders[0].uri.fsPath, shared, type);
    }

    return null;
  }
}

module.exports = { LibraryTreeProvider, CategoryItem, EntryItem };
