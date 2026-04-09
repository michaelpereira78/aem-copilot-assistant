'use strict';

const vscode = require('vscode');
const path   = require('path');
const { LibraryScanner } = require('../scanner/LibraryScanner');

// ─── Context values ───────────────────────────────────────────────────────────
const CTX_PIPELINE      = 'aemPipeline';
const CTX_PIPELINE_STEP = 'aemPipelineStep';
const CTX_EMPTY         = 'aemPipelineEmpty';

// ─── Icons for step entry types ───────────────────────────────────────────────
const STEP_ICONS = { agent: 'robot', skill: 'symbol-method', guide: 'book' };

// ─── Item classes ─────────────────────────────────────────────────────────────

class PipelineItem extends vscode.TreeItem {
  constructor(pipeline) {
    // Expandable so steps are visible underneath
    super(pipeline.name, vscode.TreeItemCollapsibleState.Collapsed);

    this.pipeline    = pipeline;
    this.contextValue = CTX_PIPELINE;
    this.iconPath    = new vscode.ThemeIcon('circuit-board');
    this.description = `${pipeline.steps.length} step${pipeline.steps.length !== 1 ? 's' : ''}`;

    const stepList = pipeline.steps
      .map((s, i) => `${i + 1}. **${s.label}** — ${s.agent || s.skill || s.guide}${s.haltOnIssues ? ' _(halts on critical)_' : ''}`)
      .join('\n');

    this.tooltip = new vscode.MarkdownString(
      `**${pipeline.name}**\n\n${pipeline.description || ''}\n\n${stepList}`
    );
  }
}

class StepItem extends vscode.TreeItem {
  constructor(step, index, total) {
    const entryName = step.agent || step.skill || step.guide || '(unknown)';
    const entryType = step.agent ? 'agent' : step.skill ? 'skill' : 'guide';

    super(`${index + 1}. ${step.label}`, vscode.TreeItemCollapsibleState.None);

    this.contextValue = CTX_PIPELINE_STEP;
    this.description  = entryName;
    this.iconPath     = new vscode.ThemeIcon(STEP_ICONS[entryType] || 'symbol-misc');

    const haltNote = step.haltOnIssues ? '\n\n⚠️ _Halts pipeline on critical issues_' : '';
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

class PipelinesTreeProvider {
  constructor() {
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData  = this._onDidChangeTreeData.event;
    this._pipelines = null;

    // Re-scan when workspace or settings change
    vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh());
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('aem-copilot.libraryPath')) this.refresh();
    });

    // Re-scan when any file inside .aem-library/pipelines/ is saved
    vscode.workspace.onDidSaveTextDocument(doc => {
      if (doc.uri.fsPath.includes(path.join('.aem-library', 'pipelines'))) {
        this.refresh();
      }
    });
  }

  refresh() {
    this._pipelines = null;
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element) {
    return element;
  }

  async getChildren(element) {
    // Root level → list all pipelines
    if (!element) {
      return this._getPipelineItems();
    }

    // Pipeline item → list its steps
    if (element instanceof PipelineItem) {
      return this._getStepItems(element.pipeline);
    }

    return [];
  }

  async _loadPipelines() {
    if (!this._pipelines) {
      const lib = await LibraryScanner.scan();
      this._pipelines = lib.pipelines || [];
    }
    return this._pipelines;
  }

  async _getPipelineItems() {
    const pipelines = await this._loadPipelines();

    if (pipelines.length === 0) {
      return [
        new EmptyItem('No pipelines yet', 'click + or run @aem /build-pipeline'),
        new EmptyItem('Add .aem-library/pipelines/ to your workspace')
      ];
    }

    return pipelines.map(p => new PipelineItem(p));
  }

  _getStepItems(pipeline) {
    const steps = pipeline.steps || [];
    if (steps.length === 0) {
      return [new EmptyItem('No steps defined', 'edit the pipeline file to add steps')];
    }
    return steps.map((step, i) => new StepItem(step, i, steps.length));
  }
}

module.exports = { PipelinesTreeProvider, PipelineItem };
