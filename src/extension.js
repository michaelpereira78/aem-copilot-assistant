'use strict';

const vscode = require('vscode');
const { PROMPTS } = require('./prompts/index');
const { WorkspaceScanner } = require('./scanner/WorkspaceScanner');
const { ContextBuilder } = require('./scanner/ContextBuilder');
const { LibraryScanner } = require('./scanner/LibraryScanner');
const { LibraryTreeProvider } = require('./views/LibraryTreeProvider');
const { WorkflowsTreeProvider, WorkflowItem } = require('./views/WorkflowsTreeProvider');
const LibraryCommands = require('./views/LibraryCommands');
const { CopilotInstructionsManager } = require('./commands/CopilotInstructionsManager');
const { CopilotInstructionsView }    = require('./views/CopilotInstructionsView');
const { WorkflowRunner }             = require('./workflows/WorkflowRunner');

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
 * Like streamResponse, but also captures and returns the full response text.
 */
async function streamAndCapture(contextBlock, systemPrompt, userMessage, stream, token) {
  const [model] = await vscode.lm.selectChatModels({
    vendor: 'copilot',
    family: 'gpt-4o'
  });

  if (!model) {
    stream.markdown(
      '> **AEM Assistant:** No Copilot model available. Make sure GitHub Copilot Chat is installed and signed in.'
    );
    return '';
  }

  const fullPrompt = [contextBlock, systemPrompt].join('\n\n---\n\n');
  const messages = [
    vscode.LanguageModelChatMessage.User(fullPrompt + '\n\n' + userMessage)
  ];

  const response = await model.sendRequest(messages, {}, token);
  let captured = '';
  for await (const chunk of response.text) {
    stream.markdown(chunk);
    captured += chunk;
  }
  return captured;
}

/**
 * Pending scaffold operations keyed by a random ID.
 * Populated by reviewScaffoldFiles(), consumed by the approveScaffold command.
 */
const pendingScaffolds = new Map();

/**
 * Skill/guide topics relevant to each scaffold command.
 * Used to inject matching library entries into the AI prompt.
 */
const SCAFFOLD_SKILL_TOPICS = {
  'new-component': ['components'],
  'new-template':  ['templates'],
  'new-theme':     ['themes'],
  'new-page':      ['templates', 'components'],
  'new-policy':    ['templates'],
  'new-site':      ['components', 'templates'],
};

/**
 * Build a markdown block of relevant skill/guide bodies from the library,
 * filtered to topics that match the scaffold command.
 */
function buildSkillContext(library, commandKey) {
  const topics = SCAFFOLD_SKILL_TOPICS[commandKey] || [];
  const relevant = [...library.skills, ...library.guides].filter(
    e => (topics.length === 0 || topics.includes(e.topic)) && e.body
  );
  if (relevant.length === 0) return '';

  const parts = ['## Team Library — Relevant Skills & Guides\n'];
  for (const entry of relevant) {
    parts.push(`### ${entry.name}\n${entry.body}\n`);
  }
  return parts.join('\n');
}

/**
 * Parse every  File: /jcr/path  followed by a fenced code block from the AI
 * response text.  Returns an array of { jcrPath, content } objects.
 *
 * Handles both plain  File: /path  and backtick-wrapped  File: `/path`  forms.
 * The lazy [\s\S]*? between the path line and the opening fence allows for
 * descriptive sentences the model may emit between the two.
 */
