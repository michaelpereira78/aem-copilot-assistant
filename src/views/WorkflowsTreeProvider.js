'use strict';

const vscode = require('vscode');
const path   = require('path');
const { LibraryScanner } = require('../scanner/LibraryScanner');

// ─── Context values ───────────────────────────────────────────────────────────
const CTX_WORKFLOW      = 'aemWorkflow';
const CTX_WORKFLOW_STEP = 'aemWorkflowStep';
const CTX_EMPTY         = 'aemWorkflowEmpty';

// ─── Icons for step entry types ───────────────────────────────────────────────
const STEP_ICONS = { agent: 'robot', skill: 'symbol-method', guide: 'book' };

// ─── Item classes ─────────────────────────────────────────────────────────────

class WorkflowItem extends vscode.TreeItem {
  constructor(workflow) {
    // Expandable so steps are visible underneath
    super(workflow.name, vscode.TreeItemCollapsibleState.Collapsed);

    this.workflow    = workflow;
    this.contextValue = CTX_WORKFLOW;
    this.iconPath    = new vscode.ThemeIcon('circuit-board');
    this.description = `${workflow.steps.length} step${workflow.steps.length !== 1 ? 's' : ''}`;

    const stepList = workflow.steps
      .map((s, i) => `${i + 1}. **${s.label}** — ${s.agent || s.skill || s.guide}${s.haltOnIssues ? ' _(halts on critical)_' : ''}`)
      .join('\n');

    this.tooltip = new vscode.MarkdownString(
      `**${workflow.name}**\n\n${workflow.description || ''}\n\n${stepList}`
    );
  }
}

class StepItem extends vscode.TreeItem {
  constructor(step, index, total) {
    const entryName = step.agent || step.skill || step.guide || '(unknown)';
    const entryType = step.agent ? 'agent' : step.skill ? 'skill' : 'guide';

    super(`${index + 1}. ${step.label}`, vscode.TreeItemCollapsibleState.None);

    this.contextValue = CTX_WORKFLOW_STEP;
    this.description  = entryName;
    this.iconPath     = new vscode.ThemeIcon(STEP_ICONS[entryType] || 'symbol-misc');

    const haltNote = step.haltOnIssues ? '\n\n⚠️ _Halts workflow on critical issues_' : '';
    this.tooltip = new vscode.MarkdownString(
      `**Step ${index + 1} of ${total}: ${step.label}**\n\n` +
      `Type: ${entryType}  |  Entry: \`${entryName}\`` +
      haltNote
    );
  }
}

class EmptyItem extends vscode.TreeItem {
  constructor(message, subMessage) {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.contextValue = CTX_EMPTY;
    this.iconPath     = new vscode.ThemeIcon('info');
    if (subMessage) this.description = subMessage;
  }
}

// ─── Tree data provider ───────────────────────────────────────────────────────

class WorkflowsTreeProvider {
  constructor() {
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData  = this._onDidChangeTreeData.event;
    this._workflows = null;

    // Re-scan when workspace or settings change
    vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh());
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('aem-copilot.libraryPath')) this.refresh();
    });

    // Re-scan when any file inside .aem-library/workflows/ is saved
    vscode.workspace.onDidSaveTextDocument(doc => {
      if (doc.uri.fsPath.includes(path.join('.aem-library', 'workflows'))) {
        this.refresh();
      }
    });
  }

  refresh() {
    this._workflows = null;
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element) {
    return element;
  }

  async getChildren(element) {
    // Root level → list all workflows
    if (!element) {
      return this._getWorkflowItems();
    }

    // Workflow item → list its steps
    if (element instanceof WorkflowItem) {
      return this._getStepItems(element.workflow);
    }

    return [];
  }

  async _loadWorkflows() {
    if (!this._workflows) {
      const lib = await LibraryScanner.scan();
      this._workflows = lib.workflows || [];
    }
    return this._workflows;
  }

  async _getWorkflowItems() {
    const workflows = await this._loadWorkflows();

    if (workflows.length === 0) {
      return [
        new EmptyItem('No agent workflows yet', 'click + or run @aem /build-workflow'),
        new EmptyItem('Add .aem-library/workflows/ to your workspace')
      ];
    }

    return workflows.map(w => new WorkflowItem(w));
  }

  _getStepItems(workflow) {
    const steps = workflow.steps || [];
    if (steps.length === 0) {
      return [new EmptyItem('No steps defined', 'edit the workflow file to add steps')];
    }
    return steps.map((step, i) => new StepItem(step, i, steps.length));
  }
}

module.exports = { WorkflowsTreeProvider, WorkflowItem };
