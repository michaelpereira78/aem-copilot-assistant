'use strict';

const vscode = require('vscode');

// Keywords that signal a step has found critical issues and the pipeline should halt.
const HALT_PATTERNS = [
  /\bCRITICAL ISSUES FOUND\b/i,
  /verdict.*CRITICAL/i,
  /🛑.*CRITICAL/,
  /\bCRITICAL\b.*\bfinding/i
];

class PipelineRunner {

  /**
   * Execute a pipeline definition sequentially.
   *
   * @param {object}   pipeline     - Pipeline definition from .aem-library/pipelines/*.json
   * @param {object}   library      - Result of LibraryScanner.scan()
   * @param {string}   contextBlock - Workspace context from ContextBuilder.build()
   * @param {string}   userParams   - Raw parameter string from the developer's message
   * @param {object}   stream       - VS Code chat response stream
   * @param {object}   token        - Cancellation token
   */
  static async run(pipeline, library, contextBlock, userParams, stream, token) {
    const steps = pipeline.steps || [];
    const total = steps.length;

    // ── Pipeline header ──────────────────────────────────────────────────────
    stream.markdown(
      `# Pipeline: ${pipeline.name}\n\n` +
      `_${pipeline.description}_\n\n` +
      `**${total} step${total !== 1 ? 's' : ''}** will run in sequence. ` +
      `Each step receives the full output of all previous steps as context.\n\n`
    );

    let pipelineContext = '';  // grows as each step completes

    for (let i = 0; i < total; i++) {
      const step = steps[i];
      const stepNum = i + 1;

      if (token.isCancellationRequested) {
        stream.markdown(`\n---\n\n> Pipeline cancelled by user.\n`);
        return;
      }

      // ── Step header ────────────────────────────────────────────────────────
      stream.markdown(`\n---\n\n## Step ${stepNum} of ${total} — ${step.label}\n\n`);
      stream.progress(`Step ${stepNum}/${total}: ${step.label}…`);

      // ── Resolve entry ──────────────────────────────────────────────────────
      const entryName = step.skill || step.agent || step.guide;
      const entry = PipelineRunner._findEntry(entryName, library);

      if (!entry) {
        stream.markdown(
          `> ⚠️ **Step skipped** — \`${entryName}\` was not found in the team library.\n` +
          `> Add it to \`.aem-library/\` or check the name in the pipeline definition.\n\n`
        );
        continue;
      }

      // ── Build step prompt ──────────────────────────────────────────────────
      const systemPrompt = PipelineRunner._buildStepPrompt(
        entry, pipelineContext, stepNum, total, step.label
      );

      const userMessage =
        `You are running pipeline step ${stepNum} of ${total}: "${step.label}".\n\n` +
        `Developer parameters: ${userParams || '(none — derive all values from workspace context)'}\n\n` +
        `Workspace context is in the block above. ` +
        (pipelineContext
          ? `Previous step output is included in your system prompt above — treat it as direct input.`
          : `This is the first step — generate from the workspace context and developer parameters.`);

      // ── Stream and capture ─────────────────────────────────────────────────
      let stepOutput = '';
      try {
        stepOutput = await PipelineRunner._streamAndCapture(
          contextBlock, systemPrompt, userMessage, stream, token
        );
      } catch (err) {
        stream.markdown(`\n\n> ⚠️ **Step error:** ${err.message}\n\n`);
        continue;
      }

      // Append this step's output to the running context for downstream steps
      pipelineContext +=
        `\n\n---\n\n` +
        `### Pipeline step ${stepNum} completed: "${step.label}"\n\n` +
        stepOutput;

      // ── Halt detection ─────────────────────────────────────────────────────
      if (step.haltOnIssues !== false && PipelineRunner._isCritical(stepOutput)) {
        stream.markdown(
          `\n\n---\n\n` +
          `> 🛑 **Pipeline halted after Step ${stepNum}: "${step.label}"**\n>\n` +
          `> Critical issues were detected in the output above. ` +
          `Resolve them and run the pipeline again.\n`
        );
        return;
      }
    }

    // ── Completion ─────────────────────────────────────────────────────────
    stream.markdown(
      `\n\n---\n\n` +
      `> ✅ **Pipeline complete** — all ${total} step${total !== 1 ? 's' : ''} finished.\n`
    );

    // ── Handoffs — surface "what's next" buttons ────────────────────────────
    // Mirrors the VS Code custom-agent handoffs spec: each entry in
    // pipeline.handoffs becomes a clickable button that pre-fills (or
    // auto-submits) the next agent invocation.
    const handoffs = pipeline.handoffs || [];
    if (handoffs.length > 0) {
      stream.markdown(`\n**Next steps:**\n`);
      for (const h of handoffs) {
        stream.button({
          command:   'aem-copilot.handoffToSkill',
          arguments: [h.agent, h.prompt, h.send === true],
          title:     h.label || h.agent
        });
      }
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  /**
   * Find an entry across skills, agents, and guides by name.
   */
  static _findEntry(name, library) {
    if (!name) return null;
    const all = [
      ...(library.skills  || []),
      ...(library.agents  || []),
      ...(library.guides  || [])
    ];
    return all.find(e => e.name === name) || null;
  }

  /**
   * Build the system prompt for a single step.
   * Combines the entry's own instructions with pipeline-chain context.
   */
  static _buildStepPrompt(entry, pipelineContext, stepNum, totalSteps, stepLabel) {
    const instructions = entry.instructions || entry.body || '';

    const chainSection = pipelineContext
      ? [
          '## Output from previous pipeline steps',
          '',
          'The following was produced by earlier steps in this pipeline.',
          'Treat it as direct input for your work — review, extend, or test it as appropriate.',
          '',
          pipelineContext
        ].join('\n')
      : '';

    const positionNote =
      stepNum < totalSteps
        ? `You are step ${stepNum} of ${totalSteps}. Step ${stepNum + 1} will run after you — be thorough, as downstream steps depend on your output.`
        : `You are the final step (${stepNum} of ${totalSteps}). Produce a complete, stand-alone result.`;

    return [
      `## Pipeline context`,
      '',
      `You are running as an automated pipeline step: **Step ${stepNum} of ${totalSteps} — ${stepLabel}**.`,
      positionNote,
      '',
      chainSection,
      '',
      '---',
      '',
      '## Your instructions for this step',
      '',
      instructions
    ].filter(s => s !== null).join('\n').trim();
  }

  /**
   * Send a request to the Copilot model, stream the response to chat,
   * and return the full captured text.
   */
  static async _streamAndCapture(contextBlock, systemPrompt, userMessage, stream, token) {
    const [model] = await vscode.lm.selectChatModels({
      vendor: 'copilot',
      family: 'gpt-4o'
    });

    if (!model) {
      stream.markdown('> ⚠️ No Copilot model available. Ensure GitHub Copilot Chat is installed and signed in.\n\n');
      return '';
    }

    const fullPrompt = [contextBlock, systemPrompt].join('\n\n---\n\n');
    const messages   = [
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
   * Returns true if the step output contains a critical issue signal.
   */
  static _isCritical(output) {
    return HALT_PATTERNS.some(pattern => pattern.test(output));
  }
}

module.exports = { PipelineRunner };
