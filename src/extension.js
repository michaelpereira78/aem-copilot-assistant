'use strict';

const vscode = require('vscode');
const { PROMPTS } = require('./prompts/index');
const { WorkspaceScanner } = require('./scanner/WorkspaceScanner');
const { ContextBuilder } = require('./scanner/ContextBuilder');

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
  'use-skill':     makeHandler('use-skill'),
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
      '| `/use-skill name=x` | Invoke a named skill, agent, or guide from the team library |',
      '',
      '> Parameters are optional — if your workspace is already set up, I will detect site name, paths, naming conventions, and existing patterns automatically.',
      '',
      '**Team library:** Place `.md` skills and `.json` agents in `.aem-library/skills/`, `.aem-library/agents/`, or `.aem-library/guides/` at the workspace root.',
      'To share across projects, set `aem-copilot.libraryPath` in VS Code settings to your shared library folder.',
    ].join('\n'));
  }
};

module.exports = { activate, deactivate };
