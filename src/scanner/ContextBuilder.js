'use strict';

/**
 * ContextBuilder
 *
 * Converts a ProjectContext object (from WorkspaceScanner) into a
 * structured text block that is prepended to every system prompt.
 *
 * The model reads this before generating any code, so it knows exactly
 * what already exists in the project and can match paths, naming, style,
 * and structure rather than inventing generic defaults.
 */
class ContextBuilder {

  /**
   * Build the full context block to inject into a prompt.
   * @param {object} ctx - ProjectContext from WorkspaceScanner.scan()
   * @returns {string}
   */
  static build(ctx) {
    if (!ctx.available) {
      return `
## WORKSPACE CONTEXT
No workspace scan available (${ctx.reason || 'unknown reason'}).
Use sensible AEM 6.5 defaults. Ask the developer to confirm paths.
`.trim();
    }

    const sections = [
      ContextBuilder._header(),
      ContextBuilder._projectLayout(ctx),
      ContextBuilder._templates(ctx),
      ContextBuilder._components(ctx),
      ContextBuilder._clientlibs(ctx),
      ContextBuilder._pages(ctx),
      ContextBuilder._slingModels(ctx),
      ContextBuilder._conventions(ctx),
      ContextBuilder._library(ctx),
      ContextBuilder._rules()
    ];

    return sections.filter(Boolean).join('\n\n');
  }

  static _header() {
    return `## WORKSPACE CONTEXT — READ THIS FIRST
The following is a live scan of the developer's actual AEM project.
Every file path, name, and pattern you generate MUST align with what is described below.
Do NOT use generic defaults when a real project value is available.`;
  }

  static _projectLayout(ctx) {
    const l = ctx.projectLayout;
    const lines = ['### Project layout'];

    lines.push(`- Structure type: ${l.type}`);
    if (l.siteName)  lines.push(`- Site name detected: \`${l.siteName}\``);
    if (l.groupId)   lines.push(`- Maven groupId detected: \`${l.groupId}\``);
    if (l.appsRoot)  lines.push(`- /apps root: \`${l.appsRoot}/apps\``);
    if (l.contentRoot) lines.push(`- /content root: \`${l.contentRoot}/content\``);
    if (l.confRoot)  lines.push(`- /conf root: \`${l.confRoot}/conf\``);
    if (l.coreRoot)  lines.push(`- Core (Java) root: \`${l.coreRoot}\``);
    if (l.javaSourceRoot) lines.push(`- Java source root: \`${l.javaSourceRoot}\``);
    lines.push(`- Maven project: ${l.hasMaven ? 'yes' : 'no'}`);
    lines.push(`- Frontend tooling: ${l.hasWebpack ? 'yes (webpack/npm)' : 'no'}`);

    return lines.join('\n');
  }

  static _templates(ctx) {
    const t = ctx.templates;
    const lines = [`### Existing templates (${t.count} found)`];

    if (t.storageRoot) {
      lines.push(`- Storage root: \`${t.storageRoot}\``);
    }
    if (t.namingPattern) {
      lines.push(`- Naming pattern: ${t.namingPattern} — **new templates MUST follow this pattern**`);
    }
    if (t.found.length === 0) {
      lines.push('- No templates found yet — this may be the first template in the project.');
      return lines.join('\n');
    }

    lines.push('- Templates found:');
    for (const tmpl of t.found.slice(0, 8)) {
      const nodes = [
        tmpl.hasStructure ? 'structure' : null,
        tmpl.hasPolicies  ? 'policies' : null,
        tmpl.hasInitial   ? 'initial'  : null
      ].filter(Boolean).join(', ');
      lines.push(`  - \`${tmpl.name}\` (status: ${tmpl.status}, nodes: ${nodes || 'root only'})`);
      if (tmpl.allowedPaths) lines.push(`    allowedPaths: ${tmpl.allowedPaths}`);
    }
    if (t.found.length > 8) lines.push(`  … and ${t.found.length - 8} more`);

    return lines.join('\n');
  }

