# Security

## Supported versions

Security fixes are applied to the latest development line on the default branch. Use the newest release or commit when deploying.

## Reporting a vulnerability

Please **do not** open a public GitHub issue for undisclosed security problems.

Instead, report details privately to the maintainers (for example via GitHub **Security advisories** for this repository, if enabled, or the contact channel listed in the repository description / org profile).

Include:

- A short description of the issue and its impact
- Steps to reproduce or proof-of-concept, if possible
- Affected versions or commit range, if known

We will acknowledge receipt and work on a fix timeline in line with severity.

## Configuration safety

This tool reads repository tokens and API keys from **environment variables** referenced in config (`tokenEnv`, `apiKeyEnv`). Never commit real secrets, `.env` files with live keys, or personal `codebase-intelligence.yaml` files that contain internal project paths you do not intend to share.
