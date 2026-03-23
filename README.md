# Codebase Intelligence

> Pluggable code repository intelligence engine. Connect GitLab, GitHub, or local projects — auto-sync, index, and understand your entire codebase.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-green)](https://nodejs.org/)

[中文文档](./README_zh.md) | [Design Doc](./docs/design.md)

---

## Features

- **Pluggable Sources** — GitLab, GitHub, local filesystem. Mix and match in one config.
- **Incremental Sync** — `git clone` once, then `pull + diff` with `git diff --name-status` (add/modify/delete/rename). Auto-fallback to full reindex when diff fails.
- **Git mirror recovery** — For clones under the data directory: on pull/checkout conflicts or divergence, hard-reset to `origin/<branch>`; non-git directories at the clone path are removed and re-cloned.
- **Multi-branch safety** — Branches of the **same** repository sync **serially** (different repos still parallelize up to `sync.concurrency`).
- **First-sync checkpoint** — During the first full index, progress is flushed to `sync_state` (`index_resume_offset` / `index_resume_head`); after a crash, resume on the **same HEAD**. Cleared on success or L3 rebuild.
- **Webhooks (L1)** — `codebase-intelligence serve` exposes `POST /webhook/gitlab`, `POST /webhook/github`, and `GET /api/status`.
- **Hybrid Search** — BM25 keyword (SQLite FTS5) + vector semantic, weighted merge.
- **Dependency Graph** — Service-level dependency chain with BFS traversal.
- **Multi-Branch** — Auto-detect default branch; configure additional branches per project.
- **Any Embedding** — Ollama, OpenAI, or any OpenAI-compatible endpoint (Aliyun DashScope, Azure, Deepseek, vLLM).
- **Zero External Dependencies** — Default: SQLite only. Optional: ChromaDB / Qdrant.
- **Docker or Direct** — CLI, Docker, or embed as npm packages.

## Prerequisites

- **Node.js** >= 18
- **Git** (for clone/pull operations)
- **Embedding service** — one of:
  - [Ollama](https://ollama.ai/) with `nomic-embed-text` (recommended for local, free)
  - OpenAI API key
  - Any OpenAI-compatible endpoint

## Installation

### Option A: npm (recommended)

```bash
npm install -g @codebase-intelligence/cli
```

### Option B: npx (no install)

```bash
npx @codebase-intelligence/cli init
```

### Option C: From source

```bash
git clone https://github.com/your-org/codebase-intelligence.git
cd codebase-intelligence
npm install
npm run build
npm link
```

### Option D: Docker

```bash
cd docker
cp ../config/example-mixed.yaml config.yaml
# Edit config.yaml with your projects...
docker compose up -d
```

**Updates:** `npm update -g @codebase-intelligence/cli` for global installs; from source run `git pull`, `npm install`, `npm run build`. Re-copy the OpenClaw skill folder if you maintain it manually.

## Quick Start

```bash
# 1. Generate config
codebase-intelligence init --provider local

# 2. Edit codebase-intelligence.yaml (add your projects)

# 3. Start Ollama embedding (if using ollama)
ollama pull nomic-embed-text

# 4. Sync
codebase-intelligence sync

# 5. Search
codebase-intelligence query "order placement logic"
codebase-intelligence query "GET /api/users" --mode keyword --type api
codebase-intelligence query "coupon related" --project user-service --branch develop
```

## Configuration

```yaml
sources:
  - provider: gitlab
    url: https://gitlab.yourcompany.com
    tokenEnv: GITLAB_TOKEN          # env var name, NOT the token itself
    branches: [main, develop]
    projects:
      - group: backend-team

  - provider: github
    tokenEnv: GITHUB_TOKEN
    projects:
      - org: your-org

  - provider: local
    projects:
      - path: /home/dev/my-app
        name: my-app

storage:
  dataDir: ~/.codebase-intelligence
  vector:
    provider: sqlite              # sqlite | chromadb | qdrant

embedding:
  provider: ollama                # ollama | openai | custom_http
  model: nomic-embed-text
  url: http://localhost:11434

sync:
  strategy: incremental
  concurrency: 3
  cron: "0 */6 * * *"   # user crontab schedule that `init` registers (macOS/Linux)

server:
  port: 9876
```

> GitLab/GitHub and Local sources can coexist. GitLab clones to `~/.codebase-intelligence/repos/`, Local reads from your specified path. They are independent.

See `config/` for full examples: [default](config/default.yaml) | [gitlab](config/example-gitlab.yaml) | [github](config/example-github.yaml) | [mixed](config/example-mixed.yaml)

## CLI Reference

| Command | Description |
|---|---|
| `codebase-intelligence init` | Create `codebase-intelligence.yaml` if missing; on macOS/Linux, add a `sync` line to your **user crontab** using the system `crontab` command (not an npm package). Re-run anytime to refresh that line. On failure, only a warning is printed. |
| `codebase-intelligence sync` | Sync all configured projects. Options: `--project <name>` (only that project), `--full` (force full sync / ignore incremental) |
| `codebase-intelligence query <text>` | Search the index |
| `codebase-intelligence status` | Show indexed project stats |
| `codebase-intelligence reindex <project>` | Full reindex a project |
| `codebase-intelligence serve` | HTTP server (webhooks + status API) |

After you add or change GitLab/GitHub projects in the config, run `codebase-intelligence sync` (no need to restart `serve` unless you change server bind settings). Webhooks will match projects that have been synced at least once.

**First sync:** run `sync` manually once if you want an index immediately; otherwise the user crontab line (if `init` succeeded) will run `sync` on the `sync.cron` schedule. **Windows:** there is no user crontab — run `sync` manually or use Task Scheduler.

### Webhooks and HTTP server

```bash
codebase-intelligence serve -c codebase-intelligence.yaml
# Optional: --port 9876, --sync-on-start
```

| Endpoint | Purpose |
|---|---|
| `POST /webhook/gitlab` | GitLab **push** hook; matches `project.path_with_namespace` to configured `projects[].name` (full path). |
| `POST /webhook/github` | GitHub **push** hook; matches `repository.full_name` or `name` to configured projects. |
| `GET /api/status` | Last sync summary |
| `GET /api/projects` | Indexed project names |

### Query Options

```
-t, --type <type>     Filter: code, api, docs, config (`wiki` accepted as legacy alias for docs)
-p, --project <name>  Filter by project
-b, --branch <name>   Filter by branch
-m, --mode <mode>     hybrid (default), keyword, vector
-n, --limit <number>  Max results (default: 10)
--context             Output full context for LLM consumption
--detail              Print full chunk content for every result (human-readable mode)
```

Omit `--type` to search all collections (code, API specs, docs, config) in one query.

## OpenClaw Integration

### Install as Skill

```bash
# Via ClawHub
clawhub install codebase-intelligence

# Or manually: copy packages/openclaw/ into your OpenClaw skills directory
cp -r packages/openclaw/ ~/.openclaw/skills/codebase-intelligence/
```

### Skill Configuration

Add to your OpenClaw `config.yaml`:

```yaml
skills:
  codebase-intelligence:
    enabled: true
    config_path: ~/.codebase-intelligence/config.yaml
```

The skill exposes these tools to the agent:
- `codebase_search` — hybrid search across all indexed projects
- `codebase_search_code` — search code only
- `codebase_search_api` — search API definitions only
- `codebase_impact` — analyze change impact

The bundled `SKILL.md` also directs agents to run `codebase-intelligence status` for an **indexed-project** inventory (names and chunk counts) and to use `query --context` for multi-layer discovery across code, API specs, docs, and config. Coverage is **enrolled and synced internal codebases** only—not a full organization IT/system catalog.

### Use as npm Package

```typescript
import { loadConfig, createVectorStore, createEmbeddingProvider, SearchEngine } from '@codebase-intelligence/core';
import { SyncEngine } from '@codebase-intelligence/providers';

const config = loadConfig('codebase-intelligence.yaml');
const engine = new SyncEngine({ config });
await engine.init();
await engine.syncAll();

const search = new SearchEngine(engine.getStore(), engine.getEmbedding());
const results = await search.search('order placement logic', { mode: 'hybrid' });
```

## Embedding Recommendations

| Model | Code | Chinese | Cost | Recommended For |
|---|---|---|---|---|
| `nomic-embed-text` (Ollama) | ⭐⭐⭐ | ⭐⭐ | Free | Dev / small teams |
| `BAAI/bge-m3` (Ollama) | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | Free | **Chinese + code (best)** |
| `text-embedding-v4` (Aliyun) | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ¥0.7/M tokens | Production (CN) |
| `text-embedding-3-small` (OpenAI) | ⭐⭐⭐ | ⭐⭐⭐ | $0.02/M tokens | English projects |

## Packages

| Package | Description |
|---|---|
| `@codebase-intelligence/core` | Indexing engine, store, search, analysis |
| `@codebase-intelligence/providers` | GitLab / GitHub / Local adapters + sync engine |
| `@codebase-intelligence/cli` | Command-line tool |
| `@codebase-intelligence/openclaw` | OpenClaw skill + plugin adapter |

## Scope

**This tool only searches projects enrolled in your config and indexed via `sync`.**

It does not search arbitrary GitHub/GitLab repositories. Run `codebase-intelligence status` to see indexed projects.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Security reports: [SECURITY.md](./SECURITY.md).

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes
4. Push to the branch
5. Open a Pull Request

## License

[MIT](./LICENSE)
