'use strict';

const vscode = require('vscode');
const path = require('path');
const { LibraryScanner } = require('./LibraryScanner');

/**
 * WorkspaceScanner
 *
 * Scans the open VS Code workspace before every command and builds a
 * ProjectContext object describing the real structure of the AEM project.
 *
 * The context is injected into every system prompt so the model generates
 * code that matches the project's actual conventions — paths, naming,
 * code style, XML patterns — rather than generic defaults.
 *
 * Scanning is intentionally silent (no progress notifications) and runs
 * on every command invocation so it always reflects the current state of
 * the workspace without requiring a manual refresh.
 */
class WorkspaceScanner {

  /**
   * Entry point. Call this at the start of every command handler.
   * Returns a ProjectContext object (never throws — returns a minimal
   * context on error so commands still work in empty workspaces).
   */
  static async scan() {
    try {
      const root = WorkspaceScanner._workspaceRoot();
      if (!root) return WorkspaceScanner._emptyContext('No workspace folder open.');

      const [
        projectLayout,
        templates,
        components,
        clientlibs,
        pages,
        slingModels,
        namingConventions,
        xmlStyle,
        library
      ] = await Promise.all([
        WorkspaceScanner._detectProjectLayout(root),
        WorkspaceScanner._scanTemplates(root),
        WorkspaceScanner._scanComponents(root),
        WorkspaceScanner._scanClientlibs(root),
        WorkspaceScanner._scanPages(root),
        WorkspaceScanner._scanSlingModels(root),
        WorkspaceScanner._inferNamingConventions(root),
        WorkspaceScanner._inferXmlStyle(root),
        LibraryScanner.scan()
      ]);

      return {
        available: true,
        root: root.fsPath,
        projectLayout,
        templates,
        components,
        clientlibs,
        pages,
        slingModels,
        namingConventions,
        xmlStyle,
        library
      };
    } catch (err) {
      return WorkspaceScanner._emptyContext(`Scan error: ${err.message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Project layout detection
  // ---------------------------------------------------------------------------

  static _workspaceRoot() {
    const folders = vscode.workspace.workspaceFolders;
    return folders && folders.length > 0 ? folders[0].uri : null;
  }

  /**
   * Detect the overall project structure by looking for tell-tale directories
   * and files. For custom/mixed structures this discovers what is actually
   * present rather than assuming a Maven archetype layout.
   */
  static async _detectProjectLayout(root) {
    const layout = {
      type: 'unknown',
      appsRoot: null,
      contentRoot: null,
      confRoot: null,
      clientlibsRoot: null,
      coreRoot: null,
      javaSourceRoot: null,
      hasMaven: false,
      hasWebpack: false,
      siteName: null,
      groupId: null
    };

    // Check for Maven
    const pomUri = vscode.Uri.joinPath(root, 'pom.xml');
    layout.hasMaven = await WorkspaceScanner._fileExists(pomUri);

    // Check for webpack / frontend tooling
    const webpackUri = vscode.Uri.joinPath(root, 'webpack.config.js');
    const packageJsonUri = vscode.Uri.joinPath(root, 'package.json');
    layout.hasWebpack =
      await WorkspaceScanner._fileExists(webpackUri) ||
      await WorkspaceScanner._fileExists(packageJsonUri);

    // Discover jcr_root locations (apps, content, conf) by globbing
    const jcrRoots = await vscode.workspace.findFiles(
      '**/jcr_root/**/.content.xml',
      '**/node_modules/**',
      50
    );

    for (const uri of jcrRoots) {
      const p = WorkspaceScanner._toForwardSlash(uri.fsPath);
      if (p.includes('/apps/') && !layout.appsRoot) {
        layout.appsRoot = WorkspaceScanner._extractUpTo(p, '/apps');
      }
      if (p.includes('/content/') && !layout.contentRoot) {
        layout.contentRoot = WorkspaceScanner._extractUpTo(p, '/content');
      }
      if (p.includes('/conf/') && !layout.confRoot) {
        layout.confRoot = WorkspaceScanner._extractUpTo(p, '/conf');
      }
    }

    // ClientLibs root — could be under apps or a separate ui.frontend path
    const clientlibFiles = await vscode.workspace.findFiles(
      '**/clientlibs/**/.content.xml',
      '**/node_modules/**',
      10
    );
    if (clientlibFiles.length > 0) {
      layout.clientlibsRoot = WorkspaceScanner._toForwardSlash(
        path.dirname(path.dirname(clientlibFiles[0].fsPath))
      );
    }

    // Java source root
    const javaFiles = await vscode.workspace.findFiles(
      '**/src/main/java/**/*.java',
      '**/node_modules/**',
      5
    );
    if (javaFiles.length > 0) {
      const javaPath = WorkspaceScanner._toForwardSlash(javaFiles[0].fsPath);
      const javaIdx = javaPath.indexOf('/src/main/java/');
      if (javaIdx !== -1) {
        layout.javaSourceRoot = javaPath.substring(0, javaIdx + '/src/main/java/'.length);
        layout.coreRoot = javaPath.substring(0, javaIdx);
      }
    }

    // Infer layout type
    if (layout.appsRoot && layout.confRoot && layout.hasMaven) {
      const hasUiApps = layout.appsRoot.includes('ui.apps');
      const hasUiContent = layout.contentRoot && layout.contentRoot.includes('ui.content');
      layout.type = hasUiApps && hasUiContent ? 'maven-multimodule' : 'maven-single';
    } else if (layout.appsRoot) {
      layout.type = 'custom';
    }

    // Infer site name from first directory under /apps/
    if (layout.appsRoot) {
      try {
        const appsUri = vscode.Uri.file(layout.appsRoot + '/apps');
        const entries = await vscode.workspace.fs.readDirectory(appsUri);
        const dirs = entries.filter(([, t]) => t === vscode.FileType.Directory);
        if (dirs.length > 0) layout.siteName = dirs[0][0];
      } catch (_) {}
    }

    // Infer groupId from first Java file package declaration
    if (javaFiles.length > 0) {
      try {
        const content = await WorkspaceScanner._readFile(javaFiles[0]);
        const match = content.match(/^package\s+([\w.]+);/m);
        if (match) {
          // Use top two segments as groupId (e.g. com.mybrand)
          layout.groupId = match[1].split('.').slice(0, 2).join('.');
        }
      } catch (_) {}
    }

    return layout;
  }

  // ---------------------------------------------------------------------------
  // Templates scanner
  // ---------------------------------------------------------------------------

  static async _scanTemplates(root) {
    const result = { found: [], storageRoot: null, namingPattern: null, count: 0 };

    const templateFiles = await vscode.workspace.findFiles(
      '**/settings/wcm/templates/*/.content.xml',
      '**/node_modules/**',
      30
    );

    if (templateFiles.length === 0) return result;

    // Derive storage root from the first template found
    const first = WorkspaceScanner._toForwardSlash(templateFiles[0].fsPath);
    const templatesIdx = first.indexOf('/templates/');
    if (templatesIdx !== -1) {
      result.storageRoot = first.substring(0, templatesIdx + '/templates'.length);
    }

    for (const uri of templateFiles) {
      const templateName = path.basename(path.dirname(uri.fsPath));
      const content = await WorkspaceScanner._readFile(uri);
      const title = WorkspaceScanner._extractXmlAttr(content, 'jcr:title') || templateName;
      const status = WorkspaceScanner._extractXmlAttr(content, 'status') || 'unknown';
      const allowedPaths = WorkspaceScanner._extractXmlAttr(content, 'allowedPaths') || '';

      // Collect child node names to understand structure
      const hasStructure = await WorkspaceScanner._fileExists(
        vscode.Uri.file(path.dirname(uri.fsPath) + '/structure/.content.xml')
      );
      const hasPolicies = await WorkspaceScanner._fileExists(
        vscode.Uri.file(path.dirname(uri.fsPath) + '/policies/.content.xml')
      );
      const hasInitial = await WorkspaceScanner._fileExists(
        vscode.Uri.file(path.dirname(uri.fsPath) + '/initial/.content.xml')
      );

      result.found.push({
        name: templateName,
        title,
        status,
        allowedPaths,
        path: path.dirname(uri.fsPath),
        hasStructure,
        hasPolicies,
        hasInitial
      });
    }

    result.count = result.found.length;

    // Infer naming pattern (kebab-case vs camelCase)
    result.namingPattern = WorkspaceScanner._inferCase(result.found.map(t => t.name));

    return result;
  }

  // ---------------------------------------------------------------------------
  // Components scanner
  // ---------------------------------------------------------------------------

  static async _scanComponents(root) {
    const result = { found: [], storageRoot: null, namingPattern: null, groups: [], count: 0 };

    const componentFiles = await vscode.workspace.findFiles(
      '**/apps/**/components/**/.content.xml',
      '**/node_modules/**',
      60
    );

    if (componentFiles.length === 0) return result;

    const first = WorkspaceScanner._toForwardSlash(componentFiles[0].fsPath);
    const componentsIdx = first.indexOf('/components/');
    if (componentsIdx !== -1) {
      result.storageRoot = first.substring(0, componentsIdx + '/components'.length);
    }

    const groupSet = new Set();

    for (const uri of componentFiles) {
      // Skip nested dialog/child nodes — only top-level component .content.xml
      const rel = path.relative(result.storageRoot || '', uri.fsPath);
      const depth = rel.split(path.sep).length;
      if (depth > 2) continue; // components/name/.content.xml = depth 2

      const content = await WorkspaceScanner._readFile(uri);
      if (!content.includes('cq:Component')) continue;

      const name = path.basename(path.dirname(uri.fsPath));
      const title = WorkspaceScanner._extractXmlAttr(content, 'jcr:title') || name;
      const group = WorkspaceScanner._extractXmlAttr(content, 'componentGroup') || '';
      const superType = WorkspaceScanner._extractXmlAttr(content, 'sling:resourceSuperType') || '';

      // Detect which files exist alongside
      const compDir = path.dirname(uri.fsPath);
      const hasHtl = (await vscode.workspace.findFiles(
        new vscode.RelativePattern(compDir, '*.html'), null, 1
      )).length > 0;
      const hasDialog = await WorkspaceScanner._fileExists(
        vscode.Uri.file(compDir + '/_cq_dialog/.content.xml')
      );
      const hasModel = await vscode.workspace.findFiles(
        `**/models/${WorkspaceScanner._toClassName(name)}.java`,
        '**/node_modules/**', 1
      );

      if (group) groupSet.add(group);

      result.found.push({ name, title, group, superType, path: compDir, hasHtl, hasDialog, hasModel: hasModel.length > 0 });
    }

    result.count = result.found.length;
    result.groups = [...groupSet];
    result.namingPattern = WorkspaceScanner._inferCase(result.found.map(c => c.name));

    return result;
  }

  // ---------------------------------------------------------------------------
  // ClientLibs scanner
  // ---------------------------------------------------------------------------

  static async _scanClientlibs(root) {
    const result = { found: [], categories: [], namingPattern: null, count: 0 };

    const clientlibFiles = await vscode.workspace.findFiles(
      '**/clientlibs/**/.content.xml',
      '**/node_modules/**',
      20
    );

    for (const uri of clientlibFiles) {
      const content = await WorkspaceScanner._readFile(uri);
      if (!content.includes('cq:ClientLibraryFolder')) continue;

      const name = path.basename(path.dirname(uri.fsPath));
      const categories = WorkspaceScanner._extractXmlAttr(content, 'categories') || '';
      const dependencies = WorkspaceScanner._extractXmlAttr(content, 'dependencies') || '';
      const allowProxy = WorkspaceScanner._extractXmlAttr(content, 'allowProxy') === 'true';

      // Check for css.txt / js.txt
      const dir = path.dirname(uri.fsPath);
      const hasCssTxt = await WorkspaceScanner._fileExists(vscode.Uri.file(dir + '/css.txt'));
      const hasJsTxt = await WorkspaceScanner._fileExists(vscode.Uri.file(dir + '/js.txt'));

      // Sample css.txt to infer SCSS vs plain CSS
      let usesScss = false;
      if (hasCssTxt) {
        const cssTxt = await WorkspaceScanner._readFile(vscode.Uri.file(dir + '/css.txt'));
        usesScss = cssTxt.includes('.scss') || cssTxt.includes('.sass');
      }

      result.found.push({ name, categories, dependencies, allowProxy, hasCssTxt, hasJsTxt, usesScss, path: dir });

      // Collect all unique category values
      categories.replace(/[\[\]]/g, '').split(',').forEach(c => {
        const trimmed = c.trim().replace(/"/g, '');
        if (trimmed) result.categories.push(trimmed);
      });
    }

    result.count = result.found.length;
    result.categories = [...new Set(result.categories)];
    result.namingPattern = WorkspaceScanner._inferCase(result.found.map(c => c.name));

    return result;
  }

  // ---------------------------------------------------------------------------
  // Pages scanner
  // ---------------------------------------------------------------------------

  static async _scanPages(root) {
    const result = { found: [], contentRoot: null, count: 0 };

    const pageFiles = await vscode.workspace.findFiles(
      '**/content/**/.content.xml',
      '**/node_modules/**',
      40
    );

    for (const uri of pageFiles) {
      const content = await WorkspaceScanner._readFile(uri);
      if (!content.includes('cq:Page')) continue;

      const dir = path.dirname(uri.fsPath);
      const name = path.basename(dir);
      const title = WorkspaceScanner._extractXmlAttr(content, 'jcr:title') || name;
      const template = WorkspaceScanner._extractXmlAttr(content, 'cq:template') || '';
      const resourceType = WorkspaceScanner._extractXmlAttr(content, 'sling:resourceType') || '';

      if (!result.contentRoot) {
        const fp = WorkspaceScanner._toForwardSlash(uri.fsPath);
        const contentIdx = fp.indexOf('/content/');
        if (contentIdx !== -1) {
          result.contentRoot = fp.substring(0, contentIdx + '/content'.length);
        }
      }

      result.found.push({ name, title, template, resourceType, path: dir });
    }

    result.count = result.found.length;
    return result;
  }

  // ---------------------------------------------------------------------------
  // Sling Models scanner
  // ---------------------------------------------------------------------------

  static async _scanSlingModels(root) {
    const result = { found: [], packageName: null, count: 0 };

    const javaFiles = await vscode.workspace.findFiles(
      '**/src/main/java/**/*.java',
      '**/node_modules/**',
      40
    );

    for (const uri of javaFiles) {
      const content = await WorkspaceScanner._readFile(uri);
      if (!content.includes('@Model')) continue;

      const name = path.basename(uri.fsPath, '.java');
      const packageMatch = content.match(/^package\s+([\w.]+);/m);
      const pkg = packageMatch ? packageMatch[1] : '';

      if (!result.packageName && pkg) result.packageName = pkg;

      // Extract adaptables
      const adaptMatch = content.match(/adaptables\s*=\s*([^,)]+)/);
      const adaptables = adaptMatch ? adaptMatch[1].trim() : '';

      // Extract @ValueMapValue field names as a proxy for dialog property names
      const valueMapFields = [...content.matchAll(/@ValueMapValue[^;]*\s+(?:private\s+)?[\w<>]+\s+(\w+)/g)]
        .map(m => m[1]);

      result.found.push({ name, package: pkg, adaptables, valueMapFields, path: uri.fsPath });
    }

    result.count = result.found.length;
    return result;
  }

  // ---------------------------------------------------------------------------
  // Naming convention inference
  // ---------------------------------------------------------------------------

  static async _inferNamingConventions(root) {
    const conventions = {
      components: null,  // 'kebab-case' | 'camelCase' | 'PascalCase'
      templates: null,
      javaClasses: null,
      xmlAttributes: 'camelCase' // AEM standard — always camelCase in XML
    };

    // Sample component names
    const componentDirs = await vscode.workspace.findFiles(
      '**/apps/**/components/**/.content.xml',
      '**/node_modules/**',
      10
    );
    const componentNames = componentDirs.map(u => path.basename(path.dirname(u.fsPath)));
    conventions.components = WorkspaceScanner._inferCase(componentNames);

    // Sample template names
    const templateDirs = await vscode.workspace.findFiles(
      '**/settings/wcm/templates/*/.content.xml',
      '**/node_modules/**',
      10
    );
    const templateNames = templateDirs.map(u => path.basename(path.dirname(u.fsPath)));
    conventions.templates = WorkspaceScanner._inferCase(templateNames);

    // Sample Java class names
    const javaFiles = await vscode.workspace.findFiles(
      '**/src/main/java/**/*.java',
      '**/node_modules/**',
      10
    );
    const javaNames = javaFiles.map(u => path.basename(u.fsPath, '.java'));
    conventions.javaClasses = WorkspaceScanner._inferCase(javaNames);

    return conventions;
  }

  // ---------------------------------------------------------------------------
  // XML style inference — indent, attribute ordering, namespace style
  // ---------------------------------------------------------------------------

  static async _inferXmlStyle(root) {
    const style = {
      indentChar: '    ', // 4 spaces default
      namespaceStyle: 'inline', // 'inline' = on root element
      sampleFile: null
    };

    const xmlFiles = await vscode.workspace.findFiles(
      '**/.content.xml',
      '**/node_modules/**',
      5
    );

    for (const uri of xmlFiles) {
      const content = await WorkspaceScanner._readFile(uri);
      if (content.length < 50) continue;

      style.sampleFile = uri.fsPath;

      // Detect indent: count leading spaces on second non-empty line
      const lines = content.split('\n').filter(l => l.trim().length > 0);
      if (lines.length > 1) {
        const indent = lines[1].match(/^(\s+)/);
        if (indent) style.indentChar = indent[1];
      }

      break;
    }

    return style;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  static async _fileExists(uri) {
    try {
      await vscode.workspace.fs.stat(uri);
      return true;
    } catch (_) {
      return false;
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

  static _extractXmlAttr(xml, attr) {
    const regex = new RegExp(`${attr}="([^"]*)"`, 'i');
    const match = xml.match(regex);
    return match ? match[1] : null;
  }