  static _components(ctx) {
    const c = ctx.components;
    const lines = [`### Existing components (${c.count} found)`];

    if (c.storageRoot) lines.push(`- Storage root: \`${c.storageRoot}\``);
    if (c.namingPattern) lines.push(`- Naming pattern: ${c.namingPattern} — **new components MUST follow this pattern**`);
    if (c.groups.length > 0) lines.push(`- Component groups in use: ${c.groups.map(g => `\`${g}\``).join(', ')}`);

    if (c.found.length === 0) {
      lines.push('- No components found yet.');
      return lines.join('\n');
    }

    lines.push('- Sample components:');
    for (const comp of c.found.slice(0, 10)) {
      const files = [
        comp.hasHtl    ? 'HTL'    : null,
        comp.hasDialog ? 'dialog' : null,
        comp.hasModel  ? 'Sling model' : null
      ].filter(Boolean).join(', ');
      const superLine = comp.superType ? `, superType: \`${comp.superType}\`` : '';
      lines.push(`  - \`${comp.name}\` [${comp.group}] — files: ${files || 'node only'}${superLine}`);
    }
    if (c.found.length > 10) lines.push(`  … and ${c.found.length - 10} more`);

    return lines.join('\n');
  }

  static _clientlibs(ctx) {
    const cl = ctx.clientlibs;
    const lines = [`### Existing ClientLibraries (${cl.count} found)`];

    if (cl.categories.length > 0) {
      lines.push(`- Categories in use: ${cl.categories.map(c => `\`${c}\``).join(', ')}`);
    }
    if (cl.namingPattern) lines.push(`- Naming pattern: ${cl.namingPattern}`);

    for (const lib of cl.found.slice(0, 6)) {
      const details = [
        lib.hasCssTxt ? 'css.txt' : null,
        lib.hasJsTxt  ? 'js.txt'  : null,
        lib.usesScss  ? 'SCSS'    : null,
        lib.allowProxy ? 'allowProxy' : null
      ].filter(Boolean).join(', ');
      lines.push(`  - \`${lib.name}\` [${lib.categories}] — ${details || 'empty'}`);
    }

    return lines.join('\n');
  }

  static _pages(ctx) {
    const p = ctx.pages;
    if (p.count === 0) return null;

    const lines = [`### Existing pages (${p.count} found)`];
    if (p.contentRoot) lines.push(`- Content root: \`${p.contentRoot}\``);

    // Collect unique templates used by existing pages
    const templatesInUse = [...new Set(p.found.map(pg => pg.template).filter(Boolean))];
    if (templatesInUse.length > 0) {
      lines.push(`- Templates in use across pages: ${templatesInUse.slice(0, 4).map(t => `\`${t}\``).join(', ')}`);
    }

    const resourceTypes = [...new Set(p.found.map(pg => pg.resourceType).filter(Boolean))];
    if (resourceTypes.length > 0) {
      lines.push(`- sling:resourceType values in use: ${resourceTypes.slice(0, 4).map(r => `\`${r}\``).join(', ')}`);
    }

    return lines.join('\n');
  }

  static _slingModels(ctx) {
    const sm = ctx.slingModels;
    if (sm.count === 0) return null;

    const lines = [`### Sling Models (${sm.count} found)`];
    if (sm.packageName) lines.push(`- Package: \`${sm.packageName}\` — **new models MUST use this package**`);

    for (const m of sm.found.slice(0, 6)) {
      const fields = m.valueMapFields.length > 0
        ? ` — @ValueMapValue fields: ${m.valueMapFields.join(', ')}`
        : '';
      lines.push(`  - \`${m.name}\`${fields}`);
    }
    if (sm.found.length > 6) lines.push(`  … and ${sm.found.length - 6} more`);

    return lines.join('\n');
  }

  static _conventions(ctx) {
    const n = ctx.namingConventions;
    const x = ctx.xmlStyle;
    const lines = ['### Code & naming conventions detected'];

    if (n.components)  lines.push(`- Component directory names: \`${n.components}\``);
    if (n.templates)   lines.push(`- Template directory names: \`${n.templates}\``);
    if (n.javaClasses) lines.push(`- Java class names: \`${n.javaClasses}\``);
    lines.push(`- XML attribute names: always \`camelCase\` (AEM standard)`);

    const indent = x.indentChar === '\t' ? 'tabs' : `${x.indentChar.length} spaces`;
    lines.push(`- XML indentation: ${indent}`);
    if (x.sampleFile) lines.push(`  (inferred from \`${x.sampleFile}\`)`);

    return lines.join('\n');
  }

  static _library(ctx) {
    const lib = ctx.library;
    if (!lib || (lib.skills.length === 0 && lib.agents.length === 0 && lib.guides.length === 0)) {
      return null;
    }

    const lines = ['### Team library available'];

    if (lib.sources && lib.sources.length > 0) {
      lines.push(`- Sources: ${lib.sources.map(s => `\`${s}\``).join(', ')}`);
    }

    if (lib.skills.length > 0) {
      lines.push(`\n**Skills (${lib.skills.length})** — invoke with \`/use-skill name=<name>\``);
      for (const s of lib.skills) {
        const tags = s.tags.length > 0 ? ` [${s.tags.join(', ')}]` : '';
        lines.push(`  - \`${s.name}\`${tags}: ${s.description}`);
      }
    }

    if (lib.agents.length > 0) {
      lines.push(`\n**Agents (${lib.agents.length})** — invoke with \`/use-skill name=<name>\``);
      for (const a of lib.agents) {
        const tags = a.tags.length > 0 ? ` [${a.tags.join(', ')}]` : '';
        lines.push(`  - \`${a.name}\`${tags} (model: ${a.model}): ${a.description}`);
      }
    }

    if (lib.guides.length > 0) {
      lines.push(`\n**Guides (${lib.guides.length})** — invoke with \`/use-skill name=<name>\``);
      for (const g of lib.guides) {
        lines.push(`  - \`${g.name}\`: ${g.description}`);
      }
    }

    lines.push('\nWhen a developer references a skill, agent, or guide by name, treat its content as additional authoritative instructions for that response.');

    return lines.join('\n');
  }

  static _rules() {
    return `### STRICT RULES — apply to every response
1. Use the DETECTED paths above, not invented ones. If a root path was found, all new files go under it.
2. Use the DETECTED site name and groupId. Never default to "my-site" or "com.example" when real values exist.
3. Match the DETECTED naming pattern exactly. If the project uses kebab-case for components, new components use kebab-case.
4. Match the DETECTED XML indentation. Do not change indentation style.
5. Use DETECTED component groups — do not invent new group names.
6. Use DETECTED ClientLib categories when referencing clientlibs in page components.
7. If the Sling Model package was detected, ALL new Java models go in that package.
8. If a pattern differs from AEM defaults, follow the project pattern — the project is the source of truth.
9. If something was NOT detected, state that clearly and ask the developer to confirm before generating.`;
  }
}

module.exports = { ContextBuilder };
