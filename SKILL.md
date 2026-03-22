---
name: codebase-intelligence
description: >
  Deep understanding of codebase repositories (GitLab, GitHub, or local workspace).
  Use when anyone asks about code logic, architecture, project dependencies, API definitions,
  database schemas, or needs impact analysis for new requirements. Supports multi-project,
  multi-source cross-repo analysis.
metadata:
  openclaw:
    requires:
      bins:
        - git
    install:
      - type: npm
        package: "@codebase-intelligence/cli"
---

# Codebase Intelligence

You have access to a continuously-updated index of the company's code repositories
(GitLab, GitHub, and/or local workspaces), including code, Wiki documentation, API docs
(Swagger/OpenAPI), CI/CD configurations, and inter-service dependency graphs.

All data lives in a SQLite-backed vector + FTS5 index with rich metadata. You can search
globally across all projects, or filter by provider / project / type as needed.

## When to activate

Use this skill when the user:

- Asks about **code logic**: "这个接口怎么实现的", "这段代码是什么意思", "这个函数在哪里调用的"
- Asks about **architecture**: "我们有哪些微服务", "A 项目和 B 项目的关系", "数据库表结构"
- Asks about **API definitions**: "用户接口的入参出参是什么", "哪个服务暴露了这个 endpoint"
- Needs **impact analysis**: "新需求涉及哪些系统", "修改这个接口影响范围", "加这个功能要改哪些代码"
- Needs **architecture recommendations**: "这个功能放哪个服务合适", "推荐的实现方案"
- Asks about **Wiki/documentation**: "项目的部署文档在哪", "这个模块的设计文档"
- Is **onboarding**: "帮我介绍下项目架构", "新人入职需要了解哪些代码"
- Needs **API docs / Swagger**: "帮我查xx需求的接口定义", "xx功能的接口入参出参是什么"
- Needs **change impact query**: "我改了xx接口，帮我看下影响范围"

## How to answer

### Step 1: Retrieve context (search-first, classify-later)

**Default: always do a full search first (no `--type` filter).** This lets hybrid search
(BM25 keyword + vector semantic) rank the most relevant results across code, API definitions,
docs, and config — without risking misclassification.

```bash
# General query — searches all collections (code, api, docs, config)
codebase-intelligence query "用户登录逻辑" --context --limit 15

# Narrow by project if the user specifies one
codebase-intelligence query "订单创建" --context --project order-service --limit 15
```

**Only add `--type` or `--mode` filters when refining:**

```bash
# Precise API path lookup (use keyword mode for exact match)
codebase-intelligence query "POST /api/orders" --context --type api --mode keyword

# Code-only search for a specific function/class name
codebase-intelligence query "handlePayment" --context --type code --mode keyword

# Documentation/wiki search
codebase-intelligence query "部署文档" --context --type docs

# Config search (Dockerfile, CI/CD, k8s)
codebase-intelligence query "redis配置" --context --type config
```

**Two-round strategy for complex questions:**
1. **First round:** always omit `--type` (search all collections). Do not pre-classify the question into CODE vs API — that risks missing hits.
2. **Second round:** after reviewing results, narrow with `--type`, `--project`, or `--mode keyword` if you need Swagger-only hits, one repo, or exact symbol/path matches.

### Step 2: Classify and compose the answer

Based on search results, determine the question category:

- **CODE_QUERY**: specific code, logic explanation, function location
- **ARCHITECTURE_QUERY**: system relationships, dependency analysis, overview
- **API_QUERY**: interface definitions, request/response schemas, Swagger data
- **IMPACT_ANALYSIS**: requirement evaluation, change impact assessment
- **DOCUMENTATION_QUERY**: Wiki, README, design doc lookup

Always include:
1. **Specific file paths and line numbers** when referencing code (e.g., `src/api/handler.ts:42-89`)
2. **Project/service names** to disambiguate across repos
3. **Web URL** to the source file when available (from the `webUrl` metadata field)
4. **Confidence level** — if the index may be stale (>6h since last sync), mention it

For impact analysis, structure as:
1. **涉及系统** — which services/projects are affected
2. **需要修改的文件** — specific files and estimated changes
3. **侵入程度** — low/medium/high with justification
4. **架构建议** — recommended implementation approach
5. **数据库变更** — schema changes if any
6. **涉及团队** — which teams need to coordinate

### Step 3: Offer follow-up

- "需要我展示相关代码吗？"
- "需要我画出调用链图吗？"
- "需要我生成更详细的影响分析报告吗？"

## API documentation search

When asked about API definitions or Swagger docs:
1. Search with `--type api` (optionally + `--project`)
2. Present a summary table of matching endpoints
3. Expand request/response schemas from indexed data
4. Include the web URL to the original Swagger file in the repo (from search result metadata)

## Change impact query

1. Locate the changed API in the index
2. Check dependency graph via indexed dependency edges (stored during sync)
3. Present: who calls this API, compatibility assessment, suggested teams to inform

## Index management commands

```bash
# Reindex a specific project
codebase-intelligence reindex user-service

# Check sync status for all projects
codebase-intelligence status

# Sync all projects (incremental by default)
codebase-intelligence sync

# Force full sync for a specific project
codebase-intelligence sync --project user-service --full

# Start webhook server for real-time sync
codebase-intelligence serve --port 9876 --sync-on-start
```

## CLI quick reference

| Command | Description |
|---|---|
| `query <text>` | Search the index. Options: `--type`, `--project`, `--branch`, `--mode`, `--limit`, `--context`, `--detail` |
| `sync` | Sync all projects. Options: `--project`, `--full` |
| `status` | Show indexed project stats |
| `reindex <project>` | Full reindex of a project |
| `serve` | Start HTTP server (webhooks + status API). Options: `--port`, `--sync-on-start` |

## Configuration notes

- **Config file**: `codebase-intelligence.yaml` (search order: CWD → `~/.codebase-intelligence/config.yaml`)
- **Data directory**: `~/.codebase-intelligence/` (repos, SQLite DB, sync state)
- **Adding new GitLab/GitHub projects**: edit config YAML, then run `codebase-intelligence sync`. No need to restart `serve` — webhooks will pick up new projects on next push event.
- Index updates: run `codebase-intelligence serve` to receive push webhooks (L1); otherwise `sync` handles it (L2 incremental / L3 full fallback)
- Full sync runs every 6h via cron as a safety net
- Unchanged files are skipped via content_hash comparison
- Always verify critical findings against the actual repository for high-stakes decisions
