/**
 * `codebase-intelligence init` — generate a starter config file.
 */

import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

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
    includeWiki: true
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
    includeWiki: true
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

  if (existsSync(configFile)) {
    console.log(`Config file already exists: ${configFile}`);
    return;
  }

  const template = TEMPLATES[options.provider] ?? TEMPLATES.local;
  writeFileSync(configFile, template, 'utf-8');
  console.log(`Created ${configFile} (provider: ${options.provider})`);

  // Create data directory
  const dataDir = options.dir || join(homedir(), '.codebase-intelligence');
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
    console.log(`Created data directory: ${dataDir}`);
  }

  console.log('\nNext steps:');
  console.log('  1. Edit codebase-intelligence.yaml with your projects');
  console.log('  2. Run: npx codebase-intelligence sync');
  console.log('  3. Run: npx codebase-intelligence query "your question"');
}
