# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

VS Code extension that adds an `@aem` chat participant to GitHub Copilot Chat. It provides workspace-aware scaffolding and guidance for Adobe Experience Manager (AEM) 6.5 projects. Before every command, it silently scans the developer's open workspace to detect project structure, naming conventions, existing components/templates, and XML style, then generates code that matches the real project.

## Commands

- `npm run lint` — ESLint across src/
- `npm run package` — build VSIX with `vsce package`
- `npm run publish` — publish with `vsce publish`

No test framework is configured. No build/compile step — the extension uses plain JavaScript with zero runtime dependencies (only VS Code API and Node.js built-ins).

## Architecture

### Entry Point & Command Routing

`src/extension.js` — `activate()` registers the `@aem` chat participant, routes slash commands via a `COMMAND_HANDLERS` map, registers sidebar tree views, and registers ~20 VS Code commands.

Two handler factory patterns:
- `makeHandler(commandKey)` — read-only commands (explain, debug, scan, diff, list-skills). Scans workspace, builds context, streams AI response.
- `makeScaffoldHandler(commandKey)` — file-creating commands (new-site, new-template, new-theme, new-page, new-component, new-policy). Same flow but also parses `File: /path` + code block patterns from AI output and writes files with a confirmation QuickPick.

Special handlers: `useSkillHandler`, `runWorkflowHandler`, `buildWorkflowHandler`, `initCopilotHandler`.

### Context-First Pattern

Every command runs a full workspace scan before generating output. The scan result (`ProjectContext`) is serialized into markdown and prepended to the system prompt so the AI always has real project context.

- `src/scanner/WorkspaceScanner.js` — static class running 9 parallel detection passes (project layout, templates, components, clientlibs, pages, sling models, naming conventions, XML style, library)
- `src/scanner/ContextBuilder.js` — converts `ProjectContext` into structured markdown text for system prompts
- `src/scanner/LibraryScanner.js` — discovers skills/agents/guides/workflows from local `.aem-library/` and a shared library path (local wins on name collision)

### Prompts

`src/prompts/` — 14 prompt modules each exporting a string constant, aggregated into a `PROMPTS` dictionary in `src/prompts/index.js`, looked up by command name at runtime.

### Workflow Runner

`src/workflows/WorkflowRunner.js` — executes agent workflow steps sequentially, accumulating output from previous steps into each subsequent step's context. Supports halt-on-issues patterns and handoff buttons.

### Sidebar Views

`src/views/` — three `TreeDataProvider` implementations (LibraryTreeProvider, WorkflowsTreeProvider, CopilotInstructionsView) plus `LibraryCommands.js` for CRUD operations including an interactive agent workflow wizard.

### Copilot Instructions Manager

`src/commands/CopilotInstructionsManager.js` — manages `.github/copilot-instructions.md` with auto-generated sections between marker comments, preserving user edits on sync.

### Team Library

`.aem-library/` — bundled library of skills, agents, guides, and workflows as `.md` files (YAML frontmatter + body) and `.json` workflow definitions.

## Key Patterns

- **All scanner/builder/manager classes use static methods exclusively** — no instantiation
- **Stream-and-capture:** scaffold commands use `streamAndCapture()` to both stream to user and capture for file extraction
- **Model selection:** uses `vscode.lm.selectChatModels({ vendor: 'copilot', family: 'gpt-4o' })` via the VS Code Language Model API
- **Confirmation-gated file writing:** files are never written without explicit QuickPick confirmation
- **Event-driven sidebar refresh:** tree views auto-refresh on relevant file saves and config changes
