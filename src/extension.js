'use strict';

const vscode = require('vscode');
const { PROMPTS } = require('./prompts/index');

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
 * Build the user message to send to the model, combining the
 * system prompt for the command with the parsed user parameters.
 */
function buildUserMessage(commandName, userInput) {
  const params = parseParams(userInput);
  const paramSummary = Object.entries(params)
    .filter(([k]) => k !== '_rest')
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ');

  const extraContext = params._rest
    ? `\n\nAdditional context from the developer:\n${params._rest}`
    : '';

  return `Parameters provided: ${paramSummary || '(none — use sensible defaults)'}${extraContext}`;
}

/**
 * Stream a response from the Copilot language model back to the chat.
 */
async function streamResponse(systemPrompt, userMessage, stream, token) {
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

  const messages = [
    vscode.LanguageModelChatMessage.User(systemPrompt + '\n\n' + userMessage)
  ];

  const response = await model.sendRequest(messages, {}, token);

  for await (const chunk of response.text) {
    stream.markdown(chunk);
  }
}

/**
 * Generic command handler factory.
 * Each slash command calls this with its own system prompt key.
 */
function makeHandler(commandKey) {
  return async (request, _context, stream, token) => {
    const systemPrompt = PROMPTS[commandKey];
    const userMessage = buildUserMessage(commandKey, request.prompt);
    await streamResponse(systemPrompt, userMessage, stream, token);
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
  '_default': async (_request, _ctx, stream) => {
    stream.markdown([
      '## AEM Assistant',
      '',
      'Available commands:',
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
    ].join('\n'));
  }
};

module.exports = { activate, deactivate };
