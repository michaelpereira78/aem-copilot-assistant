'use strict';

const vscode = require('vscode');
const path = require('path');

/**
 * LibraryScanner
 *
 * Discovers the team's shared library of Skills, Agents, and Guides from two
 * locations (merged, workspace takes precedence on name collisions):
 *
 *   1. .aem-library/ folder at the workspace root          (project-local)
 *   2. aem-copilot.libraryPath setting (absolute or        (shared team repo)
 *      workspace-relative path to a cloned shared library)
 *
 * Expected folder structure in either location:
 *   skills/    *.md  — prompt skills with YAML frontmatter
 *   agents/    *.json — Claude agent definitions
 *   guides/    *.md  — reference documentation / checklists
 *
 * Skill/guide frontmatter format:
 *   ---
 *   name: hero-component
 *   description: One-line summary shown in /list-skills
 *   topic: components          (components | templates | themes | debugging | review | deployment)
 *   tags: [scaffold, htl]
 *   ---
 *
 * Agent JSON format:
 *   { name, description, topic, tags, model, instructions }
 */
class LibraryScanner {

  /**
   * Scan both library locations and return a merged LibraryContext.
   * Never throws — returns an empty context on error.
   */
  static async scan() {
    try {
      const results = { skills: [], agents: [], guides: [], pipelines: [], sources: [] };

      // 1. Shared library from settings
      const sharedPath = LibraryScanner._resolvedSharedPath();
      if (sharedPath) {
        await LibraryScanner._scanLocation(sharedPath, results, 'shared');
      }

      // 2. Workspace-local .aem-library/ (loaded second so it overwrites shared on name collision)
      const localRoot = LibraryScanner._workspaceRoot();
      if (localRoot) {
        const localLibUri = vscode.Uri.joinPath(localRoot, '.aem-library');
        const exists = await LibraryScanner._dirExists(localLibUri);
        if (exists) {
          await LibraryScanner._scanLocation(localLibUri.fsPath, results, 'local');
          results.sources.push(localLibUri.fsPath);
        }
      }

      if (sharedPath) results.sources.unshift(sharedPath);

      // Deduplicate by name (local wins over shared)
      results.skills    = LibraryScanner._dedupeByName(results.skills);
      results.agents    = LibraryScanner._dedupeByName(results.agents);
      results.guides    = LibraryScanner._dedupeByName(results.guides);
      results.pipelines = LibraryScanner._dedupeByName(results.pipelines);

      return results;
    } catch (err) {
      return { skills: [], agents: [], guides: [], pipelines: [], sources: [], error: err.message };
    }
  }

  // ---------------------------------------------------------------------------
  // Location scanner — reads one root folder
  // ---------------------------------------------------------------------------

  static async _scanLocation(rootPath, results, source) {
    const skillsPath    = path.join(rootPath, 'skills');
    const agentsPath    = path.join(rootPath, 'agents');
    const guidesPath    = path.join(rootPath, 'guides');
    const pipelinesPath = path.join(rootPath, 'pipelines');

    const [skills, agents, guides, pipelines] = await Promise.all([
      LibraryScanner._readMarkdownDir(skillsPath, source),
      LibraryScanner._readAgentsDir(agentsPath, source),
      LibraryScanner._readMarkdownDir(guidesPath, source),
      LibraryScanner._readPipelinesDir(pipelinesPath, source)
    ]);

    results.skills.push(...skills);
    results.agents.push(...agents);
    results.guides.push(...guides);
    results.pipelines.push(...pipelines);
  }

  // ---------------------------------------------------------------------------
  // Directory readers
  // ---------------------------------------------------------------------------

  static async _readMarkdownDir(dirPath, source) {
    const entries = await LibraryScanner._listDir(dirPath);
    const mdFiles = entries.filter(([name]) => name.endsWith('.md'));
    const items = [];

    for (const [filename] of mdFiles) {
      try {
        const fullPath = path.join(dirPath, filename);
        const uri = vscode.Uri.file(fullPath);
        const raw = await LibraryScanner._readFile(uri);
        if (!raw) continue;

        const { frontmatter, body } = LibraryScanner._parseFrontmatter(raw);
        const name = frontmatter.name || path.basename(filename, '.md');

        items.push({
          name,
          description: frontmatter.description || '',
          topic:       frontmatter.topic || 'general',
          tags:        LibraryScanner._parseTags(frontmatter.tags),
          body,
          path: fullPath,
          source
        });
      } catch (_) {}
    }

    return items;
  }

