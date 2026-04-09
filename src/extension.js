'use strict';

const vscode = require('vscode');
const { PROMPTS } = require('./prompts/index');
const { WorkspaceScanner } = require('./scanner/WorkspaceScanner');
const { ContextBuilder } = require('./scanner/ContextBuilder');
const { LibraryScanner } = require('./scanner/LibraryScanner');
const { LibraryTreeProvider } = require('./views/LibraryTreeProvider');
const { PipelinesTreeProvider, PipelineItem } = require('./views/PipelinesTreeProvider');
const LibraryCommands = require('./views/LibraryCommands');
const { CopilotInstructionsManager } = require('./commands/CopilotInstructionsManager');
const { CopilotInstructionsView }    = require('./views/CopilotInstructionsView');
const { PipelineRunner }             = require('./pipelines/PipelineRunner');

/**
 * Parse named parameters from a Copilot slash command input.
 * Supports: key=value  and  key="multi word value"
 * Returns an object plus any remaining unparsed text as `_rest`.
 *
 * Example input: siteName=my-brand groupId=com.mybrand
 * Returns: { siteName: 'my-brand', groupId: 'com.mybrand', _rest: '' }
 */
function parseParams(text) {
  const params = { _rest: '' };
  const regex = /(\w+)=(?:"([^"]*)"|([\S]+))/g;
  let match;
  let cleaned = text;
  while ((match = regex.exec(text)) !== null) {
    params[match[1]] = match[2] !== undefined ? match[2] : match[3];
    cleaned = cleaned.replace(match[0], '');
  }
  params._rest = cleaned.trim();
  return params;
}

/**
 * Build the user message from the command's named parameters.
 */
function buildUserMessage(userInput) {
  const params = parseParams(userInput);
  const paramSummary = Object.entries(params)
    .filter(([k]) => k !== '_rest')
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ');

  const extraContext = params._rest
    ? `\n\nAdditional context from the developer:\n${params._rest}`
    : '';

  return `Parameters provided: ${paramSummary || '(none — derive from workspace context above)'}${extraContext}`;
}

/**
 * Stream a response from the Copilot language model back to the chat.
 * The full prompt = workspace context block + system prompt + user message.
 */
async function streamResponse(contextBlock, systemPrompt, userMessage, stream, token) {
  const [model] = await vscode.lm.selectChatModels({
    vendor: 'copilot',
    family: 'gpt-4o'
  });

  if (!model) {
    stream.markdown(
      '> **AEM Assistant:** No Copilot model available. Make sure GitHub Copilot Chat is installed and signed in.'
    );
    return;
  }

  // Context block is prepended so the model reads project reality before instructions
  const fullPrompt = [contextBlock, systemPrompt].join('\n\n---\n\n');

  const messages = [
    vscode.LanguageModelChatMessage.User(fullPrompt + '\n\n' + userMessage)
  ];

  const response = await model.sendRequest(messages, {}, token);
  for await (const chunk of response.text) {
    stream.markdown(chunk);
  }
}

/**
 * Generic context-aware command handler factory.
 *
 * On every invocation:
 * 1. Silently scans the workspace (WorkspaceScanner)
 * 2. Builds a context block describing the real project (ContextBuilder)
 * 3. Prepends the context block to the system prompt
 * 4. Streams the response
 */
function makeHandler(commandKey) {
  return async (request, _context, stream, token) => {
    stream.progress('Scanning workspace…');

    const projectCtx = await WorkspaceScanner.scan();
    const contextBlock = ContextBuilder.build(projectCtx);

    const systemPrompt = PROMPTS[commandKey];
    const userMessage = buildUserMessage(request.prompt);

    await streamResponse(contextBlock, systemPrompt, userMessage, stream, token);
  };
}

/**
 * Show a searchable Quick Pick populated from the team library.
 * Returns the selected entry object, or null if the user cancelled.
 */
