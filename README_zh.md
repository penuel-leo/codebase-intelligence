# Codebase Intelligence — 代码仓库智能引擎

> 可插拔的代码仓库智能引擎。接入 GitLab、GitHub 或本地项目，自动同步、索引、理解你的全部代码。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-green)](https://nodejs.org/)

[English](./README.md) | [技术设计文档](./docs/design.md)

---

## 特性

- **可插拔数据源** — GitLab、GitHub、本地文件系统，同一配置中混合使用
- **增量同步** — 首次 clone，日常 pull+diff；`git diff --name-status` 识别增删改/重命名。diff 失败自动降级全量重建
- **Git 镜像自愈** — 数据目录下的 clone 在 pull/checkout 冲突或分叉时自动 `reset --hard` 对齐 `origin/<branch>`；残留非 git 目录会删除后重 clone
- **多分支安全** — 同一仓库多分支 **串行** `checkout`（不同仓库仍可按 `concurrency` 并行）
- **首次索引断点** — 首次全量索引过程中周期性写入 `sync_state`（`index_resume_offset` / `index_resume_head`），进程中断后 **同一 HEAD** 下可续跑；成功后或 L3 降级时清除
- **Webhook（L1）** — `codebase-intelligence serve` 提供 `POST /webhook/gitlab`、`POST /webhook/github` 与 `GET /api/status`
- **混合搜索** — BM25 关键字（FTS5）+ 向量语义，加权合并
- **依赖图谱** — 服务级依赖链路，BFS 遍历影响范围
- **多分支** — 自动检测默认分支，可配置额外分支
- **任意 Embedding** — Ollama、OpenAI、或任何兼容 OpenAI 格式的服务（阿里云、Azure、Deepseek、vLLM）
- **零外部依赖** — 默认只用 SQLite。可选：ChromaDB / Qdrant
- **Docker 或直接运行** — CLI 直接用、Docker 部署、或作为 npm 包嵌入

## 前置条件

- **Node.js** >= 18
- **Git**
- **Embedding 服务**（三选一）：
  - [Ollama](https://ollama.ai/) + `nomic-embed-text`（推荐，免费本地）
  - OpenAI API Key
  - 任何兼容 OpenAI `/v1/embeddings` 的服务

## 安装

### 方式 A：npm 全局安装

```bash
npm install -g @codebase-intelligence/cli
```

### 方式 B：npx 免安装

```bash
npx @codebase-intelligence/cli init
```

### 方式 C：从源码构建

```bash
git clone https://github.com/your-org/codebase-intelligence.git
cd codebase-intelligence
npm install
npm run build
npm link
```

### 方式 D：Docker

```bash
cd docker
cp ../config/example-mixed.yaml config.yaml
# 编辑 config.yaml...
docker compose up -d
```

## 快速开始

```bash
# 1. 生成配置
codebase-intelligence init --provider local

# 2. 编辑 codebase-intelligence.yaml（添加你的项目）

# 3. 启动 Ollama（如果使用 ollama）
ollama pull nomic-embed-text

# 4. 同步
codebase-intelligence sync

# 5. 搜索
codebase-intelligence query "下单接口逻辑"
codebase-intelligence query "GET /api/users" --mode keyword --type api
codebase-intelligence query "优惠券相关" --project user-service --branch develop
```

## 配置说明

```yaml
sources:
  # GitLab（可以和 Local 同时配置，互不干扰）
  - provider: gitlab
    url: https://gitlab.yourcompany.com
    tokenEnv: GITLAB_TOKEN          # 环境变量名（不是直接写 token）
    branches: [main, develop]
    projects:
      - group: backend-team         # 按组导入
      - id: 42                      # 指定项目ID
        name: user-service

  # GitHub
  - provider: github
    tokenEnv: GITHUB_TOKEN
    projects:
      - org: your-org

  # 本地项目（读取你指定的目录，不做 clone）
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

  # 阿里云 DashScope:
  # provider: custom_http
  # model: text-embedding-v4
  # url: https://dashscope.aliyuncs.com/compatible-mode
  # apiKeyEnv: DASHSCOPE_API_KEY
  # dimensions: 1024

sync:
  strategy: incremental
  concurrency: 3

# HTTP：Webhook + 状态 API（见下方「Webhook」）
server:
  port: 9876
```

> **多源共存**：GitLab clone 到 `~/.codebase-intelligence/repos/`，Local 直接读取用户指定的 path，两者互不干扰。

更多示例：[default](config/default.yaml) | [gitlab](config/example-gitlab.yaml) | [github](config/example-github.yaml) | [mixed](config/example-mixed.yaml)

## CLI 命令

| 命令 | 说明 |
|---|---|
| `codebase-intelligence init` | 生成配置文件 |
| `codebase-intelligence sync` | 同步所有项目。选项：`--project <name>` 只同步该项目；`--full` 强制全量同步（忽略增量） |
| `codebase-intelligence query <text>` | 搜索索引 |
| `codebase-intelligence status` | 查看索引状态 |
| `codebase-intelligence reindex <project>` | 全量重建某项目 |
| `codebase-intelligence serve` | 启动 HTTP 服务（接收 Webhook，见下） |

在配置里新增或修改 GitLab/GitHub 项目后，执行 `codebase-intelligence sync` 即可；**不必**为此重启 `serve`（除非你改了服务监听地址/端口等）。Webhook 只会匹配已经至少成功同步过一次的项目。

### Webhook 与 HTTP 服务

```bash
codebase-intelligence serve -c codebase-intelligence.yaml
# 可选：--port 9876 覆盖配置；--sync-on-start 启动前先跑一轮 sync
```

| 端点 | 说明 |
|---|---|
| `POST /webhook/gitlab` | GitLab **Push** 事件；按 `project.path_with_namespace` 与配置中 `projects[].name` **全路径**一致匹配 |
| `POST /webhook/github` | GitHub **push** 事件；按 `repository.full_name` 或 `name` 与已配置项目匹配 |
| `GET /api/status` | 最近同步概况 |
| `GET /api/projects` | 已索引项目列表 |

### 搜索选项

```
-t, --type <type>     过滤类型: code, api, docs, wiki（wiki 为 docs 的别名）, config
-p, --project <name>  过滤项目
-b, --branch <name>   过滤分支
-m, --mode <mode>     搜索模式: hybrid(默认), keyword, vector
-n, --limit <number>  最大结果数 (默认: 10)
--context             输出 LLM 可消费的完整上下文
--detail              人类可读模式下输出每条结果的完整正文
```

不传 `--type` 时会在所有集合（代码、API 文档、Wiki/文档、配置）中统一搜索。

### 搜索模式

| 模式 | 适合场景 | 示例 |
|---|---|---|
| `hybrid`（默认） | 通用查询 | `query "用户服务接口"` |
| `keyword` | 精确名称 | `query "UserController" --mode keyword` |
| `vector` | 语义意图 | `query "下单流程是怎样的" --mode vector` |

## OpenClaw 集成

### 作为 Skill 安装

```bash
# 通过 ClawHub
clawhub install codebase-intelligence

# 或手动安装
cp -r packages/openclaw/ ~/.openclaw/skills/codebase-intelligence/
```

### Skill 配置

在 OpenClaw 的 `config.yaml` 中添加：

```yaml
skills:
  codebase-intelligence:
    enabled: true
    config_path: ~/.codebase-intelligence/config.yaml
```

Skill 暴露以下工具给 Agent：
- `codebase_search` — 混合搜索所有已索引项目
- `codebase_search_code` — 只搜代码
- `codebase_search_api` — 只搜 API 定义
- `codebase_impact` — 变更影响分析

### 作为 npm 包使用

```typescript
import { loadConfig, SearchEngine } from '@codebase-intelligence/core';
import { SyncEngine } from '@codebase-intelligence/providers';

const config = loadConfig('codebase-intelligence.yaml');
const engine = new SyncEngine({ config });
await engine.init();
await engine.syncAll();

const search = new SearchEngine(engine.getStore(), engine.getEmbedding());
const results = await search.search('下单逻辑', { mode: 'hybrid' });
```

## Embedding 推荐

| 模型 | 代码理解 | 中文 | 成本 | 推荐场景 |
|---|---|---|---|---|
| `nomic-embed-text` (Ollama) | ⭐⭐⭐ | ⭐⭐ | 免费本地 | 开发/小团队 |
| `BAAI/bge-m3` (Ollama) | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | 免费本地 | **中文+代码最优** |
| `text-embedding-v4` (阿里云) | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ¥0.7/百万token | 生产环境 |
| `text-embedding-3-small` (OpenAI) | ⭐⭐⭐ | ⭐⭐⭐ | $0.02/百万token | 英文项目 |

## npm 包

| 包 | 说明 |
|---|---|
| `@codebase-intelligence/core` | 索引引擎、存储、搜索、分析 |
| `@codebase-intelligence/providers` | GitLab / GitHub / Local 适配 + 同步引擎 |
| `@codebase-intelligence/cli` | 命令行工具 |
| `@codebase-intelligence/openclaw` | OpenClaw skill + plugin 适配 |

## 搜索范围

**本工具只搜索已在配置中收录并通过 `sync` 索引的项目。**

不会搜索任意的 GitHub/GitLab 仓库。运行 `codebase-intelligence status` 查看已索引项目。

## 贡献

详见 [CONTRIBUTING.md](./CONTRIBUTING.md)。安全问题请阅 [SECURITY.md](./SECURITY.md)。

1. Fork 本仓库
2. 创建特性分支 (`git checkout -b feature/amazing-feature`)
3. 提交更改
4. 推送分支
5. 创建 Pull Request

## 许可证

[MIT](./LICENSE)
