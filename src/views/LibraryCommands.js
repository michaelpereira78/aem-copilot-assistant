'use strict';

const vscode = require('vscode');
const path = require('path');
const { LibraryTreeProvider } = require('./LibraryTreeProvider');

// ─── File templates ───────────────────────────────────────────────────────────

function skillTemplate(name) {
  return `---
name: ${name}
description: Brief one-line description of what this skill does
topic: components
tags: [scaffold]
---

# Skill: ${name}

Describe what this skill produces and when to use it.

## Required files

List every file to generate here.

## Properties / fields

Define what the output must contain.

## Verification checklist

- [ ] Step 1
- [ ] Step 2
- [ ] Step 3
`;
}

function agentTemplate(name) {
  return JSON.stringify(
    {
      name,
      description: 'Brief one-line description of what this agent does',
      topic: 'review',
      tags: ['review'],
      model: 'claude-sonnet-4-6',
      tools: ['Read', 'Grep', 'Glob'],
      instructions: `You are an AEM 6.5 expert specialising in [domain].\n\nWhen invoked, [describe what the agent does and what input it expects].\n\nCHECKLIST:\n- [ ] Item 1\n- [ ] Item 2\n\nOUTPUT FORMAT:\n\n## Summary\nOne-sentence verdict.\n\n## Findings\nTable: Severity | Finding | Fix\n\n## Corrected code\nFenced blocks for issue-level findings only.`
    },
    null,
    2
  );
}

function guideTemplate(name) {
  return `---
name: ${name}
description: Brief one-line description of this guide
topic: deployment
tags: [reference]
---

# Guide: ${name}

Reference content here — checklists, pattern descriptions, team rules, etc.

## Section 1

Content.

## Section 2

Content.
`;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function ensureDir(dirPath) {
  const uri = vscode.Uri.file(dirPath);
  try {
    await vscode.workspace.fs.createDirectory(uri);
  } catch (_) {}
}

async function writeFile(filePath, content) {
  const uri = vscode.Uri.file(filePath);
  await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
  return uri;
}

async function resolveWriteDir(type) {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    vscode.window.showErrorMessage('AEM Library: No workspace folder open. Open your AEM project first.');
    return null;
  }
  return path.join(folders[0].uri.fsPath, '.aem-library', type);
}

// ─── Create handlers ──────────────────────────────────────────────────────────

async function createEntry(type, provider) {
  const typeLabel = type.slice(0, -1); // 'skills' → 'skill'
  const ext = type === 'agents' ? '.json' : '.md';

  const name = await vscode.window.showInputBox({
    title: `New ${typeLabel}`,
    prompt: `Enter a name for the new ${typeLabel} (kebab-case recommended, e.g. my-${typeLabel})`,
    placeHolder: `my-${typeLabel}`,
    validateInput(value) {
      if (!value || value.trim().length === 0) return 'Name is required';
      if (/\s/.test(value)) return 'No spaces — use kebab-case (e.g. my-hero-component)';
      if (/[^a-zA-Z0-9\-_]/.test(value)) return 'Only letters, numbers, hyphens, and underscores allowed';
      return null;
    }
  });

  if (!name) return; // user cancelled

  const dir = await resolveWriteDir(type);
  if (!dir) return;

  await ensureDir(dir);

  const filePath = path.join(dir, `${name}${ext}`);

  // Check for existing file
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(filePath));
    const overwrite = await vscode.window.showWarningMessage(
      `${typeLabel} "${name}" already exists. Overwrite?`,
      { modal: true }, 'Overwrite'
    );
    if (overwrite !== 'Overwrite') return;
  } catch (_) {} // doesn't exist yet — good

  const template = type === 'skills' ? skillTemplate(name)
                 : type === 'agents' ? agentTemplate(name)
                 : guideTemplate(name);

  const fileUri = await writeFile(filePath, template);
  provider.refresh();

  // Open the new file in the editor
  const doc = await vscode.workspace.openTextDocument(fileUri);
  await vscode.window.showTextDocument(doc);

  vscode.window.showInformationMessage(`Created ${typeLabel}: ${name}`);
}