async function pickFromLibrary() {
  const library = await LibraryScanner.scan();
  const items = [];

  for (const skill of library.skills) {
    items.push({
      label: `$(symbol-method)  ${skill.name}`,
      description: `Skill  ·  ${skill.topic}`,
      detail: skill.description,
      entry: skill,
      invokeAs: skill.name
    });
  }

  for (const agent of library.agents) {
    items.push({
      label: `$(robot)  ${agent.name}`,
      description: `Agent  ·  ${agent.topic}  ·  ${agent.model}`,
      detail: agent.description,
      entry: agent,
      invokeAs: agent.name
    });
  }

  for (const guide of library.guides) {
    items.push({
      label: `$(book)  ${guide.name}`,
      description: `Guide  ·  ${guide.topic}`,
      detail: guide.description,
      entry: guide,
      invokeAs: guide.name
    });
  }

  if (items.length === 0) {
    vscode.window.showInformationMessage(
      'No team library found. Add a .aem-library/ folder to your workspace root, or set aem-copilot.libraryPath in settings.'
    );
    return null;
  }

  return vscode.window.showQuickPick(items, {
    title: 'AEM Team Library',
    placeHolder: 'Search skills, agents, and guides…',
    matchOnDescription: true,
    matchOnDetail: true
  });
}

/**
 * Handler for /use-skill.
 * - With name= parameter: invokes directly (power-user path).
 * - Without name=: opens a Quick Pick so the developer can browse and select.
 */
async function useSkillHandler(request, _context, stream, token) {
  const params = parseParams(request.prompt);

  let skillName = params.name;

  if (!skillName) {
    const picked = await pickFromLibrary();
    if (!picked) return; // user cancelled
    skillName = picked.invokeAs;
    stream.markdown(`> Invoking **${skillName}**\n\n`);
  }

  stream.progress('Scanning workspace…');
  const projectCtx = await WorkspaceScanner.scan();
  const contextBlock = ContextBuilder.build(projectCtx);

  // Rebuild user message with the resolved name injected
  const resolvedInput = `name=${skillName}` + (params._rest ? ` ${params._rest}` : '');
  const userMessage = buildUserMessage(resolvedInput);

  await streamResponse(contextBlock, PROMPTS['use-skill'], userMessage, stream, token);
}

/**
 * Maps each command to the library topics / entry names most relevant after it runs.
 * Used by the followup provider to surface skill/agent suggestions.
 */
const COMMAND_FOLLOWUP_HINTS = {
  'new-component': { topics: ['components', 'review'], agents: ['component-reviewer', 'accessibility-auditor', 'htl-refactor'] },
  'new-template':  { topics: ['templates'], agents: [] },
  'new-theme':     { topics: ['themes'], agents: [] },
  'new-page':      { topics: ['templates', 'components'], agents: [] },
  'new-policy':    { topics: ['templates'], agents: [] },
  'new-site':      { topics: ['components', 'templates', 'deployment'], agents: ['migration-helper'] },
  'diff':          { topics: ['review', 'migration'], agents: ['migration-helper', 'component-reviewer', 'accessibility-auditor'] },
  'debug':         { topics: ['debugging'], agents: ['htl-refactor'] },
  'scan':          { topics: ['review', 'deployment'], agents: ['component-reviewer', 'migration-helper'] }
};

/**
 * Show a searchable Quick Pick of all pipelines in the library.
 * Returns the selected pipeline object, or null if cancelled / none found.
 */
async function pickPipeline(library) {
  if (!library.pipelines || library.pipelines.length === 0) return null;

  const items = library.pipelines.map(p => ({
    label:       `$(circuit-board)  ${p.name}`,
    description: `${p.steps.length} step${p.steps.length !== 1 ? 's' : ''}`,
    detail:      p.description,
    pipeline:    p
  }));

  const picked = await vscode.window.showQuickPick(items, {
    title:             'AEM Pipelines',
    placeHolder:       'Search pipelines…',
    matchOnDescription: true,
    matchOnDetail:      true
  });

  return picked ? picked.pipeline : null;
}

/**
 * Handler for /run-pipeline.
 * - With name= parameter: runs directly.
 * - Without name=: opens a Quick Pick of available pipelines.
 * Each step streams in real time; the output of each step feeds the next.
 * A step with haltOnIssues: true will stop the pipeline if CRITICAL is detected.
 */
