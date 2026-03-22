// Types
export * from './types/index.js';
export * from './types/config.js';

// Config
export { loadConfig, findConfigFile, resolveToken, getDataDir, getWorkspaceDir, getDbPath } from './config.js';

// Store
export { createVectorStore } from './store/store-factory.js';
export type { VectorStore, VectorStoreQueryOptions, VectorStoreQueryResult } from './store/vector-store.js';
export { SqliteVecStore } from './store/sqlite-vec-store.js';

// Pipeline
export { Indexer } from './pipeline/indexer.js';
export type { IndexerConfig, IndexResult } from './pipeline/indexer.js';
export { createEmbeddingProvider } from './pipeline/embedding.js';
export type { EmbeddingProvider } from './pipeline/embedding.js';
export { routeFile, shouldIndex } from './pipeline/router.js';

// Query
export { SearchEngine } from './query/search.js';
export type { SearchMode, ExtendedSearchOptions } from './query/search.js';
export { buildContext, formatResults, validateProjectScope } from './query/context-builder.js';

// Analysis
export { analyzeDependencies, toEdges } from './analysis/dependency-analyzer.js';
export { ArchitectureMapper } from './analysis/architecture-mapper.js';
export { ImpactAnalyzer } from './analysis/impact-analyzer.js';
export type { ImpactReport } from './analysis/impact-analyzer.js';
