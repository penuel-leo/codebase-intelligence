# Codebase Intelligence — 技术设计文档

> 本文档描述当前已实现的架构和技术方案，不包含方案对比讨论。

---

## 一、系统定位

Codebase Intelligence 是一个可插拔的代码仓库智能引擎。接入 GitLab、GitHub 或本地项目后，自动同步、索引、理解代码。核心能力：

| 能力层 | 描述 | 实现状态 |
|---|---|---|
| L0 — 数据源抽象 | 可插拔对接 GitLab / GitHub / 本地 | ✅ 已实现 |
| L1 — Webhook 触发 | `serve`：GitLab/GitHub push → `syncProjectBranch` | ✅ 已实现 |
| L2 — 同步引擎 | `SyncEngine`：pull/diff、首次索引断点、`name-status`、L3 降级 | ✅ 已实现 |
| L3 — 代码索引 | 按函数/类/模块粒度切片 + 向量化 | ✅ 已实现 |
| L4 — API 文档索引 | Swagger/OpenAPI 按 endpoint 切片 | ✅ 已实现 |
| L5 — 架构图谱 | 项目间依赖关系图（Graph BFS） | ✅ 已实现 |
| L6 — 混合搜索 | BM25 关键字 + 向量语义 + Graph 链路 | ✅ 已实现 |
| L7 — 影响分析 | 需求影响范围评估 | ✅ 基础实现 |

---

## 二、整体架构

```
┌────────────┐  ┌────────────┐  ┌────────────┐
│   GitLab    │  │   GitHub   │  │   Local    │
│  Provider   │  │  Provider  │  │  Provider  │
└─────┬──────┘  └─────┬──────┘  └─────┬──────┘
      └───────────────┼───────────────┘
                      ▼
          ┌───────────────────────┐
          │  Sync Engine (方案C)   │
          │  L1: webhook→sync     │
          │  L2: pull+diff        │
          │  L3: fallback reindex │
          └───────────┬───────────┘
                      ▼
          ┌───────────────────────┐
          │   Indexing Pipeline    │
          │  router → parser →    │
          │  embedding → store    │
          └───────────┬───────────┘
                      ▼
    ┌────────┬────────┬──────────┐
    │  code  │  api   │   docs   │
    │FTS5+Vec│FTS5+Vec│ FTS5+Vec │
    └────────┴────────┴──────────┘
          ┌───────────────────────┐
          │  dependencies (Graph) │
          │  sync_state (Meta)    │
          └───────────────────────┘
```

### npm 包分层

```
@codebase-intelligence/core       → 索引引擎、存储、搜索、分析
@codebase-intelligence/providers  → GitLab / GitHub / Local 适配器 + Sync Engine
@codebase-intelligence/cli        → 命令行工具（init / sync / query / status / reindex / serve）
@codebase-intelligence/openclaw   → OpenClaw skill + plugin 适配（薄壳）
```

---

## 三、数据源可插拔（Source Provider）

### 3.1 SourceProvider 接口

```typescript
interface SourceProvider {
  type: ProviderType;           // 'gitlab' | 'github' | 'local'
  init(config): Promise<void>;
  listProjects(): Promise<ProjectMeta[]>;
  getChangedFiles(project, sinceCommit): Promise<FileChange[]>;
  getHeadCommit(project): Promise<string>;
  getFileTree(project): Promise<string[]>;
  pull(project, branch?): Promise<{ headCommit, hasChanges }>;
  clone(project): Promise<void>;
  isCloned(project): boolean;
  getLocalPath(project): string;
  getWikiPages?(project): Promise<WikiPage[]>;
}
```

### 3.2 各 Provider 实现

| 能力 | GitLab | GitHub | Local |
|---|---|---|---|
| 项目发现 | API `/groups/:id/projects` | API `/orgs/:org/repos` | 扫描配置的 path |
| Clone | `git clone --depth=1 --no-single-branch` | 同左 | 不需要（原地读取） |
| Pull | `git fetch → checkout branch → pull` | 同左 | `git pull`（如果是 git 仓库） |
| 变更检测 | `git diff sinceCommit HEAD` | 同左 | 同左 |
| 文件读取 | 本地 clone 后 `fs.readFile` | 同左 | 直接 `fs.readFile` |
| Wiki | Clone `.wiki.git` 仓库 | Clone `.wiki.git` 仓库 | 扫描 `docs/` 目录 |
| 限频风险 | **极低**（日常走 Git 协议） | **极低**（同左） | 无 |

### 3.3 多源共存

