/**
 * VectorStore interface — pluggable vector database abstraction.
 * Default: SQLite + sqlite-vec. Optional: ChromaDB, Qdrant.
 */

import type { Chunk, ChunkMetadata, CollectionName, SearchFilter } from '../types/index.js';

export interface VectorStoreQueryOptions {
  collection: CollectionName;
  embedding: number[];
  topK?: number;
  minScore?: number;
  filter?: SearchFilter;
}

export interface VectorStoreQueryResult {
  chunk: Chunk;
  score: number;
}

export interface VectorStore {
  /** Initialize store (create tables/collections) */
  init(): Promise<void>;

  /** Upsert chunks into a collection */
  upsert(collection: CollectionName, chunks: Chunk[]): Promise<void>;

  /** Delete chunks by filter */
  deleteByFile(collection: CollectionName, project: string, filePath: string): Promise<number>;

  /** Delete all chunks for a project */
  deleteByProject(collection: CollectionName, project: string): Promise<number>;

  /** Query by vector similarity + metadata filter */
  query(options: VectorStoreQueryOptions): Promise<VectorStoreQueryResult[]>;

  /** Get chunk count per collection */
  count(collection: CollectionName, filter?: SearchFilter): Promise<number>;

  /** Get all unique projects in store */
  listProjects(): Promise<string[]>;

  /** Close connections */
  close(): Promise<void>;
}

/** Factory function type for creating VectorStore instances */
export type VectorStoreFactory = (config: {
  url?: string;
  collectionPrefix?: string;
  dimensions?: number;
}) => VectorStore;
