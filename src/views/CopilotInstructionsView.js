'use strict';

const vscode = require('vscode');
const { CopilotInstructionsManager } = require('../commands/CopilotInstructionsManager');

// ─── Tree item context values ─────────────────────────────────────────────────
const CTX_FILE_EXISTS  = 'aemCopilotInstructionsExists';
const CTX_FILE_MISSING = 'aemCopilotInstructionsMissing';

// ─── Item classes ─────────────────────────────────────────────────────────────

class InstructionsStatusItem extends vscode.TreeItem {
  constructor(exists, lastModified) {
    const label = exists ? 'copilot-instructions.md' : 'Not generated yet';
    super(label, vscode.TreeItemCollapsibleState.None);

    this.contextValue = exists ? CTX_FILE_EXISTS : CTX_FILE_MISSING;
    this.iconPath     = new vscode.ThemeIcon(exists ? 'check' : 'circle-slash');

    if (exists) {
      const relPath = '.github/copilot-instructions.md';
      this.description   = lastModified
        ? `updated ${_formatAge(lastModified)}`
        : relPath;
      this.tooltip       = new vscode.MarkdownString(
        `**${relPath}**\n\nGitHub Copilot reads this file automatically for every response in this workspace.\n\n` +
        (lastModified ? `Last updated: ${lastModified.toLocaleString()}` : '')
      );
      // Click → open the file
      this.command = {
        command: 'aem-copilot.openCopilotInstructions',
        title: 'Open copilot-instructions.md'
      };
    } else {
      this.description = 'click Generate to create';
      this.tooltip     = new vscode.MarkdownString(
        'No `.github/copilot-instructions.md` found.\n\n' +
        'Click **Generate** to scan your workspace and create the file automatically.'
      );
    }
  }
}

class ActionItem extends vscode.TreeItem {
  constructor(label, icon, command, tooltip) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.iconPath     = new vscode.ThemeIcon(icon);
    this.tooltip      = tooltip;
    this.command      = { command, title: label };
    this.contextValue = 'aemCopilotAction';
  }
}

// ─── Helper ───────────────────────────────────────────────────────────────────

function _formatAge(date) {
  const diffMs = Date.now() - date.getTime();
  const mins   = Math.floor(diffMs / 60_000);
  if (mins < 1)   return 'just now';
  if (mins < 60)  return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ─── Tree data provider ───────────────────────────────────────────────────────

class CopilotInstructionsView {
  constructor() {
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData  = this._onDidChangeTreeData.event;

    // Re-render when the file is saved or workspace changes
    vscode.workspace.onDidSaveTextDocument(doc => {
      if (doc.uri.fsPath.endsWith('copilot-instructions.md')) {
        this.refresh();
      }
    });
    vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh());
  }

  refresh() {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element) {
    return element;
  }

  async getChildren(element) {
    if (element) return []; // no children on any item

    const exists       = await CopilotInstructionsManager.exists();
    const lastModified = exists ? await CopilotInstructionsManager.lastModified() : null;

    const items = [new InstructionsStatusItem(exists, lastModified)];

    if (exists) {
      items.push(
        new ActionItem(
          'Sync',
          'sync',
          'aem-copilot.syncCopilotInstructions',
          'Re-scan workspace and refresh the auto-generated project section'
        ),
        new ActionItem(
          'Open',
          'go-to-file',
          'aem-copilot.openCopilotInstructions',
          'Open copilot-instructions.md in the editor'
        )
      );
    } else {
      items.push(
        new ActionItem(
          'Generate',
          'sparkle',
          'aem-copilot.generateCopilotInstructions',
          'Scan workspace and create .github/copilot-instructions.md'
        )
      );
    }

    return items;
  }
}

module.exports = { CopilotInstructionsView };