function parseFilesFromResponse(text) {
  const files = [];
  // File: /some/path  (optional prose)  ```[lang]\n<content>\n```
  const re = /File:\s*`?(\/[^\n`]+)`?\s*\n[\s\S]*?```(?:\w+)?\n([\s\S]*?)```/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    const jcrPath = match[1].trim();
    const content = match[2];
    if (jcrPath && content !== undefined) {
      files.push({ jcrPath, content });
    }
  }
  return files;
}

/**
 * Convert a JCR path (e.g. /conf/mysite/settings/wcm/templates/…)
 * to an absolute filesystem path using the roots detected by WorkspaceScanner.
 *
 * confRoot / appsRoot / contentRoot each point to the directory that
 * immediately *contains* /conf, /apps, /content (i.e. jcr_root itself).
 */
function jcrToFsPath(jcrPath, projectCtx) {
  const nodePath = require('path');
  const layout   = projectCtx.projectLayout;

  // Normalise to forward-slash, ensure leading slash
  const jcr = ('/' + jcrPath.replace(/\\/g, '/')).replace('//', '/');

  if (jcr.startsWith('/conf/')    && layout.confRoot)    return nodePath.join(layout.confRoot,    jcr);
  if (jcr.startsWith('/apps/')    && layout.appsRoot)    return nodePath.join(layout.appsRoot,    jcr);
  if (jcr.startsWith('/content/') && layout.contentRoot) return nodePath.join(layout.contentRoot, jcr);

  // Fallback: derive jcr_root from templates storageRoot when conf root is missing
  const tplRoot = projectCtx.templates && projectCtx.templates.storageRoot;
  if (tplRoot) {
    const confIdx = tplRoot.replace(/\\/g, '/').indexOf('/conf/');
    if (confIdx !== -1) {
      const jcrRoot = tplRoot.substring(0, confIdx);
      return nodePath.join(jcrRoot, jcr);
    }
  }

  // Last resort: workspace root / jcr_root / path
  return nodePath.join(projectCtx.root, 'jcr_root', jcr);
}

/**
 * Parse the AI response for File: + code-block pairs, show a review summary
 * in the chat stream, then surface Approve / Decline buttons.
 *
 * Approve → aem-copilot.approveScaffold applies all files via WorkspaceEdit
 *           (the same mechanism Copilot Edits uses) with no further prompts.
 * Decline → clears the pending operation and notifies the developer.
 */
async function reviewScaffoldFiles(responseText, projectCtx, stream) {
  const files = parseFilesFromResponse(responseText);
  if (files.length === 0) return;

  const fileItems = files.map(({ jcrPath, content }) => {
    const fsPath  = jcrToFsPath(jcrPath, projectCtx);
    const relPath = vscode.workspace.asRelativePath(vscode.Uri.file(fsPath));
    return { jcrPath, content, fsPath, relPath };
  });

  // ── Review summary ───────────────────────────────────────────────────────
  stream.markdown('\n\n---\n\n## Planned Changes\n\n');
  stream.markdown(
    `The following **${fileItems.length} file${fileItems.length !== 1 ? 's' : ''}** will be created in your workspace:\n\n`
  );
  for (const item of fileItems) {
    stream.markdown(`- \`${item.relPath}\`\n`);
  }
  stream.markdown('\n');

  // ── Register pending operation ───────────────────────────────────────────
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
  pendingScaffolds.set(id, fileItems);

  // ── Approve / Decline buttons ────────────────────────────────────────────
  stream.button({ command: 'aem-copilot.approveScaffold', arguments: [id], title: '$(check) Approve — Apply All' });
  stream.button({ command: 'aem-copilot.declineScaffold', arguments: [id], title: '$(x) Decline' });
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
 * Scaffold command handler factory.
 * Scans the workspace and team library in parallel, injects any relevant
 * skill/guide bodies into the system prompt, streams and captures the AI
 * response, then calls reviewScaffoldFiles() to present an Approve/Decline
 * review before touching any files.
 */
