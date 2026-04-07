---
name: editable-template-setup
description: Create a complete editable template with structure, initial content, policies, and allowed components
topic: templates
tags: [template, editable, conf, policies, scaffold]
---

# Skill: Editable Template Setup

Produce a complete AEM 6.5 editable template under `/conf/{site}/settings/wcm/templates/`.

## Required nodes

Every editable template MUST have all four child nodes:

| Node | Purpose |
|---|---|
| `.content.xml` (root) | Template metadata: title, status, allowedPaths |
| `structure/.content.xml` | Fixed page structure — layout containers, locked components |
| `initial/.content.xml` | Default content pre-populated when a page is created |
| `policies/.content.xml` | Links structure nodes to content policies |

## Root `.content.xml` rules

- `jcr:primaryType="cq:Template"`
- `status="enabled"` — never leave as `disabled` unless this is a draft
- `allowedPaths` MUST be scoped: `/content/{site}(/.*)?` — do not use `.*` globally
- `ranking` controls the order in the "Create Page" wizard — use increments of 100

## Structure node rules

- The structure's `jcr:content` node defines the page component via `sling:resourceType`
- Use the DETECTED page component resource type from workspace context
- Add a `responsivegrid` (layout container) as the primary editable area
- Lock the header and footer regions with `jcr:lockIsDeep="{Boolean}true"` when they should not be edited per-page

## Policies node rules

- Each policy assignment maps a structure node path to a policy path under `/conf/{site}/settings/wcm/policies/`
- The root policy assignment sets the page-level policy (clientlibs, metadata)
- The layout container policy sets allowed components — list only the DETECTED component groups

## Initial content rules

- Keep initial content minimal — only set values a content author would otherwise have to set on every new page
- `jcr:title` and `jcr:description` stubs are acceptable
- Do not pre-populate content that varies per page

## Registration checklist

1. Verify the template appears in `/conf/{site}/settings/wcm/templates/` in CRXDE
2. Navigate to AEM > Tools > Templates > {site} and confirm status = Enabled
3. Create a test page at `/content/{site}/` — the template must appear in the wizard
4. Open the page in edit mode — confirm layout container is editable
5. Open template editor — confirm structure, initial, and policies tabs are all present