  /**
   * Reads agents from a directory — supports both:
   *   - New:    *.md  with YAML frontmatter (name, description, topic, tags, model, tools)
   *             and the file body as the instructions (human-readable, easy to edit)
   *   - Legacy: *.json  with { name, description, topic, tags, model, tools, instructions }
   * On a name collision within the same location, .md wins over .json.
   */
  static async _readAgentsDir(dirPath, source) {
    const entries = await LibraryScanner._listDir(dirPath);
    const items = [];
    const seenNames = new Map(); // name → index in items (md wins over json)

    // Process .md first so they take precedence
    const mdFiles   = entries.filter(([n]) => n.endsWith('.md'));
    const jsonFiles = entries.filter(([n]) => n.endsWith('.json'));

    for (const [filename] of [...mdFiles, ...jsonFiles]) {
      try {
        const fullPath = path.join(dirPath, filename);
        const uri      = vscode.Uri.file(fullPath);
        const raw      = await LibraryScanner._readFile(uri);
        if (!raw) continue;

        let item;

        if (filename.endsWith('.md')) {
          const { frontmatter, body } = LibraryScanner._parseFrontmatter(raw);
          item = {
            name:         frontmatter.name || path.basename(filename, '.md'),
            description:  frontmatter.description || '',
            topic:        frontmatter.topic || 'general',
            tags:         LibraryScanner._parseTags(frontmatter.tags),
            model:        frontmatter.model || 'claude-sonnet-4-6',
            instructions: body,
            tools:        LibraryScanner._parseTags(frontmatter.tools),
            path: fullPath,
            source
          };
        } else {
          // Legacy .json format
          const parsed = JSON.parse(raw);
          item = {
            name:         parsed.name || path.basename(filename, '.json'),
            description:  parsed.description || '',
            topic:        parsed.topic || 'general',
            tags:         LibraryScanner._parseTags(parsed.tags),
            model:        parsed.model || 'claude-sonnet-4-6',
            instructions: parsed.instructions || '',
            tools:        parsed.tools || [],
            path: fullPath,
            source
          };
        }

        // .md wins over .json for the same name — skip json if md already registered
        if (seenNames.has(item.name) && filename.endsWith('.json')) continue;

        seenNames.set(item.name, items.length);
        items.push(item);
      } catch (_) {}
    }

    return items;
  }

  static async _readPipelinesDir(dirPath, source) {
    const entries  = await LibraryScanner._listDir(dirPath);
    const jsonFiles = entries.filter(([name]) => name.endsWith('.json'));
    const items    = [];

    for (const [filename] of jsonFiles) {
      try {
        const fullPath = path.join(dirPath, filename);
        const uri      = vscode.Uri.file(fullPath);
        const raw      = await LibraryScanner._readFile(uri);
        if (!raw) continue;

        const parsed = JSON.parse(raw);
        items.push({
          name:        parsed.name        || path.basename(filename, '.json'),
          description: parsed.description || '',
          topic:       parsed.topic       || 'general',
          tags:        LibraryScanner._parseTags(parsed.tags),
          steps:       Array.isArray(parsed.steps) ? parsed.steps : [],
          path:        fullPath,
          source
        });
      } catch (_) {}
    }

    return items;
  }

  // ---------------------------------------------------------------------------
  // Frontmatter parser — handles basic YAML key: value and key: [a, b] syntax
  // ---------------------------------------------------------------------------

  static _parseFrontmatter(content) {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!match) return { frontmatter: {}, body: content.trim() };

    const frontmatter = {};
    const raw = match[1];
    const body = match[2].trim();

    for (const line of raw.split(/\r?\n/)) {
      const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
      if (!kv) continue;
      frontmatter[kv[1]] = kv[2].trim();
    }

    return { frontmatter, body };
  }

  static _parseTags(raw) {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    // Handle "[tag1, tag2]" string format
    return raw.replace(/[\[\]]/g, '').split(',').map(t => t.trim()).filter(Boolean);
  }

  // ---------------------------------------------------------------------------
  // Deduplication — last writer (local) wins on name collision
  // ---------------------------------------------------------------------------

  static _dedupeByName(items) {
    const map = new Map();
    for (const item of items) map.set(item.name, item);
    return [...map.values()];
  }

  // ---------------------------------------------------------------------------
  // Config + workspace helpers
  // ---------------------------------------------------------------------------

  static _resolvedSharedPath() {
    const config = vscode.workspace.getConfiguration('aem-copilot');
    const raw = config.get('libraryPath', '').trim();
    if (!raw) return null;

    // Resolve relative paths against workspace root
    if (path.isAbsolute(raw)) return raw;

    const root = LibraryScanner._workspaceRoot();
    if (!root) return null;
    return path.join(root.fsPath, raw);
  }

  static _workspaceRoot() {
    const folders = vscode.workspace.workspaceFolders;
    return folders && folders.length > 0 ? folders[0].uri : null;
  }

  static async _dirExists(uri) {
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      return stat.type === vscode.FileType.Directory;
    } catch (_) {
      return false;
    }
  }

  static async _listDir(dirPath) {
    try {
      const uri = vscode.Uri.file(dirPath);
      return await vscode.workspace.fs.readDirectory(uri);
    } catch (_) {
      return [];
    }
  }

  static async _readFile(uri) {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      return Buffer.from(bytes).toString('utf8');
    } catch (_) {
      return '';
    }
  }
}

module.exports = { LibraryScanner };
