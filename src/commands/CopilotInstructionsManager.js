'use strict';

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

const GENERATED_START = '<!-- BEGIN AEM COPILOT GENERATED -->';
const GENERATED_END   = '<!-- END AEM COPILOT GENERATED -->';
const INSTRUCTIONS_REL_PATH = '.github/copilot-instructions.md';

class CopilotInstructionsManager {

  /**
   * Returns the absolute path to .github/copilot-instructions.md,
   * or null if no workspace is open.
   */
  static getFilePath() {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return null;
    return path.join(folders[0].uri.fsPath, INSTRUCTIONS_REL_PATH);
  }

  /**
   * Returns true if the file exists on disk.
   */
  static async exists() {
    const filePath = this.getFilePath();
    if (!filePath) return false;
    try {
      await fs.promises.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Returns the last-modified time of the file, or null if it doesn't exist.
   */
  static async lastModified() {
    const filePath = this.getFilePath();
    if (!filePath) return null;
    try {
      const stat = await fs.promises.stat(filePath);
      return stat.mtime;
    } catch {
      return null;
    }
  }

  // ─── Content builders ──────────────────────────────────────────────────────

  /**
   * Builds the auto-generated section (between sentinel comments) from a
   * ProjectContext produced by WorkspaceScanner.scan().
   */
  static buildGeneratedSection(ctx) {
    const lines = [GENERATED_START, ''];

    lines.push('## Project context');
    lines.push('');
    lines.push('This is an **AEM 6.5** project.');
    lines.push('');

    // ── Layout ──
    const l = ctx.projectLayout || {};
    if (l.siteName)    lines.push(`- **Site name:** \`${l.siteName}\``);
    if (l.groupId)     lines.push(`- **Maven groupId:** \`${l.groupId}\``);
    if (l.type)        lines.push(`- **Project type:** ${l.type}`);
    if (l.appsRoot)    lines.push(`- **Apps root:** \`${l.appsRoot}/apps\``);
    if (l.confRoot)    lines.push(`- **Conf root:** \`${l.confRoot}/conf\``);
    if (l.contentRoot) lines.push(`- **Content root:** \`${l.contentRoot}/content\``);
    if (l.javaSourceRoot) lines.push(`- **Java source root:** \`${l.javaSourceRoot}\``);
    lines.push(`- **Maven:** ${l.hasMaven ? 'yes' : 'no'}  |  **Frontend tooling:** ${l.hasWebpack ? 'webpack/npm' : 'none detected'}`);

    // ── Templates ──
    const t = ctx.templates || { count: 0, found: [] };
    lines.push('');
    lines.push(`### Templates (${t.count} found)`);
    if (t.namingPattern) lines.push(`_Naming pattern: ${t.namingPattern}_`);
    if (t.storageRoot)   lines.push(`_Storage: \`${t.storageRoot}\`_`);
    if (t.found && t.found.length > 0) {
      lines.push('');
      const sample = t.found.slice(0, 8);
      for (const tmpl of sample) {
        lines.push(`- \`${tmpl.name}\`${tmpl.status ? ` (${tmpl.status})` : ''}`);
      }
      if (t.found.length > 8) lines.push(`- …and ${t.found.length - 8} more`);
    } else {
      lines.push('');
      lines.push('_None detected yet._');
    }

    // ── Components ──
    const c = ctx.components || { count: 0, found: [] };
    lines.push('');
    lines.push(`### Components (${c.count} found)`);
    if (c.namingPattern) lines.push(`_Naming pattern: ${c.namingPattern}_`);
    if (c.storageRoot)   lines.push(`_Storage: \`${c.storageRoot}\`_`);
    if (c.found && c.found.length > 0) {
      lines.push('');
      const sample = c.found.slice(0, 10);
      for (const comp of sample) {
        const extras = [];
        if (comp.group)      extras.push(`group: ${comp.group}`);
        if (comp.hasModel)   extras.push('has Sling Model');
        if (comp.hasDialog)  extras.push('has dialog');
        lines.push(`- \`${comp.name}\`${extras.length ? ` (${extras.join(', ')})` : ''}`);
      }
      if (c.found.length > 10) lines.push(`- …and ${c.found.length - 10} more`);
    } else {
      lines.push('');
      lines.push('_None detected yet._');
    }

    // ── Sling Models ──
    const sm = ctx.slingModels || { count: 0, found: [] };
    if (sm.found && sm.found.length > 0) {
      lines.push('');
      lines.push(`### Sling Models (${sm.found.length} found)`);
      const pkg = sm.found[0].packageName;
      if (pkg) lines.push(`_Package: \`${pkg}\`_`);
      lines.push('');
      for (const model of sm.found.slice(0, 6)) {
        lines.push(`- \`${model.className}\``);
      }
      if (sm.found.length > 6) lines.push(`- …and ${sm.found.length - 6} more`);
    }

    // ── Naming conventions ──
    const conv = ctx.conventions || {};
    if (conv.components || conv.templates || conv.javaClass) {
      lines.push('');
      lines.push('### Naming conventions');
      lines.push('');
      if (conv.components) lines.push(`- **Components:** ${conv.components}`);
      if (conv.templates)  lines.push(`- **Templates:** ${conv.templates}`);
      if (conv.javaClass)  lines.push(`- **Java classes:** ${conv.javaClass}`);
      if (conv.xmlIndent) {
        const indentLabel = conv.xmlIndent === 'tabs' ? 'tabs' : `${conv.xmlIndent} spaces`;
        lines.push(`- **XML indent:** ${indentLabel}`);
      }
    }

    lines.push('');
    lines.push(GENERATED_END);
    return lines.join('\n');
  }

  /**
   * Builds the full file content.
   *
   * If the file already exists and has sentinel comments, only the generated
   * block is replaced — all user-edited content is preserved.
   *
   * If it's a new file, the complete template (generated + static sections)
   * is written.
   */
  static async buildFileContent(ctx) {
    const generatedSection = this.buildGeneratedSection(ctx);
    const siteName = ctx.projectLayout?.siteName || 'your-site';

    const fileExists = await this.exists();
    if (fileExists) {
      const existing = await fs.promises.readFile(this.getFilePath(), 'utf-8');
      const startIdx = existing.indexOf(GENERATED_START);
      const endIdx   = existing.indexOf(GENERATED_END);

      if (startIdx !== -1 && endIdx !== -1) {
        // Replace only the generated block, leave everything else untouched
        return (
          existing.slice(0, startIdx).trimEnd() +
          '\n' + generatedSection + '\n' +
          existing.slice(endIdx + GENERATED_END.length).trimStart()
        );
      }

      // File exists but was created externally without sentinels — prepend the
      // generated section so Copilot picks it up without discarding what's there.
      return generatedSection + '\n\n' + existing;
    }

    // ── Brand-new file ────────────────────────────────────────────────────────
    return [
      '<!--',
      '  AEM Copilot Instructions',
      '  Auto-generated by the AEM Copilot Assistant VS Code extension.',
      '',
      '  • The BEGIN/END GENERATED block is refreshed automatically — do not edit inside it.',
      '  • Run "AEM Copilot: Sync Copilot Instructions" (command palette) to update',
      '    it after adding components, templates, or Sling Models.',
      '  • Add your team rules in the "Custom instructions" section at the bottom.',
      '-->',
      '',
      generatedSection,
      '',
      '## How to use AEM Copilot',
      '',
      'This workspace uses the **AEM Copilot Assistant** VS Code extension.',
      'In GitHub Copilot Chat, type `@aem` followed by a slash command:',
      '',
      '| Command | What it does |',
      '|---------|-------------|',
      '| `@aem /new-component name=x site=y` | Scaffold a component — node, HTL, Sling model, dialog |',
      '| `@aem /new-template name=x site=y` | Create an editable template under `/conf/` |',
      '| `@aem /new-theme name=x site=y` | Scaffold a ClientLib with SCSS structure |',
      '| `@aem /new-page title=x template=y` | Generate a page `.content.xml` |',
      '| `@aem /new-policy component=x template=y` | Wire a content policy to a template |',
      '| `@aem /explain topic="..."` | Plain-English AEM concept explanation |',
      '| `@aem /debug` | Diagnose errors and get a fix + verification steps |',
      '| `@aem /scan` | Show everything detected in this project |',
      '| `@aem /diff` | Compare against AEM 6.5 best practices |',
      '',
      '> The assistant scans the workspace before every response, so it always uses',
      '> the real site name, paths, naming conventions, and existing patterns.',
      '',
      '## AEM 6.5 coding rules',
      '',
      `- Use Sling Models (\`@Model\`) for all backend logic — no scriptlets`,
      `- Write HTL (Sightly) only — no JSP`,
      `- ClientLib categories must be namespaced: \`${siteName}.<purpose>\``,
      `- Dialog fields use Coral 3 / Granite UI components only`,
      `- Component nodes declare \`jcr:primaryType="cq:Component"\` in \`.content.xml\``,
      `- Never reference JCR paths that don't exist in the project`,
      `- Sling Models adapt from \`Resource\` or \`SlingHttpServletRequest\` — not both`,
      `- All generated XML must be well-formed and use the same indentation detected in the project`,
      '',
      '## Custom instructions',
      '',
      '<!-- Add your team\'s rules, standards, and reminders below.',
      '     This section is never overwritten by the sync command. -->',
      '',
    ].join('\n');
  }

  // ─── File operations ───────────────────────────────────────────────────────

  /**
   * Writes (or syncs) .github/copilot-instructions.md.
   * Creates .github/ if it doesn't exist.
   * Returns the absolute path that was written.
   */
  static async write(ctx) {
    const filePath = this.getFilePath();
    if (!filePath) throw new Error('No workspace folder is open.');

    const content = await this.buildFileContent(ctx);
    const githubDir = path.dirname(filePath);

    await fs.promises.mkdir(githubDir, { recursive: true });
    await fs.promises.writeFile(filePath, content, 'utf-8');

    return filePath;
  }

  /**
   * Opens the file in the VS Code editor.
   * If the file doesn't exist, shows an informational message.
   */
  static async open() {
    const filePath = this.getFilePath();
    if (!filePath) {
      vscode.window.showErrorMessage('AEM Copilot: No workspace folder is open.');
      return;
    }
    if (!(await this.exists())) {
      const choice = await vscode.window.showInformationMessage(
        'copilot-instructions.md does not exist yet.',
        'Generate now'
      );
      if (choice === 'Generate now') {
        await vscode.commands.executeCommand('aem-copilot.generateCopilotInstructions');
      }
      return;
    }
    await vscode.window.showTextDocument(vscode.Uri.file(filePath));
  }
}

module.exports = { CopilotInstructionsManager, INSTRUCTIONS_REL_PATH };
