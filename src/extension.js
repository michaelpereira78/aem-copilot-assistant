'use strict';

const vscode = require('vscode');
const { PROMPTS } = require('./prompts/index');
const { WorkspaceScanner } = require('./scanner/WorkspaceScanner');
const { ContextBuilder } = require('./scanner/ContextBuilder');
const { LibraryScanner } = require('./scanner/LibraryScanner');
const { LibraryTreeProvider } = require('./views/LibraryTreeProvider');
const LibraryCommands = require('./views/LibraryCommands');

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
      '',
      '> Parameters are optional — if your workspace is already set up, I will detect site name, paths, naming conventions, and existing patterns automatically.',
      '',
      '**Team library:** After scaffold commands, clickable suggestions will appear below the response — just click to run a related skill or agent.',
      'You can also type `/use-skill` with no arguments to open a searchable picker of everything in the library.',
    ].join('\n'));
  }
};

module.exports = { activate, deactivate };
