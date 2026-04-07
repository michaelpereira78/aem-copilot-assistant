---
name: new-hero-component
description: Scaffold a full hero banner component with background image, title, subtitle, and CTA button
topic: components
tags: [component, hero, scaffold, htl, sling-model, dialog]
---

# Skill: Hero Component

Scaffold a production-ready AEM 6.5 hero banner component.

## Required files

1. `.content.xml` — component node definition
2. `hero.html` — HTL markup
3. `Hero.java` — Sling model
4. `_cq_dialog/.content.xml` — author dialog

## Component properties

The hero component MUST support these authored fields:

| Property | Type | Dialog field |
|---|---|---|
| `title` | String | TextField |
| `subtitle` | String | TextField |
| `backgroundImage` | String (DAM path) | FileUpload / PathField |
| `ctaText` | String | TextField |
| `ctaLink` | String | PathField |
| `ctaTarget` | String | Select: _self / _blank |
| `overlayOpacity` | Long (0–100) | NumberField |

## HTL requirements

- Use `data-sly-use` to load the Sling model
- Apply `data-sly-test` guards on optional fields (subtitle, CTA)
- Wrap the background image in a `style` attribute using `background-image: url(...)`
- The CTA renders as a `<a>` tag only when both `ctaText` and `ctaLink` are set
- Include an `editConfig` hint comment at the top
- Use BEM class naming: `hero`, `hero__title`, `hero__subtitle`, `hero__cta`

## Sling model requirements

- `adaptables = SlingHttpServletRequest.class`
- `defaultInjectionStrategy = DefaultInjectionStrategy.OPTIONAL`
- `@ValueMapValue` for each property
- A `@PostConstruct init()` that resolves the image URL via `Page` or direct path
- Getters for all fields
- `isCtaVisible()` convenience method: returns true only if both ctaText and ctaLink are non-empty

## Dialog requirements

- Single "Content" tab
- Group image, text, and CTA fields in labelled sections using `FieldSet`
- `overlayOpacity` uses a `granite/ui/components/coral/foundation/form/numberfield` with `min=0 max=100`
- CTA target uses a `granite/ui/components/coral/foundation/form/select` with two items

## Registration guide

After generating files:
1. Deploy: `mvn clean install -pl core,ui.apps -PautoInstallPackage`
2. In template editor, add the hero to the allowed components for the layout container
3. Drag onto a page and verify the dialog opens with all fields
4. Author a background image and confirm the overlay renders
5. Set CTA fields and confirm the link renders; clear them and confirm it disappears
