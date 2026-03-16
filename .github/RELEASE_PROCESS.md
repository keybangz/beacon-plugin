# Beacon Plugin Release Process

This document outlines the release workflow for the Beacon OpenCode plugin.

## Overview

The release process is automated using GitHub Actions workflows. The system supports:
- Automated dependency updates (Dependabot)
- Automated version bumping
- Automated publishing to npm and GitHub Packages
- Automated GitHub Releases

## Workflows

### 1. CI Pipeline (`.github/workflows/ci.yml`)
**Trigger:** On push to main/master or pull requests
**Purpose:**
- Run tests on multiple Node.js versions (18.x, 20.x, 22.x)
- Type checking with TypeScript
- Build verification
- Linting and file structure checks

### 2. Release Pipeline (`.github/workflows/release.yml`)
**Trigger:** When a tag matching `v*` is pushed
**Purpose:**
- Verify tag format matches package.json version
- Run tests and build
- Create GitHub Release with release notes
- Publish to npm (requires `NPM_TOKEN` secret)
- Publish to GitHub Packages (as `@keybangz/beacon-opencode`)

### 3. Version Bump (`.github/workflows/version-bump.yml`)
**Trigger:** Manual workflow dispatch
**Purpose:**
- Bump version in package.json (patch/minor/major or specific version)
- Update CHANGELOG.md
- Create pull request for review
- Run tests with new version

### 4. Dependency Updates (`.github/dependabot.yml`)
**Trigger:** Weekly (Monday 9:00 AM EST)
**Purpose:**
- Automatic npm dependency updates
- Creates pull requests for minor/patch updates
- Can auto-merge passing updates
- Ignores major updates for critical dependencies

## Release Task Flow

### Regular Release (Patch/Minor)

1. **Version Bump**
   - Go to GitHub Actions → "Version Bump" workflow
   - Click "Run workflow"
   - Select bump type (patch, minor, major) or enter specific version
   - Workflow creates a PR with version updates

2. **Review Pull Request**
   - Review changes to package.json and CHANGELOG.md
   - Ensure tests pass
   - Merge the PR

3. **Create and Push Tag**
   ```bash
   # Get the new version from package.json
   VERSION=$(node -p "require('./package.json').version")
   
   # Create and push tag
   git tag v$VERSION
   git push origin v$VERSION
   ```

4. **Automated Release**
   - GitHub Actions automatically:
     - Runs tests
     - Creates GitHub Release
     - Publishes to npm
     - Publishes to GitHub Packages

### Hotfix Release

1. **Create Hotfix Branch**
   ```bash
   git checkout -b hotfix/<issue>
   ```

2. **Fix the Issue**
   - Make necessary code changes
   - Add tests if applicable

3. **Version Bump**
   - Use the "Version Bump" workflow or manually:
   ```bash
   npm version patch
   # Update CHANGELOG.md
   ```

4. **Create PR and Merge**
   - Create PR from hotfix branch
   - Review and merge

5. **Create and Push Tag**
   ```bash
   git tag v$(node -p "require('./package.json').version")
   git push origin --tags
   ```

## Secrets Required

### Repository Secrets (Settings → Secrets and variables → Actions)

1. **`NPM_TOKEN`**
   - Required for publishing to npm
   - Generate at: https://www.npmjs.com/settings/<username>/tokens
   - Needs "Read and Publish" permissions

2. **`GITHUB_TOKEN`**
   - Automatically provided by GitHub Actions
   - Used for GitHub Packages publishing

## Package Distribution

### npm
- Package name: `beacon-opencode`
- Registry: https://registry.npmjs.org/
- Access: public

### GitHub Packages
- Package name: `@keybangz/beacon-opencode`
- Registry: https://npm.pkg.github.com/
- Access: follows repository visibility

## Versioning Strategy

- **Major (X.0.0)**: Breaking changes, new major features
- **Minor (1.X.0)**: New features, backward compatible
- **Patch (1.0.X)**: Bug fixes, security updates

## Changelog Management

The `CHANGELOG.md` file is automatically updated during version bumps. Manual edits should include:
- New features
- Bug fixes
- Breaking changes
- Deprecations

## Rollback Procedure

If a release has issues:

1. **Unpublish from npm** (if within 72 hours):
   ```bash
   npm unpublish beacon-opencode@<version>
   ```

2. **Delete GitHub Release:**
   - Go to Releases page
   - Delete the problematic release

3. **Delete Git Tag:**
   ```bash
   git tag -d v<version>
   git push origin :refs/tags/v<version>
   ```

4. **Revert Version:**
   - Revert the version bump commit
   - Update CHANGELOG.md

## Monitoring

- **npm Downloads**: https://www.npmjs.com/package/beacon-opencode
- **GitHub Releases**: Repository Releases page
- **CI Status**: GitHub Actions tab
- **Dependencies**: Dependabot alerts

## Troubleshooting

### Release workflow fails
1. Check if tests pass in CI workflow
2. Verify tag format: `vX.Y.Z`
3. Check package.json version matches tag
4. Verify NPM_TOKEN secret is set

### Dependabot not creating PRs
1. Check `.github/dependabot.yml` syntax
2. Verify repository has Dependabot enabled
3. Check GitHub Actions permissions

### Build failures
1. Check Node.js version compatibility
2. Verify TypeScript compilation
3. Check for missing dependencies