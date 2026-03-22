/**
 * Configuration types for codebase-intelligence.
 * Config is loaded from YAML and is fully declarative.
 */

import type { ProviderType, EmbeddingProviderType } from './index.js';

// ─── Top-level Config ────────────────────────────────────────────

export interface AppConfig {
  sources: SourceConfig[];
  storage: StorageConfig;
  embedding: EmbeddingConfig;
  sync: SyncConfig;
  server?: ServerConfig;
}

// ─── Source Provider Config ──────────────────────────────────────

export interface SourceConfig {
  provider: ProviderType;
  name?: string;
  url?: string;
  /** Environment variable name that holds the token */
  tokenEnv?: string;
  projects: ProjectConfig[];
  branches?: string[];
  includeWiki?: boolean;
  apiDocs?: ApiDocConfig[];
}

export interface ProjectConfig {
  /** GitLab: project ID or path; GitHub: "org/repo"; Local: filesystem path */
  id?: number | string;
  name?: string;
  repo?: string;
  path?: string;
  group?: string;
  org?: string;
  branches?: string[];
  includeWiki?: boolean;
  apiDocs?: ApiDocConfig[];
}

export interface ApiDocConfig {
  type: 'file' | 'url';
  path?: string;
  url?: string;
}

// ─── Storage Config ──────────────────────────────────────────────

export type VectorStoreType = 'sqlite' | 'chromadb' | 'qdrant';
export type MetaStoreType = 'sqlite';

export interface StorageConfig {
  vector: VectorStoreConfig;
  meta: MetaStoreConfig;
  /** Base directory for all data (repos, db files) */
  dataDir: string;
}

export interface VectorStoreConfig {
  provider: VectorStoreType;
  /** SQLite: file path; ChromaDB: host:port; Qdrant: host:port */
  url?: string;
  /** For ChromaDB/Qdrant */
  apiKey?: string;
  /** Collection prefix (default: "ci_") */
  collectionPrefix?: string;
}

export interface MetaStoreConfig {
  provider: MetaStoreType;
  url?: string;
}

// ─── Embedding Config ────────────────────────────────────────────

export interface EmbeddingConfig {
  provider: EmbeddingProviderType;
  model: string;
  /** Ollama: http://localhost:11434; OpenAI: https://api.openai.com; Custom: any /v1/embeddings endpoint */
  url?: string;
  /** Environment variable name for API key */
  apiKeyEnv?: string;
  dimensions?: number;
  batchSize?: number;
  /** Extra HTTP headers (e.g. for Azure api-version). Only for custom_http / openai. */
  extraHeaders?: Record<string, string>;
}

// ─── Sync Config ─────────────────────────────────────────────────

export interface SyncConfig {
  /** Sync strategy */
  strategy: 'incremental' | 'full';
  /** Cron expression for scheduled full sync (default: every 6 hours, e.g. minute 0 of every 6th hour) */
  cron?: string;
  /** Directory to store cloned repos */
  workspace?: string;
  /** Max concurrent sync operations (different projects can run in parallel; same-project branches are always serial) */
  concurrency?: number;
}

// ─── Server Config ───────────────────────────────────────────────

export interface ServerConfig {
  /**
   * HTTP server port for:
   *   - Webhook receiver: POST /webhook/gitlab, POST /webhook/github
   *   - Status API: GET /api/status, GET /api/projects
   * Start with: codebase-intelligence serve --port <port>
   */
  port: number;
  host?: string;
}
