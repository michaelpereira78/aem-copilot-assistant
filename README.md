# AEM Copilot Assistant

A VS Code extension that adds AEM 6.5 slash commands to GitHub Copilot Chat.
Each command is a focused specialist — give it named parameters, get back
production-ready code and step-by-step instructions.

---

## Prerequisites

- VS Code 1.90 or later
- GitHub Copilot Chat extension installed and signed in
- Node.js 18+ (for packaging)

---

## Installation (development)

```bash
# 1. Clone or copy this folder into your VS Code extensions directory
git clone <your-repo> aem-copilot-assistant
cd aem-copilot-assistant

# 2. Install dev dependencies
npm install

# 3. Open in VS Code and press F5 to launch the Extension Development Host
code .
```

To package and share with your team:

```bash
npm run package
# produces aem-copilot-assistant-1.0.0.vsix
```

Install the .vsix on a team member's machine:
```
Extensions panel > ··· menu > Install from VSIX...
```

---

## Commands

All commands are used inside the Copilot Chat panel, prefixed with `@aem`.

### `/new-site` — scaffold a new site
```
@aem /new-site siteName=my-brand groupId=com.mybrand
```
Generates: full folder tree, 4 key `.content.xml` stubs, Maven deploy steps.

---

### `/new-template` — create an editable template
```
@aem /new-template name=content-page site=my-brand
```
Generates: structure node, policies node, initial node, root template node XML, enable steps.

---

### `/new-theme` — scaffold ClientLibs and SCSS
```
@aem /new-theme name=brand-theme site=my-brand components=nav,hero,footer
```
Generates: ClientLib `.content.xml`, `css.txt`, `js.txt`, SCSS partial stubs, HTL wiring snippet.

---

### `/new-page` — generate a page `.content.xml`
```
@aem /new-page title="About us" site=my-brand template=content-page depth=standard
```
Depth options: `shallow` | `standard` | `deep`
Generates: page `.content.xml` with parsys nodes, deploy steps.

---

### `/new-component` — generate a full AEM component
```
@aem /new-component name=hero site=my-brand group=my-brand
```
Generates: component node `.content.xml`, HTL file, Sling model Java class, dialog `.content.xml`, policy registration steps.

---

### `/new-policy` — generate a content policy
```
@aem /new-policy component=hero template=content-page site=my-brand
```
Generates: policy node XML, template policy mapping diff, wiring steps.

---

### `/explain` — learn an AEM concept
```
@aem /explain topic="editable templates vs static templates"
@aem /explain topic="sling:resourceSuperType"
@aem /explain topic="ClientLibrary categories"
```
Generates: plain-English summary, mechanism explanation, annotated code example, pitfalls, related commands.

---

### `/debug` — diagnose and fix AEM problems
```
@aem /debug javax.jcr.nodetype.ConstraintViolationException: No matching node type...
@aem /debug [paste your broken .content.xml]
@aem /debug [paste your HTL error]
```
Generates: root cause, why it happens, corrected code, verification steps, prevention tip.

---

## Adding your own commands

1. Add a new prompt file in `src/prompts/` following the pattern of existing ones.
2. Export it and add it to the `PROMPTS` map in `src/prompts/index.js`.
3. Add the command entry to the `chatParticipants[].commands` array in `package.json`.
4. Add the handler to `COMMAND_HANDLERS` in `src/extension.js`.

---

## Project structure

```
aem-copilot-assistant/
├── package.json                  # Extension manifest + command registration
├── README.md
└── src/
    ├── extension.js              # Activation, param parser, handler wiring
    └── prompts/
        ├── index.js              # Exports all prompts
        ├── newSite.js            # /new-site system prompt
        ├── newTemplate.js        # /new-template system prompt
        ├── newTheme.js           # /new-theme system prompt
        ├── newPage.js            # /new-page system prompt
        ├── newComponent.js       # /new-component system prompt
        ├── newPolicy.js          # /new-policy system prompt
        ├── explain.js            # /explain system prompt
        └── debug.js              # /debug system prompt
```

---

## Customising the prompts

Each prompt file exports a single template string. Edit the instructions to match
your team's conventions — for example:

- Change the default `sling:resourceSuperType` to your project's base component
- Add your team's preferred dialog field patterns to `/new-component`
- Add a Maven profile name to the deploy steps across all commands
- Restrict `/explain` to only reference your internal Confluence docs

The prompts are plain strings — no framework required.