GitLab 和 Local 可以同时配置，互不干扰：
- GitLab/GitHub clone 到 `~/.codebase-intelligence/repos/{project}/`
- Local 直接读取用户指定的 `path`，不做 clone

注意：如果 Local 的 path 指向了 GitLab clone 下来的目录，同一套代码会被索引两次。

---

## 四、同步策略（方案C 混合增量）

### 三层递进

| 层级 | 触发 | 逻辑 |
|---|---|---|
| **L1（可选）** | GitLab/GitHub Webhook → `POST /webhook/*` | `CIServer` 解析 payload，对匹配项目调用 `syncProjectBranch` |
| **L2（默认）** | cron 定时 / CLI `sync` | `safeCheckout` + `safePull` → `git diff --name-status` 相对 `last_commit_sha` → 只处理变更（含删除/重命名） |
| **L3（自动降级）** | L2 的 diff 抛异常时 | 清除该 `project@branch` 的索引断点；删除 chunk 后按全文件树重建 |

### 增量核心逻辑

```
首次接入 → safeClone（清理损坏目录）→ 全量索引；索引中周期性写入 sync_state.index_resume_*，同 HEAD 可续跑
后续同步 → fetch → safeCheckout → safePull（失败则 hard-reset 到 origin/branch）→ name-status diff → 增量索引
diff 失败 → L3 全量 reindex
```

### Git 镜像自愈（git-utils）

- **safeCheckout**：工作区脏或冲突时 `reset --hard` + `clean`，再切分支或新建跟踪分支。
- **safePull**：merge 拒绝、分叉、unrelated histories 等 → `fetch` 后 `reset --hard origin/<branch>`（或 `checkout -B`）。
- **safeClone**：路径存在但无 `.git` → 删除目录后重新 clone。

### 多分支处理

- 默认自动检测 `defaultBranch`（`git remote show origin`）
- 配置 `branches: [main, develop]` 时，每个分支独立 sync
- Sync state key = `project@branch`，不同分支互不影响
- **同一仓库**的多个分支任务 **串行** 执行（共享同一 clone 目录），不同仓库之间仍受 `sync.concurrency` 并行调度
- clone 时 `--no-single-branch`，允许后续 checkout 任意分支

### 首次全量索引断点（sync_state）

- 表 `sync_state` 扩展字段：`index_resume_offset`、`index_resume_head`。
- 仅在 **首次同步**（尚无 `last_commit_sha`）且全量文件列表索引时，每处理若干文件刷新断点；成功写入 `last_commit_sha` 后清空。
- 若 **HEAD 变更** 与 `index_resume_head` 不一致，丢弃旧断点，避免混写。

### 去重机制

每个 chunk 存 `content_hash`（SHA-256 前 16 位）。文件修改后重新切片，对比 hash，只 upsert 真正变化的 chunk。

---

## 五、索引流水线

### 5.1 文件路由（router.ts）

根据文件扩展名和路径模式，决定解析方式：

| 文件类型 | 判断逻辑 | 解析器 | 目标集合 |
|---|---|---|---|
| 源代码 | 扩展名 `.java` `.ts` `.go` `.py` 等 25+ 种 | code-parser | `code` |
| API 文档 | 文件名 `swagger.json` `openapi.yaml` 等 | api-doc-parser | `api` |
| Wiki/文档 | 扩展名 `.md` `.mdx` `.rst` | wiki-parser | `docs` |
| 配置 | `.yaml` `.toml` `.env` `Dockerfile` 等 | config-parser | `config` |
| SQL 迁移 | `migrations/` 目录下的 `.sql` | code-parser (sql) | `code` |
| Proto/Thrift | `.proto` `.thrift` | code-parser | `code` |
| 二进制/vendor | `node_modules/` `.min.js` 图片等 | skip | — |

### 5.2 代码解析（code-parser.ts）

按语言使用 regex heuristic 切分为函数/类/模块粒度：

| 语言 | 切分粒度 |
|---|---|
| Java / Kotlin / C# | 包 + 类 + 方法 |
| Go | Package + Function + Struct |
| Python | Module + Function/Class |
| JS / TS | Module + 导出函数/Class |
| 其他 | 100 行滑动窗口 |

小文件（≤50 行）整体作为一个 chunk。

### 5.3 API 文档解析（api-doc-parser.ts）

解析 Swagger 2.0 / OpenAPI 3.x，按 endpoint 粒度切片。每个 chunk 包含：
- HTTP method + path
- Summary + Description
- Parameters（name, type, required）
- Request body schema
- Response schema

