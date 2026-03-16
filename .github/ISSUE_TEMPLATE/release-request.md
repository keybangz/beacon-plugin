---
name: Release Request
about: Request a new version release for the Beacon plugin
title: Release Request: [Version Type] - [Brief Description]
labels:
  - release-request
assignees: keybangz

---

## Release Details

**Version Type:** 🎯 (choose one)
- [ ] Patch (bug fixes, minor changes)
- [ ] Minor (new features, backward compatible)
- [ ] Major (breaking changes, significant updates)

**Target Version:** (e.g., 2.1.1, 2.2.0, 3.0.0)

## Release Content

### New Features
<!-- List any new features included in this release -->

### Bug Fixes
<!-- List any bug fixes included in this release -->

### Breaking Changes
<!-- List any breaking changes with migration instructions -->

### Performance Improvements
<!-- List any performance improvements -->

### Documentation
<!-- List any documentation updates -->

## Pre-Release Checklist

- [ ] All tests are passing
- [ ] Type checking passes
- [ ] Build completes successfully
- [ ] CHANGELOG.md is updated
- [ ] Package.json version is correct
- [ ] Dependencies are updated if needed
- [ ] Documentation is updated
- [ ] Security scan passes
- [ ] PR has been reviewed and approved

## Additional Context

<!-- Add any additional context, screenshots, or related issues -->

## Automated Release Process

Once approved, the following will be done:
1. A pull request will be created via the "Version Bump" workflow
2. After merging, a tag will be created and pushed
3. GitHub Actions will automatically:
   - Run tests and build
   - Create a GitHub Release
   - Publish to npm
   - Publish to GitHub Packages

---
<!-- This will be linked to the automated release process documentation -->