function makeScaffoldHandler(commandKey) {
  return async (request, _context, stream, token) => {
    stream.progress('Scanning workspace…');

    const [projectCtx, library] = await Promise.all([
      WorkspaceScanner.scan(),
      LibraryScanner.scan()
    ]);

    const contextBlock = ContextBuilder.build(projectCtx);
    const skillContext = buildSkillContext(library, commandKey);
    const systemPrompt = skillContext
      ? PROMPTS[commandKey] + '\n\n---\n\n' + skillContext
      : PROMPTS[commandKey];
    const userMessage  = buildUserMessage(request.prompt);

    const responseText = await streamAndCapture(contextBlock, systemPrompt, userMessage, stream, token);

    if (responseText) {
      await reviewScaffoldFiles(responseText, projectCtx, stream);
    }
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
 *
 * After the response streams, any handoffs defined on the matched entry are
 * surfaced as clickable buttons — mirroring the VS Code custom-agent handoffs
 * spec without giving up the explicit output-injection and workspace-context
 * advantages of the agent workflow system.
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

  // ── Handoffs ─────────────────────────────────────────────────────────────
  // Look up the invoked entry in the library and surface any handoffs it
  // declares as native VS Code chat buttons.
  const library    = projectCtx.library || { skills: [], agents: [], guides: [] };
  const allEntries = [...library.skills, ...library.agents, ...library.guides];
  const entry      = allEntries.find(e => e.name === skillName);

  if (entry && Array.isArray(entry.handoffs) && entry.handoffs.length > 0) {
    stream.markdown(`\n**Next steps:**\n`);
    for (const h of entry.handoffs) {
      stream.button({
        command:   'aem-copilot.handoffToSkill',
        arguments: [h.agent, h.prompt, h.send === true],
        title:     h.label || h.agent
      });
    }
  }
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
 * Show a searchable Quick Pick of all agent workflows in the library.
 * Returns the selected workflow object, or null if cancelled / none found.
 */
async function pickWorkflow(library) {
  if (!library.workflows || library.workflows.length === 0) return null;

  const items = library.workflows.map(w => ({
    label:       `$(circuit-board)  ${w.name}`,
    description: `${w.steps.length} step${w.steps.length !== 1 ? 's' : ''}`,
    detail:      w.description,
    workflow:    w
  }));

  const picked = await vscode.window.showQuickPick(items, {
    title:             'AEM Agent Workflows',
    placeHolder:       'Search workflows…',
    matchOnDescription: true,
    matchOnDetail:      true
  });

  return picked ? picked.workflow : null;
}

/**
 * Handler for /run-workflow.
 * - With name= parameter: runs directly.
 * - Without name=: opens a Quick Pick of available workflows.
 * Each step streams in real time; the output of each step feeds the next.
 * A step with haltOnIssues: true will stop the workflow if CRITICAL is detected.
 */
async function runWorkflowHandler(request, _context, stream, token) {
  const params = parseParams(request.prompt);

  stream.progress('Loading library…');
  const library = await LibraryScanner.scan();

  let workflow;

  if (params.name) {
    workflow = (library.workflows || []).find(w => w.name === params.name);
    if (!workflow) {
      stream.markdown(
        `> **AEM Assistant:** Agent Workflow \`${params.name}\` not found in the library.\n\n` +
        `> Available workflows: ${(library.workflows || []).map(w => `\`${w.name}\``).join(', ') || '_(none)_'}\n`
      );
      return;
    }
  } else {
    workflow = await pickWorkflow(library);
    if (!workflow) {
      // No workflows at all — fall through to the explanation prompt
      stream.progress('Scanning workspace…');
      const projectCtx = await WorkspaceScanner.scan();
      const contextBlock = ContextBuilder.build(projectCtx);
      await streamResponse(contextBlock, PROMPTS['run-workflow'], 'No workflow selected.', stream, token);
      return;
    }
    stream.markdown(`> Running workflow: **${workflow.name}**\n\n`);
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

  await WorkflowRunner.run(workflow, library, contextBlock, userParams, stream, token);
}

/**
 * Handler for /build-workflow.
 * Launches the step-by-step wizard from LibraryCommands and confirms when done.
 */
async function buildWorkflowHandler(request, _context, stream, _token) {
  stream.markdown(
    '> **AEM Assistant:** Opening the agent workflow wizard…\n\n' +
    '> Answer the prompts in VS Code to name your workflow, describe it, and add steps.\n' +
    '> The file will be saved to `.aem-library/workflows/` and available immediately.\n\n'
  );

  await LibraryCommands.createWorkflow({
    refresh: () => vscode.commands.executeCommand('aem-copilot.refreshWorkflows')
  });

  stream.markdown(
    '> Agent Workflow saved. Run it with `@aem /run-workflow` or click it in the **Agent Workflows** sidebar.\n'
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

  // ── Agent Workflows sidebar view ────────────────────────────────────────────
  const workflowsProvider = new WorkflowsTreeProvider();

  context.subscriptions.push(
    vscode.window.createTreeView('aem-copilot.workflowsView', {
      treeDataProvider: workflowsProvider,
      showCollapseAll:  true,
      canSelectMany:    false
    })
  );

  // ── Agent Workflow commands ───────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('aem-copilot.refreshWorkflows', () => {
      workflowsProvider.refresh();
    }),

    vscode.commands.registerCommand('aem-copilot.newWorkflow', async () => {
      await LibraryCommands.createWorkflow(workflowsProvider);
    }),

    // Run — copies command to clipboard and opens Copilot Chat
    vscode.commands.registerCommand('aem-copilot.runWorkflowByName', async (workflowName) => {
      const cmd = `@aem /run-workflow name=${workflowName}`;
      await vscode.env.clipboard.writeText(cmd);
      const choice = await vscode.window.showInformationMessage(
        `Command copied — paste into Copilot Chat to run workflow "${workflowName}".`,
        'Open Copilot Chat'
      );
      if (choice === 'Open Copilot Chat') {
        await vscode.commands.executeCommand('workbench.action.chat.open');
      }
    }),

    // Edit — open the workflow JSON file in the editor
    vscode.commands.registerCommand('aem-copilot.editWorkflow', async (item) => {
      if (item instanceof WorkflowItem && item.workflow.path) {
        const doc = await vscode.workspace.openTextDocument(
          vscode.Uri.file(item.workflow.path)
        );
        await vscode.window.showTextDocument(doc);
      }
    }),

    // Duplicate — copy the JSON with a new name
    vscode.commands.registerCommand('aem-copilot.duplicateWorkflow', async (item) => {
      if (!(item instanceof WorkflowItem)) return;
      const workflow = item.workflow;
      const newName  = await vscode.window.showInputBox({
        title:        'Duplicate workflow — new name',
        value:        `${workflow.name}-copy`,
        validateInput(v) {
          if (!v || !v.trim()) return 'Name is required';
          if (/\s/.test(v))    return 'No spaces — use kebab-case';
          return null;
        }
      });
      if (!newName) return;

      const dir     = require('path').dirname(workflow.path);
      const newPath = require('path').join(dir, `${newName}.json`);
      const bytes   = await vscode.workspace.fs.readFile(vscode.Uri.file(workflow.path));
      let content   = Buffer.from(bytes).toString('utf8');
      try {
        const parsed = JSON.parse(content);
        parsed.name  = newName;
        content      = JSON.stringify(parsed, null, 2);
      } catch (_) {}

      await vscode.workspace.fs.writeFile(vscode.Uri.file(newPath), Buffer.from(content, 'utf8'));
      workflowsProvider.refresh();
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(newPath));
      await vscode.window.showTextDocument(doc);
      vscode.window.showInformationMessage(`Workflow duplicated: ${newName}`);
    }),

    // Rename — update name field + rename file
    vscode.commands.registerCommand('aem-copilot.renameWorkflow', async (item) => {
      if (!(item instanceof WorkflowItem)) return;
      const workflow = item.workflow;
      const oldName  = workflow.name;
      const newName  = await vscode.window.showInputBox({
        title: 'Rename workflow',
        value: oldName,
        validateInput(v) {
          if (!v || !v.trim()) return 'Name is required';
          if (/\s/.test(v))    return 'No spaces — use kebab-case';
          if (v === oldName)   return 'Name is unchanged';
          return null;
        }
      });
      if (!newName) return;

      const oldPath = workflow.path;
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
      workflowsProvider.refresh();
      vscode.window.showInformationMessage(`Workflow renamed to: ${newName}`);
    }),

    // Delete — with confirmation
    vscode.commands.registerCommand('aem-copilot.deleteWorkflow', async (item) => {
      if (!(item instanceof WorkflowItem)) return;
      const workflow = item.workflow;
      const confirm  = await vscode.window.showWarningMessage(
        `Delete workflow "${workflow.name}"? This cannot be undone.`,
        { modal: true },
        'Delete'
      );
      if (confirm !== 'Delete') return;
      await vscode.workspace.fs.delete(vscode.Uri.file(workflow.path));
      workflowsProvider.refresh();
      vscode.window.showInformationMessage(`Deleted: ${workflow.name}`);
    }),

    // ── Scaffold Approve / Decline ─────────────────────────────────────────
    vscode.commands.registerCommand('aem-copilot.approveScaffold', async (id) => {
      const fileItems = pendingScaffolds.get(id);
      if (!fileItems) {
        vscode.window.showWarningMessage('AEM Copilot: Scaffold operation has already been applied or cancelled.');
        return;
      }
      pendingScaffolds.delete(id);

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'AEM Copilot: Applying scaffold…', cancellable: false },
        async () => {
          const nodePath = require('path');

          // Parent directories must exist before WorkspaceEdit creates the files
          for (const item of fileItems) {
            await vscode.workspace.fs.createDirectory(vscode.Uri.file(nodePath.dirname(item.fsPath)));
          }

          // Apply all files in one atomic WorkspaceEdit — the same mechanism
          // Copilot Edits uses, so changes land in the undo stack and diff view.
          const edit = new vscode.WorkspaceEdit();
          for (const item of fileItems) {
            edit.createFile(vscode.Uri.file(item.fsPath), {
              overwrite: true,
              contents:  Buffer.from(item.content, 'utf8')
            });
          }

          const success = await vscode.workspace.applyEdit(edit);

          if (success) {
            // Open the first created file so the developer sees it immediately
            try {
              const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fileItems[0].fsPath));
              await vscode.window.showTextDocument(doc);
            } catch (_) {}

            vscode.window.showInformationMessage(
              `AEM Copilot: ${fileItems.length} file${fileItems.length !== 1 ? 's' : ''} applied to workspace.`
            );
          } else {
            vscode.window.showErrorMessage('AEM Copilot: Could not apply scaffold — check the Output panel for details.');
          }
        }
      );
    }),

    vscode.commands.registerCommand('aem-copilot.declineScaffold', async (id) => {
      pendingScaffolds.delete(id);
      vscode.window.showInformationMessage('AEM Copilot: Scaffold declined — no files were written.');
    }),

    // ── Handoff command ────────────────────────────────────────────────────
    // Called by stream.button() handoff buttons on both workflow completion
    // and standalone /use-skill responses.
    //
    // Mirrors the VS Code custom-agent handoffs spec:
    //   - send=false (default): copies the command to clipboard and opens chat
    //     so the developer can review and submit manually
    //   - send=true: copies AND opens chat (user still clicks Submit, but the
    //     prompt is pre-filled — full auto-submit is not supported via the
    //     VS Code API today)
    vscode.commands.registerCommand(
      'aem-copilot.handoffToSkill',
      async (agentName, prompt, _send) => {
        if (!agentName) return;
        const text = prompt
          ? `@aem /use-skill name=${agentName} ${prompt}`
          : `@aem /use-skill name=${agentName}`;

        await vscode.env.clipboard.writeText(text);
        const choice = await vscode.window.showInformationMessage(
          `Handoff to "${agentName}" — command copied to clipboard. Paste it into Copilot Chat to continue.`,
          'Open Copilot Chat'
        );
        if (choice === 'Open Copilot Chat') {
          await vscode.commands.executeCommand('workbench.action.chat.open');
        }
      }
    )
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
  'run-workflow':   runWorkflowHandler,
  'build-workflow': buildWorkflowHandler,
  'init-copilot':  initCopilotHandler,
  'new-site':      makeScaffoldHandler('new-site'),
  'new-template':  makeScaffoldHandler('new-template'),
  'new-theme':     makeScaffoldHandler('new-theme'),
  'new-page':      makeScaffoldHandler('new-page'),
  'new-component': makeScaffoldHandler('new-component'),
  'new-policy':    makeScaffoldHandler('new-policy'),
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
      '| `/run-workflow` | Run an agent workflow — chains agents in sequence, each receiving the previous step\'s output |',
      '| `/build-workflow` | Step-by-step wizard to compose and save a new agent workflow |',
      '',
      '> Parameters are optional — if your workspace is already set up, I will detect site name, paths, naming conventions, and existing patterns automatically.',
      '',
      '**Team library:** After scaffold commands, clickable suggestions will appear below the response — just click to run a related skill or agent.',
      'You can also type `/use-skill` with no arguments to open a searchable picker of everything in the library.',
    ].join('\n'));
  }
};

module.exports = { activate, deactivate };