async function runPipelineHandler(request, _context, stream, token) {
  const params = parseParams(request.prompt);

  stream.progress('Loading library…');
  const library = await LibraryScanner.scan();

  let pipeline;

  if (params.name) {
    pipeline = (library.pipelines || []).find(p => p.name === params.name);
    if (!pipeline) {
      stream.markdown(
        `> **AEM Assistant:** Pipeline \`${params.name}\` not found in the library.\n\n` +
        `> Available pipelines: ${(library.pipelines || []).map(p => `\`${p.name}\``).join(', ') || '_(none)_'}\n`
      );
      return;
    }
  } else {
    pipeline = await pickPipeline(library);
    if (!pipeline) {
      // No pipelines at all — fall through to the explanation prompt
      stream.progress('Scanning workspace…');
      const projectCtx = await WorkspaceScanner.scan();
      const contextBlock = ContextBuilder.build(projectCtx);
      await streamResponse(contextBlock, PROMPTS['run-pipeline'], 'No pipeline selected.', stream, token);
      return;
    }
    stream.markdown(`> Running pipeline: **${pipeline.name}**\n\n`);
  }

  stream.progress('Scanning workspace…');
  const projectCtx   = await WorkspaceScanner.scan();
  const contextBlock = ContextBuilder.build(projectCtx);

  // Build user params string (strip name=, pass the rest)
  const { name: _n, _rest, ...otherParams } = params;
  const userParams = [
    Object.entries(otherParams).map(([k, v]) => `${k}=${v}`).join(' '),
    _rest
  ].filter(Boolean).join(' ').trim();

  await PipelineRunner.run(pipeline, library, contextBlock, userParams, stream, token);
}

/**
 * Handler for /build-pipeline.
 * Launches the step-by-step wizard from LibraryCommands and confirms when done.
 */
async function buildPipelineHandler(request, _context, stream, _token) {
  stream.markdown(
    '> **AEM Assistant:** Opening the pipeline wizard…\n\n' +
    '> Answer the prompts in VS Code to name your pipeline, describe it, and add steps.\n' +
    '> The file will be saved to `.aem-library/pipelines/` and available immediately.\n\n'
  );

  await LibraryCommands.createPipeline({
    refresh: () => vscode.commands.executeCommand('aem-copilot.refreshLibrary')
  });

  stream.markdown(
    '> Pipeline saved. Run it with `@aem /run-pipeline` or click it in the **AEM Library** sidebar.\n'
  );
}

/**
 * Handler for /init-copilot.
 * 1. Scans the workspace.
 * 2. Writes (or syncs) .github/copilot-instructions.md.
 * 3. Streams an AI explanation of what was written and what to do next.
 * 4. Offers an Open button as a follow-up action.
 */
async function initCopilotHandler(request, _context, stream, token) {
  stream.progress('Scanning workspace…');

  const projectCtx = await WorkspaceScanner.scan();

  let filePath;
  let isSync = false;
  try {
    isSync   = await CopilotInstructionsManager.exists();
    filePath = await CopilotInstructionsManager.write(projectCtx);
    const relPath = vscode.workspace.asRelativePath(filePath);
    stream.markdown(`> **AEM Assistant:** \`${relPath}\` ${isSync ? 'synced' : 'created'} — Copilot will read it automatically.\n\n`);
  } catch (err) {
    stream.markdown(`> **Error:** Could not write copilot-instructions.md — ${err.message}\n\n`);
    return;
  }

  // Refresh the sidebar panel so it picks up the new status immediately
  vscode.commands.executeCommand('aem-copilot.refreshInstructionsView');

  // Use AI to explain what was done and recommend next steps
  const contextBlock = ContextBuilder.build(projectCtx);
  const userMessage  = `The file .github/copilot-instructions.md was just ${isSync ? 'synced' : 'created'}. ${request.prompt}`;
  await streamResponse(contextBlock, PROMPTS['init-copilot'], userMessage, stream, token);

  stream.button({
    command: 'aem-copilot.openCopilotInstructions',
    title: '$(go-to-file) Open copilot-instructions.md'
  });
}

/**
 * Extension activation — registers the @aem chat participant
 * and wires up all slash command handlers.
 */
