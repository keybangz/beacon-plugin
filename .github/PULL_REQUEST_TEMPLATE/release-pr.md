---
name: Release Pull Request
about: Pull request for version release and publishing
title: Release v[VERSION]
assignees: keybangz
labels:
  - release
  - automated

## Summary

This PR automatically creates a release for version **v[VERSION]**.

## Changes Made

### Automated Changes
- **Version Bump**: Updated `package.json` to v[VERSION]
- **Changelog**: Updated `CHANGELOG.md` with release notes
- **CI/CD**: Passed all tests and build verification

### Manual Changes (if any)
<!-- Add any manual changes that were made before this automated release -->

## Release Checklist

- [ ] Version number matches tag format (`vX.Y.Z`)
- [ ] All tests pass
- [ ] TypeScript compilation succeeds
- [ ] Build output is correct
- [ ] CHANGELOG.md is updated with new features and fixes
- [ ] Package.json version is correct
- [ ] No security vulnerabilities detected

## Release Process

### Before Merging
1. **Review Changes**: Ensure all version and changelog changes are correct
2. **Run Tests**: Verify the automated tests pass
3. **Review Changelog**: Ensure it accurately reflects changes
4. **Check Dependencies**: Verify no breaking dependency changes

### After Merging
1. **Create Tag**: `git tag v[VERSION] && git push origin v[VERSION]`
2. **Trigger Release**: GitHub Actions will automatically:
   - Create GitHub Release
   - Publish to npm
   - Publish to GitHub Packages

## Version Information

- **Current Version**: [Previous Version]
- **New Version**: v[VERSION]
- **Release Type**: [Patch/Minor/Major]

## Distribution Channels

1. **npm**: `beacon-opencode` package
2. **GitHub Packages**: `@keybangz/beacon-opencode` package
3. **GitHub Releases**: Binary artifacts and source code

## Next Steps

After this PR is merged:
1. Create and push the version tag
2. Monitor GitHub Actions release workflow
3. Verify packages are published successfully
4. Test installation in OpenCode environment
5. Update documentation if needed

---
*This PR was created automatically via the Version Bump workflow.*