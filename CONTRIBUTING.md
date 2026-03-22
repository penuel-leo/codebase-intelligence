# Contributing

Thanks for your interest in improving this project.

## Before you start

- Open an issue to discuss larger changes or new features when in doubt.
- For security-sensitive reports, use [SECURITY.md](./SECURITY.md) instead of a public issue.

## Repository metadata

After you create the GitHub repository, replace the placeholder `your-username` in root `package.json` (`repository`, `bugs`, `homepage`) with your real GitHub user or organization name so links and npm metadata stay accurate.

## Development setup

```bash
git clone https://github.com/your-username/codebase-intelligence.git
cd codebase-intelligence
npm install
npm run build
npm test
```

## Pull requests

1. Fork and create a branch from `main` (or the default branch).
2. Keep changes focused on one topic per PR.
3. Run `npm run build` and `npm test` before submitting.
4. Describe what changed and why in the PR description.

## Code style

- TypeScript; match existing formatting and patterns in touched files.
- Avoid drive-by refactors unrelated to the PR scope.
