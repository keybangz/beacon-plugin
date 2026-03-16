# GitHub Actions Setup

This repository uses GitHub Actions for continuous integration, security scanning, dependency management, and automated releases.

## Workflows

### CI Pipeline (`.github/workflows/ci.yml`)
Runs on every push and pull request to main/master branches.

**Features:**
- Tests on Node.js 18.x, 20.x, 22.x
- TypeScript type checking
- Build verification
- Linting and file structure validation

### Development Workflow (`.github/workflows/dev.yml`)
Enhanced CI pipeline with additional checks.

**Features:**
- Automated dependency checking
- Build verification
- Multi-Node.js testing
- Security scanning
- Outdated dependency alerts

### Release Pipeline (`.github/workflows/release.yml`)
Automated publishing triggered by version tags.

**Features:**
- Version validation
- Test execution
- GitHub Release creation
- npm publication
- GitHub Packages publication

### Version Bump (`.github/workflows/version-bump.yml`)
Manual version management workflow.

**Features:**
- Automatic version bumping (patch/minor/major)
- CHANGELOG updates
- Pull request creation
- Test validation

### Security Scanning (`.github/workflows/security.yml`)
Weekly and on-demand security checks.

**Features:**
- npm security audit
- Snyk integration
- Secret detection
- CodeQL analysis
- OSS Scorecard integration

### Dependabot (`.github/dependabot.yml`)
Automated dependency updates.

**Features:**
- Weekly dependency updates
- Pull request creation
- Auto-merge for minor/patch updates
- Ignore rules for critical dependencies

## Release Process

### Automated Release Flow

1. **Version Bump Request**
   - Use the "Version Bump" workflow
   - Select version type or enter specific version
   - Creates pull request for review

2. **Pull Request Review**
   - Review changes
   - Verify tests pass
   - Merge approved PR

3. **Tag Creation**
   ```bash
   git tag v$(node -p "require('./package.json').version")
   git push origin --tags
   ```

4. **Automated Publishing**
   - GitHub Actions triggers on tag push
   - Creates GitHub Release
   - Publishes to npm
   - Publishes to GitHub Packages

### Manual Release

1. **Update Package Version**
   ```bash
   npm version [patch|minor|major]
   ```

2. **Update CHANGELOG.md**
   - Add new release section
   - List features and bug fixes

3. **Commit and Push**
   ```bash
   git add package.json CHANGELOG.md
   git commit -m "Release v$(node -p "require('./package.json').version")"
   git push
   ```

4. **Create and Push Tag**
   ```bash
   git tag v$(node -p "require('./package.json').version")
   git push origin v$(node -p "require('./package.json').version")
   ```

## Required Secrets

### Repository Secrets (Settings → Secrets and variables → Actions)

- **`NPM_TOKEN`**: npm API token for publishing
  - Generate at: https://www.npmjs.com/settings/<username>/tokens
  - Required: "Read and Publish" permissions

- **`SNYK_TOKEN`**: Snyk API token for security scanning
  - Generate at: https://snyk.io/account/
  - Optional but recommended

## Package Distribution

### npm Registry
- **Package Name**: `beacon-opencode`
- **Scope**: Public
- **Registry**: https://registry.npmjs.org/

### GitHub Packages
- **Package Name**: `@keybangz/beacon-opencode`
- **Registry**: https://npm.pkg.github.com/
- **Access**: Repository-based

## CI/CD Status

The CI pipeline ensures:
- Code quality standards are met
- Tests pass on all supported Node.js versions
- TypeScript compilation succeeds
- Security vulnerabilities are detected
- Build artifacts are properly generated

## Troubleshooting

### Release Fails
1. Check CI logs for errors
2. Verify package.json version matches tag
3. Ensure NPM_TOKEN is configured
4. Run tests locally before release

### Dependency Issues
1. Check Dependabot logs
2. Review `.github/dependabot.yml` configuration
3. Manually update if needed

### Build Failures
1. Check TypeScript compilation errors
2. Verify file structure in `dist/` directory
3. Run `npm run build` locally

## Monitoring

- **CI Status**: GitHub Actions tab
- **npm Downloads**: https://www.npmjs.com/package/beacon-opencode
- **GitHub Releases**: Repository releases page
- **Security Alerts**: GitHub security tab

## Contributing

When contributing:
1. Ensure your changes pass all CI checks
2. Run tests locally before pushing
3. Update documentation as needed
4. Follow the existing release process

## Maintenance

- **Weekly**: Dependabot runs dependency updates
- **Monthly**: Review security reports
- **Quarterly**: Review release processes and workflows
- **As Needed**: Update Node.js versions in CI matrix