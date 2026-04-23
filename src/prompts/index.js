'use strict';

const { PROMPT_NEW_SITE }      = require('./newSite');
const { PROMPT_NEW_TEMPLATE }  = require('./newTemplate');
const { PROMPT_NEW_THEME }     = require('./newTheme');
const { PROMPT_NEW_PAGE }      = require('./newPage');
const { PROMPT_NEW_COMPONENT } = require('./newComponent');
const { PROMPT_NEW_POLICY }    = require('./newPolicy');
const { PROMPT_EXPLAIN }       = require('./explain');
const { PROMPT_DEBUG }         = require('./debug');
const { PROMPT_SCAN }          = require('./scan');
const { PROMPT_DIFF }          = require('./diff');
const { PROMPT_LIST_SKILLS }   = require('./listSkills');
const { PROMPT_USE_SKILL }     = require('./useSkill');
const { PROMPT_INIT_COPILOT }  = require('./initCopilot');
const { PROMPT_RUN_WORKFLOW }  = require('./runWorkflow');

const PROMPTS = {
  'new-site':      PROMPT_NEW_SITE,
  'new-template':  PROMPT_NEW_TEMPLATE,
  'new-theme':     PROMPT_NEW_THEME,
  'new-page':      PROMPT_NEW_PAGE,
  'new-component': PROMPT_NEW_COMPONENT,
  'new-policy':    PROMPT_NEW_POLICY,
  'explain':       PROMPT_EXPLAIN,
  'debug':         PROMPT_DEBUG,
  'scan':          PROMPT_SCAN,
  'diff':          PROMPT_DIFF,
  'list-skills':   PROMPT_LIST_SKILLS,
  'use-skill':     PROMPT_USE_SKILL,
  'init-copilot':  PROMPT_INIT_COPILOT,
  'run-workflow':  PROMPT_RUN_WORKFLOW
};

module.exports = { PROMPTS };
