/**
 * `codebase-intelligence init` — create starter config if missing, ensure data dir, then try to
 * add a `sync` line to the **system user crontab** via the `crontab` command (no extra npm packages).
 * Safe to run multiple times: config is not overwritten when present; crontab block is refreshed.
 */

import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { tryRegisterUserCrontabSync } from '../lib/crontab-user.js';

const TEMPLATES: Record<string, string> = {
  local: `# Codebase Intelligence Configuration
# Docs: https://github.com/codebase-intelligence/codebase-intelligence

sources:
  - provider: local
    name: "My Local Projects"
    projects:
      - path: ./
        name: my-project

storage:
  dataDir: ~/.codebase-intelligence
  vector:
    provider: sqlite          # Options: sqlite (default), chromadb, qdrant
    # url: http://localhost:8000  # For chromadb/qdrant
  meta:
    provider: sqlite

embedding:
  provider: ollama            # Options: ollama (default), openai
  model: nomic-embed-text
  url: http://localhost:11434
  dimensions: 768
  # provider: openai          # Uncomment for OpenAI
  # model: text-embedding-3-small
  # apiKeyEnv: OPENAI_API_KEY
  # dimensions: 1536

sync:
  strategy: incremental
  cron: "0 */6 * * *"
  concurrency: 3
`,

  gitlab: `# Codebase Intelligence Configuration — GitLab

sources:
  - provider: gitlab
    name: "Example GitLab"
    url: https://gitlab.example.com
    tokenEnv: GITLAB_TOKEN
    branches: [main]
    includeDocs: true
    projects:
      - group: backend-team        # Import all projects in group
      # - id: 42                   # Or by project ID
      #   name: user-service

storage:
  dataDir: ~/.codebase-intelligence
  vector:
    provider: sqlite
  meta:
    provider: sqlite

embedding:
  provider: ollama
  model: nomic-embed-text
  url: http://localhost:11434
  dimensions: 768

sync:
  strategy: incremental
  cron: "0 */6 * * *"
  concurrency: 3
`,

  github: `# Codebase Intelligence Configuration — GitHub

sources:
  - provider: github
    name: "GitHub Org"
    tokenEnv: GITHUB_TOKEN
    branches: [main]
    projects:
      - org: your-org              # Import all repos in org
      # - repo: your-org/repo-name # Or specific repo

storage:
  dataDir: ~/.codebase-intelligence
  vector:
    provider: sqlite
  meta:
    provider: sqlite

embedding:
  provider: ollama
  model: nomic-embed-text
  url: http://localhost:11434
  dimensions: 768

sync:
  strategy: incremental
  cron: "0 */6 * * *"
  concurrency: 3
`,

  mixed: `# Codebase Intelligence Configuration — Multi-Source

sources:
  # GitLab projects
  - provider: gitlab
    name: "Example GitLab"
    url: https://gitlab.example.com
    tokenEnv: GITLAB_TOKEN
    branches: [main, develop]
    includeDocs: true
    projects:
      - group: backend-team

  # GitHub projects
  - provider: github
    name: "Open Source"
    tokenEnv: GITHUB_TOKEN
    branches: [main]
    projects:
      - org: your-org

  # Local development
  - provider: local
    name: "Local Dev"
    projects:
      - path: /Users/dev/projects/my-app
        name: my-app

storage:
  dataDir: ~/.codebase-intelligence
  vector:
    provider: sqlite          # sqlite | chromadb | qdrant
  meta:
    provider: sqlite

embedding:
  provider: ollama
  model: nomic-embed-text
  url: http://localhost:11434
  dimensions: 768

sync:
  strategy: incremental
  cron: "0 */6 * * *"
  concurrency: 3
`,
};

export async function initCommand(options: { provider: string; dir: string }) {
  const configFile = 'codebase-intelligence.yaml';
  const absConfig = resolve(process.cwd(), configFile);

  if (!existsSync(configFile)) {
    const template = TEMPLATES[options.provider] ?? TEMPLATES.local;
    writeFileSync(configFile, template, 'utf-8');
    console.log(`Created ${configFile} (provider: ${options.provider})`);
  } else {
    console.log(`${configFile} already exists — not overwritten.`);
  }

  const dataDir = options.dir || join(homedir(), '.codebase-intelligence');
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
    console.log(`Created data directory: ${dataDir}`);
  }

  if (existsSync(absConfig)) {
    tryRegisterUserCrontabSync(absConfig);
  }

  console.log('\nNext steps:');
  console.log('  1. Edit codebase-intelligence.yaml with your projects');
  console.log(
    '  2. Run sync: `codebase-intelligence sync` once (first time), or wait for the user crontab job if it was registered',
  );
  console.log('  3. Search: `codebase-intelligence query "your question"`');
}