// ─── Edit handler ─────────────────────────────────────────────────────────────

async function editEntry(item) {
  if (!item || !item.entry || !item.entry.path) return;
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(item.entry.path));
  await vscode.window.showTextDocument(doc);
}

// ─── Rename handler ───────────────────────────────────────────────────────────

async function renameEntry(item, provider) {
  if (!item || !item.entry || !item.entry.path) return;

  const oldPath = item.entry.path;
  const oldName = item.entry.name;
  const ext     = path.extname(oldPath);
  const dir     = path.dirname(oldPath);

  const newName = await vscode.window.showInputBox({
    title: 'Rename',
    prompt: 'New name (this also updates the name: field in the file)',
    value: oldName,
    validateInput(value) {
      if (!value || value.trim().length === 0) return 'Name is required';
      if (/\s/.test(value)) return 'No spaces — use kebab-case';
      if (value === oldName) return 'Name is unchanged';
      return null;
    }
  });

  if (!newName) return;

  const newFilePath = path.join(dir, `${newName}${ext}`);

  // Read current content and patch the name: frontmatter / json field
  const bytes   = await vscode.workspace.fs.readFile(vscode.Uri.file(oldPath));
  let content   = Buffer.from(bytes).toString('utf8');

  if (ext === '.json') {
    try {
      const parsed  = JSON.parse(content);
      parsed.name   = newName;
      content       = JSON.stringify(parsed, null, 2);
    } catch (_) {}
  } else {
    content = content.replace(/^name:\s*.+$/m, `name: ${newName}`);
  }

  await writeFile(newFilePath, content);

  // Delete the old file
  await vscode.workspace.fs.delete(vscode.Uri.file(oldPath));

  provider.refresh();
  vscode.window.showInformationMessage(`Renamed to: ${newName}`);
}

// ─── Delete handler ───────────────────────────────────────────────────────────

async function deleteEntry(item, provider) {
  if (!item || !item.entry || !item.entry.path) return;

  const confirm = await vscode.window.showWarningMessage(
    `Delete "${item.entry.name}"? This cannot be undone.`,
    { modal: true },
    'Delete'
  );

  if (confirm !== 'Delete') return;

  await vscode.workspace.fs.delete(vscode.Uri.file(item.entry.path));
  provider.refresh();
  vscode.window.showInformationMessage(`Deleted: ${item.entry.name}`);
}

// ─── Duplicate handler ────────────────────────────────────────────────────────

async function duplicateEntry(item, provider) {
  if (!item || !item.entry || !item.entry.path) return;

  const ext  = path.extname(item.entry.path);
  const dir  = path.dirname(item.entry.path);
  const base = `${item.entry.name}-copy`;

  const newName = await vscode.window.showInputBox({
    title: 'Duplicate — enter new name',
    value: base,
    validateInput(value) {
      if (!value || value.trim().length === 0) return 'Name is required';
      if (/\s/.test(value)) return 'No spaces — use kebab-case';
      return null;
    }
  });

  if (!newName) return;

  const bytes    = await vscode.workspace.fs.readFile(vscode.Uri.file(item.entry.path));
  let content    = Buffer.from(bytes).toString('utf8');

  if (ext === '.json') {
    try {
      const parsed = JSON.parse(content);
      parsed.name  = newName;
      content      = JSON.stringify(parsed, null, 2);
    } catch (_) {}
  } else {
    content = content.replace(/^name:\s*.+$/m, `name: ${newName}`);
  }

  const newPath = path.join(dir, `${newName}${ext}`);
  const fileUri = await writeFile(newPath, content);
  provider.refresh();

  const doc = await vscode.workspace.openTextDocument(fileUri);
  await vscode.window.showTextDocument(doc);
}

module.exports = {
  createEntry,
  editEntry,
  renameEntry,
  deleteEntry,
  duplicateEntry
};
