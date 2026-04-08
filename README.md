# AEM Copilot Assistant

A VS Code extension that adds an `@aem` chat participant to GitHub Copilot Chat. Every command scans your workspace before responding, so all generated code matches your project's real paths, naming conventions, component groups, and XML style — not generic defaults.

---

## Table of Contents

- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [How workspace scanning works](#how-workspace-scanning-works)
- [Commands](#commands)
  - [/new-site](#new-site)
  - [/new-template](#new-template)
  - [/new-theme](#new-theme)
  - [/new-page](#new-page)
  - [/new-component](#new-component)
  - [/new-policy](#new-policy)
  - [/explain](#explain)
  - [/debug](#debug)
  - [/scan](#scan)
  - [/diff](#diff)
  - [/init-copilot](#init-copilot)
- [Copilot Instructions](#copilot-instructions)
  - [What is in the generated file](#what-is-in-the-generated-file)
  - [Smart sync — preserving your edits](#smart-sync--preserving-your-edits)
  - [Sidebar panel](#sidebar-panel)
  - [VS Code commands](#vs-code-commands)
  - [Customizing the file](#customizing-the-file)
- [Team Library](#team-library)
  - [Library structure](#library-structure)
  - [Skill file format](#skill-file-format)
  - [Agent file format](#agent-file-format)
  - [Guide file format](#guide-file-format)
  - [Shared library setup](#shared-library-setup)
  - [/list-skills](#list-skills)
  - [/use-skill](#use-skill)
- [Included Skills](#included-skills)
- [Included Agents](#included-agents)
- [Included Guides](#included-guides)
- [Adding your own Skills, Agents, and Guides](#adding-your-own-skills-agents-and-guides)
- [Parameter reference](#parameter-reference)

---

## Prerequisites

- VS Code 1.90 or later
- [GitHub Copilot Chat](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot-chat) installed and signed in
- An AEM 6.5 project open as a workspace folder (the extension works on empty workspaces too, but workspace scanning produces richer output when code exists)

---

## Installation

1. Download the `.vsix` package from your team's release location
2. In VS Code: **Extensions** → **…** → **Install from VSIX…**
3. Select the `.vsix` file
4. Reload VS Code when prompted

Once installed, open Copilot Chat and type `@aem` to start.

---

## How workspace scanning works

Before every command the extension silently scans your open workspace and detects:

| What is detected | How it is used |
|---|---|
| `/apps`, `/content`, `/conf` root paths | All generated file paths are relative to these real roots |
| Site name | Used in component groups, content paths, clientlib categories |
| Maven `groupId` | Used in Java package declarations and Sling model paths |
| Existing components | Naming pattern, groups in use, which files each has (HTL / dialog / model) |
| Existing templates | Storage root, naming pattern, which sub-nodes are present |
| Existing ClientLibs | Categories in use, whether SCSS or plain CSS is used |
| Sling model package | All new Java models are placed in the detected package |
| XML indentation style | Generated XML matches your project's indent character |
| Naming conventions | kebab-case vs camelCase inferred per artifact type |
| Team library | Skills, agents, and guides available in `.aem-library/` |

**Parameters are optional.** If your workspace is already set up, omit parameters and the extension derives everything from the scan. Provide parameters only when you want to override a detected value.

---

## Commands

Open Copilot Chat with `Ctrl+Alt+I` (Windows/Linux) or `Cmd+Alt+I` (Mac), then type `@aem /command`.

---

### /new-site

Scaffolds a complete AEM 6.5 site folder structure with all required `.content.xml` stubs and a step-by-step setup guide.

```
@aem /new-site siteName=my-brand groupId=com.mybrand
```

**Parameters**

| Parameter | Required | Description |
|---|---|---|
| `siteName` | Yes (or detected) | Site folder name, e.g. `my-brand` |
| `groupId` | No | Maven groupId, e.g. `com.mybrand` — falls back to detected value |

**What is generated**

- Folder structure diagram adapted to the detected project layout (Maven multi-module, Maven single, or custom)
- `/apps/{siteName}/.content.xml` — sling:Folder node
- `/apps/{siteName}/components/page/.content.xml` — page component with WCM Core superType
- `/content/{siteName}/.content.xml` — cq:Page root
- `/conf/{siteName}/.content.xml` — sling:Folder
- Step-by-step setup guide including the Maven deploy command and CRXDE verification steps

---

### /new-template

Creates a complete AEM 6.5 editable template with all four required sub-nodes.

```
@aem /new-template name=content-page site=my-brand
```

**Parameters**

| Parameter | Required | Description |
|---|---|---|
| `name` | Yes (or detected) | Template folder name, e.g. `content-page` |
| `site` | No | Site name — falls back to detected site |

**What is generated**

1. `/conf/{site}/settings/wcm/templates/{name}/.content.xml` — root template node (`status=enabled`, `allowedPaths`, `ranking`)
2. `/conf/{site}/settings/wcm/templates/{name}/structure/.content.xml` — fixed layout regions with a responsive grid
3. `/conf/{site}/settings/wcm/templates/{name}/policies/.content.xml` — policy mappings
4. `/conf/{site}/settings/wcm/templates/{name}/initial/.content.xml` — default page content
5. Enable guide: how to make the template available for page creation

> **Note:** The extension checks existing templates in your workspace and replicates the same sub-node set they use. If all your templates have `structure`, `policies`, and `initial` nodes, the new one will too.

---

### /new-theme

Scaffolds a ClientLib folder with SCSS partials wired to your detected components.

```
@aem /new-theme name=brand-theme site=my-brand components=hero,navigation,footer
```

**Parameters**

| Parameter | Required | Description |
|---|---|---|
| `name` | Yes (or detected) | ClientLib folder name |
| `site` | No | Site name — falls back to detected site |
| `components` | No | Comma-separated component names — falls back to all detected components |

**What is generated**

- ClientLib `.content.xml` with `allowProxy=true` and category matching the detected naming scheme
- `css.txt` and `js.txt` listing files in compilation order
- `_variables.scss` — colour tokens, spacing scale, typography, breakpoints
- `_mixins.scss` — `respond-to` breakpoint mixin, `visually-hidden`, `clearfix`
- `_base.scss` — CSS reset and base typography
- One `_component.scss` partial per detected component with BEM block stubs
- Page component HTL change to load the new clientlib category
- Webpack/frontend-maven-plugin setup steps

---

### /new-page

Generates a page `.content.xml` ready to drop into your `ui.content` Maven module.

```
@aem /new-page title="About Us" site=my-brand template=content-page depth=standard
```

**Parameters**

| Parameter | Required | Description |
|---|---|---|
| `title` | Yes (or detected) | Human-readable page title |
| `site` | No | Site name |
| `template` | No | Template name — falls back to first detected template |
| `depth` | No | `shallow` / `standard` / `deep` — controls how many parsys nodes are created |
| `hideInNav` | No | `true` / `false` — sets `hideInNav` on the page node |

**What is generated**

- Full `.content.xml` with `cq:Page` root, `jcr:content` node, `cq:template` reference, parsys nodes
- Page slug derived from the title (lowercase, hyphenated)
- Maven deploy command and AEM Sites console verification steps

---

### /new-component

Generates a complete AEM 6.5 component: node definition, HTL, Sling model, and author dialog.

```
@aem /new-component name=hero site=my-brand group="My Brand - Content"
```

**Parameters**

| Parameter | Required | Description |
|---|---|---|
| `name` | Yes (or detected) | Component directory name, e.g. `hero` or `hero-banner` |
| `site` | No | Site name |
| `group` | No | Component group — falls back to detected groups |
| `superType` | No | Explicit `sling:resourceSuperType` override |

**What is generated**

1. `/apps/{site}/components/{name}/.content.xml` — component node with `jcr:title`, `componentGroup`
2. `/apps/{site}/components/{name}/{name}.html` — HTL with `data-sly-use` loading the Sling model, BEM structure, `data-sly-test` guards
3. `/core/src/main/java/{package}/models/{ModelName}.java` — Sling model with `@ValueMapValue` fields, getters, `@PostConstruct` stub, correct imports
4. `/apps/{site}/components/{name}/_cq_dialog/.content.xml` — Granite UI dialog with appropriate field types
5. Registration guide: Maven deploy, template policy, component browser verification

> **Convention matching:** The extension checks all existing components in the workspace. If they all have dialogs, the new one gets a dialog. If they use a `sling:resourceSuperType` pattern, the new one follows the same pattern.

---

### /new-policy

Generates a content policy for a specific component and shows the exact node to add to a template's policies file.

```
@aem /new-policy component=hero template=content-page site=my-brand
```

**Parameters**

| Parameter | Required | Description |
|---|---|---|
| `component` | Yes | Component name — must exist in the detected components list |
| `template` | Yes | Template name — must exist in the detected templates list |
| `site` | No | Site name |
| `resourceType` | No | Explicit `sling:resourceType` override |

**What is generated**

- Policy node at `/conf/{site}/settings/wcm/policies/{site}/components/{component}/.content.xml`
- The exact mapping node snippet to insert into the template's `policies/.content.xml`
- Step-by-step wiring guide including Template Editor verification

> The extension cross-references detected components and templates before generating. If the named component or template is not found in the scan, it asks you to confirm before proceeding.

---

### /explain

Explains any AEM 6.5 concept in plain English, grounded in your project's actual code.

```
@aem /explain topic="editable templates"
@aem /explain topic="Sling model injection strategies"
@aem /explain topic="ClientLib allowProxy"
```

**Parameters**

| Parameter | Required | Description |
|---|---|---|
| `topic` | Yes | The AEM concept to explain (free text) |

**What is produced**

1. Plain-English summary (2–4 sentences, no unexplained jargon)
2. How the concept applies to this specific project — using detected file paths and names
3. A code example drawn from an actual detected file if one is relevant
4. Common pitfalls (project-specific where possible)
5. Related commands to run next based on the current state of the workspace

---

### /debug

Diagnoses AEM errors, broken XML, misbehaving HTL, or Java stack traces. Paste the error or file content directly in your message.

```
@aem /debug
javax.jcr.RepositoryException: Unable to create node at /apps/my-brand/components/hero
...paste full stack trace...
```

```
@aem /debug
...paste broken .content.xml...
```

**What is produced**

1. **Problem identified** — one specific sentence naming the root cause
2. **Why this happens** — 2–4 sentences explaining the relevant AEM mechanism
3. **The fix** — corrected code in a fenced block, with `// FIXED:` inline comments
4. **Verification steps** — where to make the change, how to redeploy, what to check in AEM
5. **Prevention tip** — one actionable tip to avoid this class of issue in future

> The extension cross-references detected component and template names against the error. If the error mentions a path, it checks whether that path exists in the scan and flags mismatches.

---

### /scan

Shows a complete human-readable summary of everything the workspace scanner detected.

```
@aem /scan
```

**What is produced**

- Project snapshot table: type, site name, groupId, root paths, build tooling
- What exists: templates, components, clientlibs, pages, Sling models — counts and examples
- Inferred naming conventions per artifact type, including any inconsistencies
- Gaps: what was NOT detected that could cause a command to produce incorrect output
- Recommended next steps with example commands pre-filled from the real project

Run `/scan` first when onboarding to a new project or when commands seem to be using wrong paths.

---

### /diff

Compares the detected project structure against AEM 6.5 best practices and produces a prioritised issue list.

```
@aem /diff
```

**What is produced**

- **Structure review** — `/apps`, `/content`, `/conf` separation, component and template storage
- **Template review** — per-template check of required nodes, `allowedPaths` scope, status
- **Component review** — per-component check for dialog, HTL, Sling model, `sling:resourceSuperType`
- **ClientLib review** — `allowProxy`, category naming consistency, page vs component separation
- **Naming consistency** — flags any artifact type with mixed naming conventions
- **Priority action list** — top 5 issues ranked by impact, each with the exact slash command to fix it (parameters pre-filled from the scan)

---

### /init-copilot

Generates or syncs `.github/copilot-instructions.md` from a live workspace scan. GitHub Copilot Chat reads this file automatically for every response in the workspace — giving base Copilot the same project context that `@aem` commands use.

```
@aem /init-copilot
```

**On first run** the file is created at `.github/copilot-instructions.md` with three sections:

1. An auto-generated project block (site name, components, templates, naming conventions)
2. A usage guide for all `@aem` slash commands
3. AEM 6.5 coding rules Copilot must follow

**On subsequent runs** only the auto-generated block is refreshed. Everything you have written in the Custom instructions section is preserved.

After writing the file, the assistant explains what was generated, recommends workspace-specific additions to the Custom section, and offers a button to open the file.

> **No parameters.** The command derives everything from the workspace scan.

---

## Copilot Instructions

`.github/copilot-instructions.md` is a file that GitHub Copilot Chat reads automatically for every response in your workspace — no `@aem` prefix required. It tells base Copilot what kind of project this is, what rules to follow, and how to use the `@aem` commands.

The extension manages this file so you do not have to write or maintain it by hand.

---

### What is in the generated file

| Section | Content | Editable? |
|---|---|---|
| Auto-generated project block | Site name, groupId, project type, root paths, template list, component list, Sling models, naming conventions — all detected from the live workspace scan | No — refreshed on every sync |
| AEM Copilot usage guide | Full `@aem` command table with descriptions | Yes (outside the markers) |
| AEM 6.5 coding rules | Sling Models, HTL-only, ClientLib category naming, dialog requirements, XML standards | Yes |
| Custom instructions | Blank section for team-specific rules, preferences, and standards | Yes — never overwritten |

---

### Smart sync — preserving your edits

The auto-generated block is wrapped in HTML comment markers:

```
<!-- BEGIN AEM COPILOT GENERATED -->
...detected project data...
<!-- END AEM COPILOT GENERATED -->
```

When you run `/init-copilot` again (or use **Sync** from the command palette or sidebar), only the content between these markers is replaced. Everything outside them — including the AEM 6.5 coding rules and your Custom instructions — is left exactly as you wrote it.

**Never edit inside the markers.** Your changes will be overwritten on the next sync. Put team-specific rules in the Custom instructions section at the bottom of the file.

---

### Sidebar panel

A **Copilot Instructions** panel appears at the top of the AEM Library sidebar (the same activity bar icon as the Team Library). It shows:

- **File found** — the relative path and how recently it was updated (e.g. "updated 3h ago"). Click the item to open the file.
- **Not generated yet** — a prompt to run Generate.

**Toolbar actions on the panel:**

| Button | What it does |
|---|---|
| `$(sparkle)` Generate | Scans the workspace and creates `.github/copilot-instructions.md` |
| `$(sync)` Sync | Re-scans and refreshes only the auto-generated block |
| `$(refresh)` Refresh | Re-checks file status without modifying anything |

---

### VS Code commands

All three commands are available from the **Command Palette** (`Ctrl+Shift+P` / `Cmd+Shift+P`). Search for `AEM Copilot`:

| Command | Description |
|---|---|
| **AEM Copilot: Generate Copilot Instructions** | Scans the workspace and creates (or overwrites) `.github/copilot-instructions.md`. Offers "Open file" after writing. |
| **AEM Copilot: Sync Copilot Instructions** | Re-scans and refreshes the `BEGIN/END GENERATED` block only. Safe to run at any time — custom content is never touched. |
| **AEM Copilot: Open Copilot Instructions** | Opens `.github/copilot-instructions.md` in the editor. If the file does not exist, prompts you to generate it first. |

---

### Customizing the file

After generating the file, open it and scroll to the **Custom instructions** section at the bottom. Add anything Copilot should always know about your project. Examples:

```markdown
## Custom instructions

- All Java interfaces live in `core/src/main/java/com/mybrand/core/models/`
  and implementations in the `.impl` sub-package.
- The primary site for new development is `my-brand`. Ignore `my-brand-legacy`.
- Use `mybrand.base` for page-level clientlibs and `mybrand.components` for
  component-level clientlibs.
- Never generate JSP or WCMUsePojo — the codebase was fully migrated in 2023.
- Heading levels in HTL must always be authored (not hardcoded) using a
  `headingElement` dialog field.
```

**When to re-sync:** Run **Sync Copilot Instructions** after any of these:
- Adding new components or templates (so Copilot sees the updated list)
- Restructuring Maven modules (so detected root paths are accurate)
- Adding Sling models (so the Java package can be inferred correctly)

---

## Team Library

The team library lets you store reusable **Skills**, **Agents**, and **Guides** that every developer can invoke from Copilot Chat. The library is automatically discovered on every command — no manual loading required.

### Library structure

```
.aem-library/
├── skills/          ← Detailed prompt instructions for specific tasks
│   ├── new-hero-component.md
│   ├── editable-template-setup.md
│   └── clientlib-organization.md
├── agents/          ← Claude agent definitions (JSON)
│   ├── component-reviewer.json
│   ├── migration-helper.json
│   ├── accessibility-auditor.json
│   └── htl-refactor.json
└── guides/          ← Reference documentation and checklists
    ├── component-patterns.md
    └── deployment-checklist.md
```

Place this folder at the **workspace root** (alongside `pom.xml`). The extension detects it automatically on every command. For a **shared team library** see [Shared library setup](#shared-library-setup) below.

---

### Skill file format

Skills are `.md` files with YAML frontmatter followed by the skill body.

```markdown
---
name: my-skill-name
description: One-line description shown in /list-skills
topic: components
tags: [scaffold, htl, dialog]
---

# Skill: My Skill

Detailed instructions here. Write these as if briefing an expert AEM developer.
Include:
- Exactly what files to generate
- What properties / fields are required
- Any constraints or rules specific to your team
- A verification checklist
```

**Frontmatter fields**

| Field | Required | Description |
|---|---|---|
| `name` | Yes | Unique identifier used in `/use-skill name=x` |
| `description` | Yes | One-liner shown in the `/list-skills` catalog |
| `topic` | No | Groups the skill in the catalog — `components`, `templates`, `themes`, `debugging`, `review`, `deployment` |
| `tags` | No | Array or comma-separated list for filtering |

---

### Agent file format

Agents are `.json` files that define a Claude persona with specific expertise and a structured output format.

```json
{
  "name": "my-agent-name",
  "description": "One-line description shown in /list-skills",
  "topic": "review",
  "tags": ["review", "quality"],
  "model": "claude-sonnet-4-6",
  "tools": ["Read", "Grep", "Glob"],
  "instructions": "You are a [role]...\n\nWhen invoked, [what the agent does]...\n\nOUTPUT FORMAT:\n..."
}
```

**Fields**

| Field | Required | Description |
|---|---|---|
| `name` | Yes | Unique identifier used in `/use-skill name=x` |
| `description` | Yes | One-liner shown in the `/list-skills` catalog |
| `topic` | No | Groups the agent in the catalog |
| `tags` | No | Array for filtering |
| `model` | No | Claude model ID — defaults to `claude-sonnet-4-6` |
| `tools` | No | List of tools the agent is designed to use (informational) |
| `instructions` | Yes | Full system prompt for the agent — write this as a detailed persona + output format spec |

**Writing good agent instructions**

A well-written agent `instructions` field has four parts:

1. **Persona** — who the agent is and what expertise it has
2. **Trigger** — what the agent does when invoked and what input it expects
3. **Checklist or rubric** — the structured criteria it applies
4. **Output format** — the exact structure of the response, with section headers and severity levels

---

### Guide file format

Guides use the same `.md` + frontmatter format as skills. The difference is intent: skills are instructions for generating something, guides are reference material the agent reads and presents.

```markdown
---
name: my-guide-name
description: One-line description
topic: deployment
tags: [checklist, deployment]
---

# Guide: My Guide

Reference content here — checklists, pattern descriptions, rules, etc.
```

When invoked via `/use-skill`, guide content is rendered with real project values (site name, paths) substituted from the workspace scan.

---

### Shared library setup

To share a single library across multiple projects and team members:

1. Create a dedicated Git repository for the library (e.g. `aem-team-library`)
2. Structure it the same way: `skills/`, `agents/`, `guides/` at the root
3. Each developer clones it locally
4. In VS Code settings (`settings.json`), add:

```json
{
  "aem-copilot.libraryPath": "/path/to/cloned/aem-team-library"
}
```

Or use a path relative to the workspace root:

```json
{
  "aem-copilot.libraryPath": "../aem-team-library"
}
```

**Merge behaviour:** If both a shared library and a local `.aem-library/` folder are present, entries from both are merged. When the same `name` appears in both, the local `.aem-library/` version wins. This lets individual projects override shared skills without modifying the shared repo.

---

### /list-skills

Browse the full team library catalog.

```
@aem /list-skills
```

Produces a grouped catalog of all detected skills, agents, and guides — with the exact `/use-skill` command to invoke each one. Use this to discover what is available before using `/use-skill`.

If no library is found, the command explains how to create one.

---

### /use-skill

Invoke any skill, agent, or guide from the team library. There are three ways to use it:

#### Option 1 — Searchable picker (recommended)

Type `/use-skill` with no arguments. A searchable Quick Pick menu opens showing every skill, agent, and guide in the library with its description. Type to filter, arrow keys to navigate, Enter to run.

```
@aem /use-skill
```

#### Option 2 — Clickable suggestions after commands

After running scaffold or review commands (`/new-component`, `/diff`, `/scan`, etc.), clickable suggestion chips appear below the response. Click any chip to run the related skill or agent immediately — no typing required.

#### Option 3 — Direct by name (power users)

If you already know the name, pass it directly:

```
@aem /use-skill name=component-reviewer
@aem /use-skill name=new-hero-component
```

**Parameters**

| Parameter | Required | Description |
|---|---|---|
| `name` | No | Name of the skill, agent, or guide — omit to open the picker |
| Any other `key=value` | No | Passed as additional context to the skill |

**Behaviour by entry type**

| Type | Icon in picker | What happens |
|---|---|---|
| **Skill** | `$(symbol-method)` | The skill's body is treated as a detailed prompt instruction set. The extension executes those instructions using the workspace context to fill in real project values. |
| **Agent** | `$(robot)` | The agent's `instructions` field becomes the persona for this conversation turn. The response opens with `Acting as agent: {name} — {description}`. |
| **Guide** | `$(book)` | The guide content is rendered with real project values substituted from the workspace scan. |

All three types use the workspace scan — real paths, site name, and naming conventions are always substituted.

**Suggestions after commands**

The extension surfaces up to 3 relevant follow-ups after each command, drawn only from skills/agents that actually exist in your library:

| After this command | Typical suggestions |
|---|---|
| `/new-component` | component-reviewer, accessibility-auditor, htl-refactor |
| `/diff` | migration-helper, component-reviewer, accessibility-auditor |
| `/scan` | component-reviewer, migration-helper |
| `/debug` | htl-refactor |
| `/new-site` | migration-helper |

A **Browse team library** chip always appears as the last option.

---

## Included Skills

The following skills ship with the extension in `.aem-library/skills/`.

### new-hero-component

**Invoke:** `@aem /use-skill name=new-hero-component`

Scaffolds a production-ready hero banner component with:
- Background image, title, subtitle, CTA text, CTA link, CTA target, and overlay opacity fields
- HTL with BEM class naming, `data-sly-test` guards, and background image via `style` attribute
- Sling model with `@ValueMapValue` fields, `isCtaVisible()` convenience method, and `@PostConstruct`
- Author dialog with FieldSet grouping for image, text, and CTA fields
- Verification checklist for dialog, rendering, and conditional CTA behaviour

---

### editable-template-setup

**Invoke:** `@aem /use-skill name=editable-template-setup`

Produces a complete editable template with all four required nodes. Covers:
- Root `.content.xml` with correct `allowedPaths` scoping, `ranking`, and `status=enabled`
- Structure node rules: when to lock regions, responsive grid setup
- Policies node: how to map structure nodes to content policies
- Initial content: what to pre-populate and what to leave empty
- Registration checklist through the AEM Template Editor

---

### clientlib-organization

**Invoke:** `@aem /use-skill name=clientlib-organization`

Designs a best-practice ClientLib structure with:
- Recommended folder layout: `base/`, `components/`, `page/`, `editor/`
- Category naming convention `{site}.{scope}` applied consistently
- `allowProxy=true` rules (publish-facing vs author-only)
- `embed` vs `dependencies` strategy for CSS/JS concatenation
- SCSS file conventions: `_variables.scss`, BEM naming, no `!important`
- Browser verification steps

---

## Included Agents

The following agents ship with the extension in `.aem-library/agents/`.

### component-reviewer

**Invoke:** `@aem /use-skill name=component-reviewer`

Reviews AEM component code (HTL, Sling model, dialog XML) against a structured checklist. Share a file or paste code in the same message.

**Checks performed:**
- HTL: `data-sly-use` usage, XSS context on all output, logic-free templates, null guards, no hardcoded paths
- Sling model: `@Model` annotation, `@PostConstruct` vs constructor, no `session.save()`, no `WCMUsePojo`, interface-based design
- Dialog XML: node types, field `name` attributes matching model properties, correct Granite UI components, no deprecated Foundation UI
- Component node: `componentGroup` validity, `sling:resourceSuperType`, human-readable `jcr:title`

**Output:** Summary verdict → issues table (severity: info / warning / issue) → corrected snippets for issue-level findings → positive notes

---

### migration-helper

**Invoke:** `@aem /use-skill name=migration-helper`

Audits the codebase for deprecated AEM 6.5 patterns and produces a prioritised migration plan.

**Patterns detected:**
- `WCMUsePojo` extends → Sling Models
- `/etc/clientlibs` paths → `/etc.clientlibs` proxy paths
- `foundation/*` components → WCM Core or `wcm/foundation`
- Static templates in `/apps` → editable templates in `/conf`
- JSP-based components → HTL
- `CQ.wcm.*` JavaScript APIs → Coral UI
- Hardcoded DAM paths → dialog field + model
- Foundation UI dialogs → Granite/Coral UI
- Design dialogs → content policies

**Output:** Critical → Recommended → Low priority sections, effort estimate table, and a ready-to-use first PR code change

---

### accessibility-auditor

**Invoke:** `@aem /use-skill name=accessibility-auditor`

Audits component HTL and dialog markup for WCAG 2.1 AA compliance.

**Checks performed:**
- Images: `alt` attributes, decorative image handling, dialog toggle for `alt=""`
- Headings: authored heading level (not hardcoded), no skipped levels, landmark regions
- Links and buttons: descriptive link text, `aria-label` for "Read more" patterns, new-tab indication
- Keyboard: Tab reachability, visible focus, focus trap in modals, skip navigation
- ARIA: correct role usage, `aria-hidden` on decorative elements only, `aria-live` for dynamic content
- AEM authoring: accessibility fields clearly labelled and marked required in the dialog

**Output:** Compliance level → findings table (WCAG criterion, severity) → corrected HTL snippets → dialog improvements → manual test checklist

---

### htl-refactor

**Invoke:** `@aem /use-skill name=htl-refactor`

Refactors HTL files to remove anti-patterns. Share the `.html` file or paste it in your message.

**Anti-patterns removed:**
- Direct `ValueMap` access in templates (replaced with Sling model getters)
- Incorrect XSS context on `href`, `src`, `style` attributes
- Business logic in HTL (moved to model methods)
- Missing null guards on nested resource access
- Hardcoded resource types in `data-sly-resource`
- Inline `<script>` blocks with AEM data (replaced with data attributes + external JS)

**Output:** Findings table (line, anti-pattern, severity) → complete refactored file with inline comments → Sling model method additions required → three-item browser testing checklist

---

## Included Guides

The following guides ship with the extension in `.aem-library/guides/`.

### component-patterns

**Invoke:** `@aem /use-skill name=component-patterns`

Team reference guide covering four AEM component architecture patterns:

1. **Simple display component** — `@ValueMapValue` getters only, when to use this pattern
2. **Container component** — `cq:isContainer`, edit config listeners, `data-sly-resource` rules
3. **Composite component (delegates to core)** — `sling:resourceSuperType`, partial HTL override, `sling:hideResource`, `@via("resource")`
4. **Global component (header/footer)** — structure storage, template locking, clientlib embed strategy

Also documents the team's interface + implementation naming standard (`HeroBanner.java` / `HeroBannerImpl.java`) and the full naming convention table for all artifact types.

---

### deployment-checklist

**Invoke:** `@aem /use-skill name=deployment-checklist`

Pre-deployment checklist covering:
- Pre-build checks: XML validation, no hardcoded URLs, `allowedPaths` scoping, `allowProxy` rules
- Build commands: full build, frontend-only, and skip-tests variants
- Author smoke tests: component browser, dialog, save/reload, template creation
- Publish smoke tests: 500 errors, clientlib paths, `ResourceNotFoundException`, performance
- Log check commands with `tail -f` and `grep` filters
- Rollback procedure: CRX Package Manager uninstall, CRXDE revert, re-deploy steps
- CI/CD notes: author-first deploy, replication queue, Dispatcher cache invalidation

---

## Adding your own Skills, Agents, and Guides

### Adding a skill

1. Create a `.md` file in `.aem-library/skills/` (or your shared library repo's `skills/` folder)
2. Add the frontmatter block with `name`, `description`, `topic`, and `tags`
3. Write the skill body — be specific: list every file to generate, every required property, and a verification checklist
4. Run `@aem /list-skills` to confirm it appears in the catalog
5. Test with `@aem /use-skill name=your-skill-name`

### Adding an agent

1. Create a `.json` file in `.aem-library/agents/`
2. Fill in `name`, `description`, `topic`, `tags`, `model`, and `instructions`
3. Structure `instructions` as: persona → trigger → checklist/rubric → output format
4. Run `@aem /list-skills` to confirm it appears
5. Test with `@aem /use-skill name=your-agent-name`

### Sharing with the team

Commit the `.aem-library/` folder to the project repo, **or** push your additions to the shared library repo. Every team member with `aem-copilot.libraryPath` configured will pick up the changes on their next `git pull` — no extension update required.

---

## Parameter reference

All parameters use `key=value` syntax. Multi-word values must be quoted: `title="My Page Title"`.

```
@aem /command key=value key2="multi word value"
```

| Command | Parameters |
|---|---|
| `/new-site` | `siteName`, `groupId` |
| `/new-template` | `name`, `site` |
| `/new-theme` | `name`, `site`, `components` |
| `/new-page` | `title`, `site`, `template`, `depth`, `hideInNav` |
| `/new-component` | `name`, `site`, `group`, `superType` |
| `/new-policy` | `component`, `template`, `site`, `resourceType` |
| `/explain` | `topic` |
| `/debug` | _(paste error inline — no named parameters)_ |
| `/scan` | _(no parameters)_ |
| `/diff` | _(no parameters)_ |
| `/list-skills` | _(no parameters)_ |
| `/use-skill` | `name` (optional — omit to open picker) + any additional context parameters |
| `/init-copilot` | _(no parameters — derives everything from the workspace scan)_ |

All parameters are optional when their values can be inferred from the workspace scan. The extension will state what it detected and flag any assumptions it made.
