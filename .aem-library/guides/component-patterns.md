---
name: component-patterns
description: Team reference guide for AEM 6.5 component architecture patterns — when to use each and how to structure them
topic: components
tags: [reference, architecture, patterns, sling-model, htl]
---

# AEM Component Patterns — Team Reference

## Pattern 1: Simple display component
**Use when:** The component renders authored content with no conditional logic.

Structure:
- `.content.xml` — component node
- `{name}.html` — HTL with inline `data-sly-use` pointing to a Sling model
- `_cq_dialog/.content.xml` — author dialog
- `{ModelName}.java` — thin Sling model with `@ValueMapValue` getters only

Rule: If the model has no `@PostConstruct` logic, it's a display component.

---

## Pattern 2: Container component
**Use when:** The component contains other components (parsys/responsivegrid).

Additional requirements:
- `cq:isContainer="{Boolean}true"` on the component node
- `_cq_editConfig/.content.xml` with `afterchilddelete`, `afterchildinsert`, `afterchildmove` listeners
- HTL uses `data-sly-resource` with `resourceType="wcm/foundation/components/responsivegrid"`

Rule: Do not hardcode child component resource types in the container HTL.

---

## Pattern 3: Composite component (delegates to core)
**Use when:** Extending an Adobe WCM Core component with custom fields or behaviour.

Structure:
- `sling:resourceSuperType` points to the core component
- Only override the specific HTL file you need to change
- Add dialog fields with `sling:hideResource` to remove inherited fields
- Sling model `@via("resource")` to access the parent model

Rule: Never copy the full core component HTL. Only override what differs.

---

## Pattern 4: Global component (header/footer)
**Use when:** The component appears on every page and is locked in the template structure.

Requirements:
- Stored under `/apps/{site}/components/structure/` (not `content/`)
- Template structure node locks it: `jcr:lockIsDeep="{Boolean}true"`
- Content editable only via the template editor, not per-page
- ClientLib embed: its CSS/JS belongs in the page-level clientlib, not a separate one

---

## Sling Model interface pattern (team standard)

Always define an interface alongside the implementation:

```
{name}.java          ← interface with getters
{name}Impl.java      ← @Model implementation
```

The HTL `data-sly-use` references the interface:
`data-sly-use.model="com.{groupId}.models.{Name}"`

The `@Model` annotation on the Impl class includes `adapters = {Name}.class`.

This allows unit testing against the interface without instantiating a full Sling context.

---

## Naming rules (team standard)

| Artifact | Convention | Example |
|---|---|---|
| Component directory | kebab-case | `hero-banner` |
| HTL file | same as directory | `hero-banner.html` |
| Sling model interface | PascalCase | `HeroBanner.java` |
| Sling model impl | PascalCase + Impl | `HeroBannerImpl.java` |
| Dialog property names | camelCase | `backgroundImage` |
| ClientLib category | `{site}.component.{name}` | `mybrand.component.hero-banner` |