### 5.4 Wiki 解析（wiki-parser.ts）

按 Markdown heading 切分为 section 级别 chunk。

### 5.5 Embedding

可插拔 Embedding Provider：

| Provider 类型 | 说明 | 配置 |
|---|---|---|
| `ollama` | 本地 Ollama（默认） | `model: nomic-embed-text` |
| `openai` | OpenAI API | `model: text-embedding-3-small` |
| `custom_http` | 任何兼容 OpenAI `/v1/embeddings` 的服务 | 阿里云 DashScope / Azure / Deepseek / vLLM 等 |

---

## 六、存储设计

### 6.1 三种搜索模式

| 模式 | 引擎 | 适合场景 |
|---|---|---|
| **BM25 关键字** | SQLite FTS5 | 精确匹配：函数名、API path、变量名 |
| **向量语义** | SQLite cosine / ChromaDB HNSW | 模糊语义："下单逻辑"、"优惠券相关" |
| **Hybrid 混合** | BM25(0.3) + Vector(0.7) 加权 | 默认模式，两者互补 |

BM25 高置信命中（score > 0.8）时自动提权。

### 6.2 Collection 设计

按内容类型分 collection，不按项目分：

| Collection | 内容 | Metadata |
|---|---|---|
| `code` | 函数/类/模块代码块 | project, branch, language, file_path, symbol_name, class_name, content_hash |
| `api` | Swagger endpoint | project, branch, http_method, api_path, tags |
| `docs` | 文档段落 | project, branch, page_title, section_heading |

每个 collection 同时建立：
- **主表**（数据 + embedding blob）
- **FTS5 虚拟表**（content, symbol_name, class_name, file_path, api_path, page_title）
- **自动同步触发器**（INSERT/UPDATE/DELETE 触发 FTS 更新）

### 6.3 依赖图谱（Graph Store）

SQLite 关系表，存储服务间依赖：

```sql
dependencies (from_service, to_service, type, detail)
-- type: 'http' | 'grpc' | 'mq' | 'database' | 'import'
```

支持的查询：
- `getUpstream(service)` — 谁调用了我？
- `getDownstream(service)` — 我调用了谁？
- `getImpactChain(service, depth)` — BFS 遍历 N 跳内所有关联服务

### 6.4 数据库可配置

| Provider | 说明 | 适用规模 |
|---|---|---|
| `sqlite`（默认） | 零依赖，FTS5 + cosine 暴力扫描 | < 100K chunks |
| `chromadb` | 需额外部署，HNSW 向量索引 | 100K - 1M chunks |
| `qdrant` | 需额外部署，生产级 | > 1M chunks |

---

## 七、项目结构

```
codebase-intelligence/
├── packages/
│   ├── core/src/
│   │   ├── types/          # TypeScript 类型定义
│   │   ├── config.ts       # YAML 配置加载
│   │   ├── pipeline/       # 索引流水线
│   │   │   ├── router.ts       # 文件类型路由
│   │   │   ├── code-parser.ts  # 多语言代码切片
│   │   │   ├── api-doc-parser.ts  # OpenAPI 解析
│   │   │   ├── wiki-parser.ts  # Markdown 段落切分
│   │   │   ├── config-parser.ts   # 配置文件索引
│   │   │   ├── embedding.ts    # Ollama / OpenAI / custom_http
│   │   │   └── indexer.ts      # 流水线编排
│   │   ├── store/          # 存储层
│   │   │   ├── vector-store.ts     # VectorStore 接口
│   │   │   ├── sqlite-vec-store.ts # FTS5 + Vector + Graph
│   │   │   ├── chromadb-store.ts   # ChromaDB 实现
│   │   │   └── store-factory.ts    # 工厂
│   │   ├── query/          # 搜索层
│   │   │   ├── search.ts          # Hybrid search
│   │   │   └── context-builder.ts  # LLM context 组装
│   │   └── analysis/       # 分析层
│   │       ├── dependency-analyzer.ts
│   │       ├── architecture-mapper.ts
│   │       └── impact-analyzer.ts
│   ├── providers/src/
│   │   ├── interface.ts        # SourceProvider 接口
│   │   ├── gitlab.ts / github.ts / local.ts
│   │   ├── provider-factory.ts
│   │   └── sync-engine.ts     # 方案C 同步引擎
│   ├── cli/src/
│   │   └── commands/       # init / sync / query / status / reindex
│   └── openclaw/src/       # OpenClaw 适配
├── config/                 # 示例配置
├── docker/                 # Dockerfile + docker-compose
└── docs/                   # 设计文档
```