  static _toForwardSlash(p) {
    return p.replace(/\\/g, '/');
  }

  static _extractUpTo(filePath, segment) {
    const p = WorkspaceScanner._toForwardSlash(filePath);
    const idx = p.indexOf(segment);
    return idx !== -1 ? p.substring(0, idx) : null;
  }

  static _toClassName(name) {
    // Convert kebab-case or camelCase to PascalCase for Java class lookup
    return name
      .split(/[-_]/)
      .map(s => s.charAt(0).toUpperCase() + s.slice(1))
      .join('');
  }

  /**
   * Given a list of names, infer whether the project uses kebab-case,
   * camelCase, or PascalCase. Returns the most common pattern.
   */
  static _inferCase(names) {
    if (!names || names.length === 0) return null;
    let kebab = 0, camel = 0, pascal = 0;
    for (const n of names) {
      if (n.includes('-')) kebab++;
      else if (n.charAt(0) === n.charAt(0).toUpperCase()) pascal++;
      else camel++;
    }
    if (kebab >= camel && kebab >= pascal) return 'kebab-case';
    if (pascal >= camel) return 'PascalCase';
    return 'camelCase';
  }

  static _emptyContext(reason) {
    return {
      available: false,
      reason,
      root: null,
      projectLayout: { type: 'unknown', siteName: null, groupId: null, hasMaven: false },
      templates: { found: [], count: 0 },
      components: { found: [], count: 0, groups: [] },
      clientlibs: { found: [], count: 0, categories: [] },
      pages: { found: [], count: 0 },
      slingModels: { found: [], count: 0, packageName: null },
      namingConventions: { components: null, templates: null, javaClasses: null },
      xmlStyle: { indentChar: '    ' },
      library: { skills: [], agents: [], guides: [], sources: [] }
    };
  }
}

module.exports = { WorkspaceScanner };
