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

You have access to a continuously updated index of the organization's repositories
(GitLab, GitHub, and/or local workspaces): application **code**, **docs** (Markdown and similar),
**API** specs (Swagger/OpenAPI), **config** (CI/CD, containers, infra-as-code), plus
dependency metadata produced during indexing.

All data is stored in SQLite with vector + FTS5 search. **Use the CLI for every operation**
listed below; there is no separate HTTP search API.

## When to activate

Use this skill when the user asks about:

- **Code behavior** — how a feature works, what a function does, where logic lives
- **Architecture** — services, boundaries, how systems relate, schemas
- **HTTP/API contracts** — parameters, responses, which service exposes an endpoint
- **Impact / change risk** — what breaks if an API or module changes
- **Design or placement** — where a capability should live
- **Documentation** — runbooks, design notes, README-style material in indexed repos
- **Onboarding** — high-level map of repos and responsibilities
- **Swagger/OpenAPI** — concrete request/response shapes from indexed specs

## How to answer

### Step 1: Search (`query`) — core workflow

**`query` is the primary command.** `sync`, `reindex`, and `reload` only maintain or validate
the index.

| Flag | Role |
|------|------|
| `--context` | Use for almost every agent answer: richer snippets and metadata. |
| `--limit <n>` | Max hits (default 10); increase for broad questions. |
| `--project <name>` | Restrict to one enrolled project when the user names it. |
| `--branch <name>` | Filter by branch when it matters. |
| `--type <t>` | Limit to `code`, `api`, `docs`, or `config`. Omit on the first pass. |
| `--mode <m>` | `hybrid` (default), `keyword` (paths/symbols/exact-ish), or `vector`. |
| `--detail` | Full chunk text per hit (verbose). |
| `-c, --config <path>` | Alternate config file. |

**First pass:** run `query` **without** `--type` so hybrid search can rank across all collections.
Guessing the wrong collection early often hides the best chunk.

```bash
codebase-intelligence query "user login flow" --context --limit 15
codebase-intelligence query "order creation" --context --project order-service --limit 15
```

**Second pass** (only if needed):

```bash
codebase-intelligence query "POST /api/orders" --context --type api --mode keyword
codebase-intelligence query "handlePayment" --context --type code --mode keyword
codebase-intelligence query "deployment guide" --context --type docs
codebase-intelligence query "redis configuration" --context --type config
```

**Habit:** (1) Broad search with `--context`. (2) If noisy or the user wants one layer only,
rerun with `--type`, `--project`, or `--mode keyword`.

### Step 2: Classify and respond

Infer the task type from results:

- **CODE_QUERY** — implementation detail, symbol location
- **ARCHITECTURE_QUERY** — services, dependencies, big picture
- **API_QUERY** — contracts and schemas
- **IMPACT_ANALYSIS** — blast radius of a change
- **DOCUMENTATION_QUERY** — prose docs and operational text

Always cite:

1. **Paths and line ranges** when the index provides them
2. **Project / service names** for multi-repo clarity
3. **`webUrl`** when present (link to the source browser)
4. **Staleness** — if sync may be old, say so

For impact-style answers, structure as: affected systems, files to touch, risk level,
recommended approach, data/schema impact, coordination notes.

## API documentation search

1. Prefer `--type api` (and `--project` if known).
2. Summarize matching endpoints in a small table.
3. Pull request/response detail from indexed chunks.
4. Include `webUrl` to the original spec file when available.

## Change-impact style questions

1. Find the API or symbol in the index (`query`).
2. Use dependency edges stored at sync time where relevant.
3. Summarize callers/consumers, compatibility risk, and who should be notified.

## Index maintenance (CLI)

```bash
codebase-intelligence reindex user-service
codebase-intelligence status
codebase-intelligence sync
codebase-intelligence sync --project user-service --full
codebase-intelligence reload
codebase-intelligence init
codebase-intelligence serve --port 9876 --sync-on-start
```

## CLI quick reference

| Command | Purpose |
|---------|---------|
| `init` | Create config if missing; on Unix, register `sync` in **user crontab** via system `crontab`. Re-run to refresh. `-p` `-d` |
| `query <text>` | **Search** (main). `-c -t -p -b -n -m --context --detail` |
| `sync` | Fetch and index. `-c -p --full --parser` |
| `status` | Index/sync overview. `-c` |
| `reindex <project>` | Full rebuild for one project. `-c --parser` |
| `serve` | Long-lived webhook + small HTTP status API. `-c -p --sync-on-start --parser` |
| `reload` | Parse and validate YAML only. `-c` |

## Configuration notes

- Config resolution: `codebase-intelligence.yaml` in CWD, then `~/.codebase-intelligence/config.yaml` (see repo docs for full search order).
- Data default: under `~/.codebase-intelligence/`.
- After editing YAML: `reload` then `sync`. Restart `serve` manually if it is already running so it picks up new settings.
- **Periodic sync:** on macOS/Linux, `init` tries to add a `codebase-intelligence sync -c <yaml>` line to your user crontab (schedule from `sync.cron`). Failure is non-fatal. Windows: run `sync` manually or use Task Scheduler. You can still use CI/K8s cron separately if you prefer.
- Unchanged files are skipped using `content_hash`.
- For high-stakes decisions, confirm against the live repository.

## Docs metadata: `relatedProjects`

During indexing, **docs** chunks can carry **`relatedProjects`**: other enrolled project names
detected from the doc **file path** or **body** (word-boundary match), excluding the doc's
own project. That enables **`query --project X`** to surface documentation that lives in a
different repo but references `X`. Implementation: `findRelatedProjects` in
`packages/core/src/pipeline/docs-parser.ts`; search filtering uses the `related_projects`
column in `packages/core/src/store/sqlite-vec-store.ts` (`buildFilterClause`).
