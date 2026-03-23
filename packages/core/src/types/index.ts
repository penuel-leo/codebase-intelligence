/**
 * Core type definitions for codebase-intelligence.
 */

// ─── Provider Types ──────────────────────────────────────────────

export type ProviderType = 'gitlab' | 'github' | 'local';

export interface ProjectMeta {
  /** Unique identifier: "provider:project-name" */
  id: string;
  name: string;
  provider: ProviderType;
  /** URL or local path */
  url: string;
  branches: string[];
  defaultBranch: string;
  language?: string;
  description?: string;
}

export interface FileChange {
  path: string;
  action: 'added' | 'modified' | 'deleted' | 'renamed';
  oldPath?: string;
  contentHash?: string;
}

export interface ChangeEvent {
  provider: ProviderType;
  project: string;
  branch: string;
  commitSha?: string;
  changes: FileChange[];
  timestamp: number;
}

export interface DocsPage {
  title: string;
  slug: string;
  content: string;
  format: 'markdown' | 'html' | 'text';
}

export interface TreeEntry {
  path: string;
  type: 'blob' | 'tree';
  size?: number;
}

// ─── Chunk Types ──────────────────────────────────────────────────

export type ChunkType = 'code' | 'api' | 'docs' | 'config' | 'migration' | 'proto';

export type CodeChunkKind = 'class' | 'method' | 'function' | 'struct' | 'module' | 'interface' | 'enum' | 'type';
export type ApiChunkKind = 'endpoint' | 'schema' | 'error_code';
export type DocsChunkKind = 'page' | 'section';
export type ConfigChunkKind = 'ci' | 'dockerfile' | 'k8s' | 'env' | 'config';
export type MigrationChunkKind = 'table_create' | 'table_alter' | 'index';
export type ProtoChunkKind = 'service' | 'rpc' | 'message';

export type ChunkKind =
  | CodeChunkKind
  | ApiChunkKind
  | DocsChunkKind
  | ConfigChunkKind
  | MigrationChunkKind
  | ProtoChunkKind;

export interface ChunkMetadata {
  /** Unique chunk ID */
  id: string;
  /** Source provider */
  source: ProviderType;
  /** Project name */
  project: string;
  /** Branch name */
  branch: string;
  /** Content type */
  type: ChunkType;
  /** Specific kind within type */
  chunkKind: ChunkKind;
  /** Programming language */
  language?: string;
  /** File path relative to project root */
  filePath: string;
  /** Line range */
  lineStart?: number;
  lineEnd?: number;
  /** Symbol info */
  symbolName?: string;
  className?: string;
  packageName?: string;
  /** API-specific */
  httpMethod?: string;
  apiPath?: string;
  tags?: string[];
  /** Docs-specific */
  pageTitle?: string;
  sectionHeading?: string;
  /** Projects referenced by this doc chunk (cross-project association) */
  relatedProjects?: string[];
  /** Functions/methods called by this chunk (tree-sitter mode only) */
  calls?: string[];
  /** Callers that reference this chunk (inverse of `calls`; filled after sync for SQLite store) */
  calledBy?: string[];
  /** Class/interface this extends (tree-sitter mode only) */
  extendsClass?: string;
  /** Interfaces this implements (tree-sitter mode only) */
  implementsInterfaces?: string[];
  /** Hash for deduplication */
  contentHash: string;
  /** Commit info */
  commitSha?: string;
  /** Web URL to view this file in GitLab/GitHub (auto-generated from source config) */
  webUrl?: string;
  /** Index timestamp */
  indexedAt: string;
}

export interface Chunk {
  metadata: ChunkMetadata;
  content: string;
  embedding?: number[];
}

// ─── Collection Types ──────────────────────────────────────────────

/** Collections are organized by content type, not by project */
export type CollectionName = 'code' | 'api' | 'docs' | 'config';

// ─── Query Types ──────────────────────────────────────────────────

export interface SearchFilter {
  source?: ProviderType | ProviderType[];
  project?: string | string[];
  branch?: string;
  type?: ChunkType | ChunkType[];
  chunkKind?: ChunkKind | ChunkKind[];
  language?: string | string[];
  filePath?: string;
  httpMethod?: string;
  tags?: string[];
}

export interface SearchOptions {
  /** Which collections to search (default: all) */
  collections?: CollectionName[];
  /** Metadata filter */
  filter?: SearchFilter;
  /** Max results per collection */
  topK?: number;
  /** Min similarity score (0-1) */
  minScore?: number;
}

export interface SearchResult {
  chunk: Chunk;
  score: number;
  collection: CollectionName;
}

// ─── Sync Types ──────────────────────────────────────────────────

export interface SyncState {
  project: string;
  provider: ProviderType;
  lastCommitSha: string;
  lastSyncAt: string;
  totalChunks: number;
  status: 'idle' | 'syncing' | 'error';
  error?: string;
}

// ─── Dependency Graph Types ──────────────────────────────────────

export interface DependencyEdge {
  from: string;
  to: string;
  type: 'http' | 'grpc' | 'mq' | 'database' | 'import';
  detail?: string;
}

export interface ServiceNode {
  name: string;
  type: 'microservice' | 'library' | 'frontend' | 'gateway' | 'worker';
  language?: string;
  framework?: string;
  databases?: string[];
  apisExposed?: string[];
  mqProduce?: string[];
  mqConsume?: string[];
}

export interface ArchitectureMap {
  services: Record<string, ServiceNode>;
  dependencies: DependencyEdge[];
  generatedAt: string;
}

// ─── Embedding Types ──────────────────────────────────────────────

export type EmbeddingProviderType = 'ollama' | 'openai' | 'custom_http' | string;

export interface EmbeddingResult {
  vector: number[];
  model: string;
  dimensions: number;
}