function activate(context) {
  const participant = vscode.chat.createChatParticipant(
    'aem-copilot-assistant.aem',
    async (request, ctx, stream, token) => {
      const handler = COMMAND_HANDLERS[request.command] ?? COMMAND_HANDLERS['_default'];
      await handler(request, ctx, stream, token);
    }
  );

  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'icon.png');

  // ── Sidebar tree view ────────────────────────────────────────────────────────
  const treeProvider = new LibraryTreeProvider();

  const treeView = vscode.window.createTreeView('aem-copilot.libraryView', {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
    canSelectMany: false
  });

  context.subscriptions.push(treeView);

  // ── CRUD commands ────────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('aem-copilot.refreshLibrary', () => {
      treeProvider.refresh();
    }),

    // Generic "New…" from the view toolbar — asks what type first
    vscode.commands.registerCommand('aem-copilot.newEntry', async () => {
      const pick = await vscode.window.showQuickPick(
        [
          { label: '$(symbol-method)  Skill',  description: 'Prompt instructions for a specific task', type: 'skills' },
          { label: '$(robot)  Agent',           description: 'Claude agent with a defined persona and output format', type: 'agents' },
          { label: '$(book)  Guide',            description: 'Reference documentation or checklist', type: 'guides' }
        ],
        { title: 'New library entry — choose type', placeHolder: 'What do you want to create?' }
      );
      if (pick) await LibraryCommands.createEntry(pick.type, treeProvider);
    }),

    // Category right-click → New Skill / Agent / Guide (type is already known)
    vscode.commands.registerCommand('aem-copilot.newSkill',
      () => LibraryCommands.createEntry('skills', treeProvider)),
    vscode.commands.registerCommand('aem-copilot.newAgent',
      () => LibraryCommands.createEntry('agents', treeProvider)),
    vscode.commands.registerCommand('aem-copilot.newGuide',
      () => LibraryCommands.createEntry('guides', treeProvider)),

    // Item actions
    vscode.commands.registerCommand('aem-copilot.editEntry',
      item => LibraryCommands.editEntry(item)),
    vscode.commands.registerCommand('aem-copilot.renameEntry',
      item => LibraryCommands.renameEntry(item, treeProvider)),
    vscode.commands.registerCommand('aem-copilot.duplicateEntry',
      item => LibraryCommands.duplicateEntry(item, treeProvider)),
    vscode.commands.registerCommand('aem-copilot.deleteEntry',
      item => LibraryCommands.deleteEntry(item, treeProvider))
  );

  // ── Copilot Instructions sidebar view ────────────────────────────────────────
  const instructionsView = new CopilotInstructionsView();

  context.subscriptions.push(
    vscode.window.createTreeView('aem-copilot.instructionsView', {
      treeDataProvider: instructionsView,
      showCollapseAll: false
    })
  );

  // ── Copilot Instructions commands ─────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('aem-copilot.refreshInstructionsView', () => {
      instructionsView.refresh();
    }),

    vscode.commands.registerCommand('aem-copilot.generateCopilotInstructions', async () => {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'AEM Copilot: Scanning workspace…', cancellable: false },
        async () => {
          const projectCtx = await WorkspaceScanner.scan();
          const filePath   = await CopilotInstructionsManager.write(projectCtx);
          instructionsView.refresh();
          const relPath = vscode.workspace.asRelativePath(filePath);
          const choice  = await vscode.window.showInformationMessage(
            `AEM Copilot: \`${relPath}\` created.`,
            'Open file'
          );
          if (choice === 'Open file') await CopilotInstructionsManager.open();
        }
      );
    }),

    vscode.commands.registerCommand('aem-copilot.syncCopilotInstructions', async () => {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'AEM Copilot: Syncing instructions…', cancellable: false },
        async () => {
          const projectCtx = await WorkspaceScanner.scan();
          await CopilotInstructionsManager.write(projectCtx);
          instructionsView.refresh();
          vscode.window.showInformationMessage('AEM Copilot: copilot-instructions.md synced.');
        }
      );
    }),

    vscode.commands.registerCommand('aem-copilot.openCopilotInstructions', () => {
      CopilotInstructionsManager.open();
    })
  );

  // ── Pipelines sidebar view ───────────────────────────────────────────────────
  const pipelinesProvider = new PipelinesTreeProvider();

  context.subscriptions.push(
    vscode.window.createTreeView('aem-copilot.pipelinesView', {
      treeDataProvider: pipelinesProvider,
      showCollapseAll:  true,
      canSelectMany:    false
    })
  );

  // ── Pipeline commands ─────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('aem-copilot.refreshPipelines', () => {
      pipelinesProvider.refresh();
    }),

    vscode.commands.registerCommand('aem-copilot.newPipeline', async () => {
      await LibraryCommands.createPipeline(pipelinesProvider);
    }),

    // Run — copies command to clipboard and opens Copilot Chat
    vscode.commands.registerCommand('aem-copilot.runPipelineByName', async (pipelineName) => {
      const cmd = `@aem /run-pipeline name=${pipelineName}`;
      await vscode.env.clipboard.writeText(cmd);
      const choice = await vscode.window.showInformationMessage(
        `Command copied — paste into Copilot Chat to run pipeline "${pipelineName}".`,
        'Open Copilot Chat'
      );
      if (choice === 'Open Copilot Chat') {
        await vscode.commands.executeCommand('workbench.action.chat.open');
      }
    }),

    // Edit — open the pipeline JSON file in the editor
    vscode.commands.registerCommand('aem-copilot.editPipeline', async (item) => {
      if (item instanceof PipelineItem && item.pipeline.path) {
        const doc = await vscode.workspace.openTextDocument(
          vscode.Uri.file(item.pipeline.path)
        );
        await vscode.window.showTextDocument(doc);
      }
    }),

    // Duplicate — copy the JSON with a new name
    vscode.commands.registerCommand('aem-copilot.duplicatePipeline', async (item) => {
      if (!(item instanceof PipelineItem)) return;
      const pipeline = item.pipeline;
      const newName  = await vscode.window.showInputBox({
        title:        'Duplicate pipeline — new name',
        value:        `${pipeline.name}-copy`,
        validateInput(v) {
          if (!v || !v.trim()) return 'Name is required';
          if (/\s/.test(v))    return 'No spaces — use kebab-case';
          return null;
        }
      });
      if (!newName) return;

      const dir     = require('path').dirname(pipeline.path);
      const newPath = require('path').join(dir, `${newName}.json`);
      const bytes   = await vscode.workspace.fs.readFile(vscode.Uri.file(pipeline.path));
      let content   = Buffer.from(bytes).toString('utf8');
      try {
        const parsed = JSON.parse(content);
        parsed.name  = newName;
        content      = JSON.stringify(parsed, null, 2);
      } catch (_) {}

      await vscode.workspace.fs.writeFile(vscode.Uri.file(newPath), Buffer.from(content, 'utf8'));
      pipelinesProvider.refresh();
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(newPath));
      await vscode.window.showTextDocument(doc);
      vscode.window.showInformationMessage(`Pipeline duplicated: ${newName}`);
    }),

    // Rename — update name field + rename file
    vscode.commands.registerCommand('aem-copilot.renamePipeline', async (item) => {
      if (!(item instanceof PipelineItem)) return;
      const pipeline = item.pipeline;
      const oldName  = pipeline.name;
      const newName  = await vscode.window.showInputBox({
        title: 'Rename pipeline',
        value: oldName,
        validateInput(v) {
          if (!v || !v.trim()) return 'Name is required';
          if (/\s/.test(v))    return 'No spaces — use kebab-case';
          if (v === oldName)   return 'Name is unchanged';
          return null;
        }
      });
      if (!newName) return;

      const oldPath = pipeline.path;
      const dir     = require('path').dirname(oldPath);
      const newPath = require('path').join(dir, `${newName}.json`);
      const bytes   = await vscode.workspace.fs.readFile(vscode.Uri.file(oldPath));
      let content   = Buffer.from(bytes).toString('utf8');
      try {
        const parsed = JSON.parse(content);
        parsed.name  = newName;
        content      = JSON.stringify(parsed, null, 2);
      } catch (_) {}

      await vscode.workspace.fs.writeFile(vscode.Uri.file(newPath), Buffer.from(content, 'utf8'));
      await vscode.workspace.fs.delete(vscode.Uri.file(oldPath));
      pipelinesProvider.refresh();
      vscode.window.showInformationMessage(`Pipeline renamed to: ${newName}`);
    }),

    // Delete — with confirmation
    vscode.commands.registerCommand('aem-copilot.deletePipeline', async (item) => {
      if (!(item instanceof PipelineItem)) return;
      const pipeline = item.pipeline;
      const confirm  = await vscode.window.showWarningMessage(
        `Delete pipeline "${pipeline.name}"? This cannot be undone.`,
        { modal: true },
        'Delete'
      );
      if (confirm !== 'Delete') return;
      await vscode.workspace.fs.delete(vscode.Uri.file(pipeline.path));
      pipelinesProvider.refresh();
      vscode.window.showInformationMessage(`Deleted: ${pipeline.name}`);
    })
  );

  /**
   * Followup provider — surfaces relevant skills and agents as clickable
   * suggestion chips below responses. Only shows entries that actually exist
   * in the team library, so suggestions are never empty promises.
   */
  participant.followupProvider = {
    provideFollowups: async (request, _context, _token) => {
      const hints = COMMAND_FOLLOWUP_HINTS[request.command];
      if (!hints) return [];

      const library = await LibraryScanner.scan();
      const allEntries = [...library.skills, ...library.agents, ...library.guides];
      if (allEntries.length === 0) return [];

      const followups = [];

      // Prioritise named agents that exist in the library
      for (const agentName of hints.agents) {
        const found = allEntries.find(e => e.name === agentName);
        if (found) {
          followups.push({
            prompt: `/use-skill name=${found.name}`,
            label: `$(robot) ${found.name}`,
            title: found.description
          });
        }
      }

      // Fill remaining slots with topic-matched skills/guides (up to 3 total)
      if (followups.length < 3) {
        const topicMatches = allEntries.filter(
          e => hints.topics.includes(e.topic) &&
               !hints.agents.includes(e.name) &&
               followups.length < 3
        );
        for (const entry of topicMatches) {
          followups.push({
            prompt: `/use-skill name=${entry.name}`,
            label: `$(symbol-method) ${entry.name}`,
            title: entry.description
          });
          if (followups.length >= 3) break;
        }
      }

      // Always offer the library browser as the last option
      followups.push({
        prompt: `/list-skills`,
        label: '$(library) Browse team library',
        title: 'See all available skills, agents, and guides'
      });

      return followups;
    }
  };

  context.subscriptions.push(participant);
}

