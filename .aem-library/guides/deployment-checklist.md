---
name: deployment-checklist
description: Pre-deployment checklist for AEM 6.5 component and template changes — covers build, smoke test, and rollback steps
topic: deployment
tags: [deployment, checklist, maven, qa, rollback]
---

# AEM Deployment Checklist

Use this checklist before deploying component or template changes to shared environments.

## Before you build

- [ ] All `.content.xml` files pass XML validation (`mvn validate` or IDE XML check)
- [ ] No hardcoded localhost or author URLs in code
- [ ] No uncommitted debug logging (`log.debug` in hot paths is fine; `log.error` for expected states is not)
- [ ] `allowedPaths` on new templates scoped to `/content/{site}(/.*)?`
- [ ] New components added to at least one template's allowed components policy
- [ ] Sling model package matches the project's detected package convention
- [ ] ClientLib `allowProxy=true` on all clientlibs that serve the publish tier

## Build commands

```bash
# Full build with unit tests
mvn clean install -PautoInstallPackage

# Frontend only (if ui.frontend module exists)
mvn clean install -pl ui.frontend -PautoInstallPackage

# Skip tests for faster iteration (not for CI)
mvn clean install -pl core,ui.apps -PautoInstallPackage -DskipTests
```

## Smoke tests (author)

- [ ] New component appears in the component browser under the correct group
- [ ] Component dialog opens without console errors
- [ ] All dialog fields save and re-load correctly
- [ ] Component renders correctly in edit mode and preview mode
- [ ] If template was changed: create a new test page using the template

## Smoke tests (publish)

- [ ] Component renders without 500 errors in the log
- [ ] ClientLib CSS/JS loads from `/etc.clientlibs/` (not `/apps/`)
- [ ] No `ResourceNotFoundException` in `error.log` for the new resource types
- [ ] Page loads within acceptable performance budget

## Log checks

```bash
# AEM error log location
tail -f crx-quickstart/logs/error.log | grep -i "error\|exception\|warn"

# Filter for your component
tail -f crx-quickstart/logs/error.log | grep "{site}"
```

## Rollback plan

If a critical issue is found post-deploy:

1. Identify the package that introduced the issue (CRX Package Manager)
2. Uninstall the package via CRX Package Manager > Uninstall
3. Re-install the previous version package if available
4. If no previous package: use CRXDE to revert the specific node change
5. Document the issue and fix before re-deploying

## CI/CD notes

- Pipeline deploys to `author` first — verify there before publish auto-deploy proceeds
- Replication queue must be empty before deploying template changes to publish
- Content policy changes require page invalidation in the Dispatcher cache
