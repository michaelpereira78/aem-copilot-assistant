---
name: clientlib-organization
description: Best-practice ClientLib folder structure with page-level and component-level separation
topic: themes
tags: [clientlib, scss, css, javascript, theme, performance]
---

# Skill: ClientLib Organization

Design and scaffold a well-structured ClientLib setup for an AEM 6.5 site.

## Recommended ClientLib structure

```
/apps/{site}/clientlibs/
  base/           — reset, variables, mixins, typography (no component styles)
  components/     — one sub-folder per component, each its own clientlib
    hero/
    navigation/
    footer/
  page/           — page-level clientlib that embeds base + component libs
  editor/         — authoring-only styles (dialogs, edit overlays)
```

## Category naming convention

Use the pattern `{site}.{scope}`:

| ClientLib | Category |
|---|---|
| base | `{site}.base` |
| page | `{site}.page` (embed base + all component categories) |
| editor | `{site}.editor` |
| hero component | `{site}.component.hero` |

## Required properties on each `.content.xml`

```xml
allowProxy="{Boolean}true"    <!-- required for /etc.clientlibs/ proxy access -->
categories="[{site}.page]"
dependencies="[{site}.base]"  <!-- only when explicit ordering is needed -->
```

## SCSS file conventions

- `css.txt` must reference files using `#base=css` and list `.scss` file paths
- One `_variables.scss` in base — imported by all component SCSS files
- Component SCSS files follow BEM: `.hero { &__title {} &__cta {} }`
- No `!important` except for authoring-mode overrides in the editor clientlib

## `page` clientlib embed strategy

Use `embed` (not `dependencies`) to concatenate CSS/JS into a single request:

```xml
embed="[{site}.base,{site}.component.hero,{site}.component.navigation]"
```

This reduces HTTP requests. Only use `dependencies` when load order matters
and you cannot control it via embed order.

## allowProxy rule

All clientlibs served to the browser MUST have `allowProxy="{Boolean}true"`.
Clientlibs without `allowProxy` are only accessible from the author instance.
The editor clientlib should NOT have `allowProxy` — it is author-only.

## Verification steps

1. Deploy and navigate to `/etc.clientlibs/{site}/clientlibs/page.css` — must resolve
2. Open a page and check browser DevTools > Network > CSS — confirm one concatenated file
3. Confirm no 404s for clientlib resources in the browser console
4. Open a page in author mode and confirm edit overlays render correctly (editor clientlib)