function deactivate() {}

const COMMAND_HANDLERS = {
  'run-pipeline':  runPipelineHandler,
  'build-pipeline': buildPipelineHandler,
  'init-copilot':  initCopilotHandler,
  'new-site':      makeHandler('new-site'),
  'new-template':  makeHandler('new-template'),
  'new-theme':     makeHandler('new-theme'),
  'new-page':      makeHandler('new-page'),
  'new-component': makeHandler('new-component'),
  'new-policy':    makeHandler('new-policy'),
  'explain':       makeHandler('explain'),
  'debug':         makeHandler('debug'),
  'scan':          makeHandler('scan'),
  'diff':          makeHandler('diff'),
  'list-skills':   makeHandler('list-skills'),
  'use-skill':     useSkillHandler,
  '_default': async (_request, _ctx, stream) => {
    stream.markdown([
      '## AEM Assistant',
      '',
      'I scan your workspace before every command so all output matches your project\'s actual paths, naming, and structure.',
      '',
      '| Command | What it does |',
      '|---------|-------------|',
      '| `/new-site siteName=x groupId=y` | Full site folder scaffold + setup steps |',
      '| `/new-template name=x site=y` | Editable template XML + enable steps |',
      '| `/new-theme name=x site=y components=a,b` | ClientLib + SCSS stubs + wiring steps |',
      '| `/new-page title=x site=y template=z depth=standard` | Page `.content.xml` + parsys nodes |',
      '| `/new-component name=x site=y group=y` | Node + HTL + Sling model + dialog |',
      '| `/new-policy component=x template=y site=z` | Policy XML + template wiring steps |',
      '| `/explain topic="..."` | Plain-English AEM concept explanation |',
      '| `/debug [paste error or file]` | Root cause + fix + verification steps |',
      '| `/scan` | Show everything the scanner detected about this project |',
      '| `/diff` | Compare project structure against AEM 6.5 best practices |',
      '| `/list-skills` | Browse the team library: skills, agents, and guides |',
      '| `/use-skill` | Pick a skill, agent, or guide from a searchable menu |',
      '| `/init-copilot` | Generate or sync `.github/copilot-instructions.md` from a workspace scan |',
      '| `/run-pipeline` | Run a pipeline — chains agents in sequence, each receiving the previous step\'s output |',
      '| `/build-pipeline` | Step-by-step wizard to compose and save a new pipeline |',
      '',
      '> Parameters are optional — if your workspace is already set up, I will detect site name, paths, naming conventions, and existing patterns automatically.',
      '',
      '**Team library:** After scaffold commands, clickable suggestions will appear below the response — just click to run a related skill or agent.',
      'You can also type `/use-skill` with no arguments to open a searchable picker of everything in the library.',
    ].join('\n'));
  }
};

module.exports = { activate, deactivate };
