/**
 * Multi-collection unified search engine.
 * Supports three modes:
 *   - hybrid (default): BM25 keyword + vector semantic, weighted merge
 *   - keyword: FTS5 BM25 only (exact match, function names, API paths)
 *   - vector: cosine similarity only (semantic)
 */

import type { CollectionName, SearchFilter, SearchOptions, SearchResult } from '../types/index.js';
import type { VectorStore } from '../store/vector-store.js';
import type { EmbeddingProvider } from '../pipeline/embedding.js';
import type { SqliteVecStore, HybridSearchOptions } from '../store/sqlite-vec-store.js';

export type SearchMode = 'hybrid' | 'keyword' | 'vector';

export interface ExtendedSearchOptions extends SearchOptions {
  /** Search mode: hybrid (default), keyword, vector */
  mode?: SearchMode;
  /** BM25 keyword weight (0-1). Default: 0.3 */
  keywordWeight?: number;
  /** Vector similarity weight (0-1). Default: 0.7 */
  vectorWeight?: number;
}

export class SearchEngine {
  constructor(
    private store: VectorStore,
    private embedding: EmbeddingProvider,
  ) {}

  /**
   * Search across all or specified collections.
   * Uses hybrid search (BM25+vector) by default when store supports it.
   */
  async search(query: string, options?: ExtendedSearchOptions): Promise<SearchResult[]> {
    const collections = options?.collections ?? ['code', 'api', 'docs', 'config'] as CollectionName[];
    const topK = options?.topK ?? 10;
    const mode = options?.mode ?? 'hybrid';

    // Check if store supports hybrid search (SqliteVecStore)
    const supportsHybrid = typeof (this.store as any).hybridSearch === 'function';

    // Generate embedding for vector/hybrid modes
    let queryEmbedding: number[] | undefined;
    if (mode !== 'keyword') {
      try {
        const result = await this.embedding.embed(query);
        queryEmbedding = result.vector;
      } catch (err: any) {
        // If embedding fails, fallback to keyword-only
        if (mode === 'vector') throw err;
        console.warn(`Embedding failed, falling back to keyword search: ${err.message}`);
      }
    }

    // Search all collections
    const promises = collections.map(async (collection): Promise<SearchResult[]> => {
      let results: Array<{ chunk: any; score: number }>;

      if (supportsHybrid) {
        // Use hybrid search (FTS5 + vector)
        const hybridStore = this.store as SqliteVecStore;
        results = await hybridStore.hybridSearch({
          collection,
          query,
          embedding: queryEmbedding,
          filter: options?.filter,
          topK,
          minScore: options?.minScore,
          keywordWeight: options?.keywordWeight,
          vectorWeight: options?.vectorWeight,
          mode: queryEmbedding ? mode : 'keyword',
        });
      } else if (mode === 'keyword') {
        // Store doesn't support keyword — fallback to vector
        if (!queryEmbedding) return [];
        results = await this.store.query({
          collection, embedding: queryEmbedding, topK,
          minScore: options?.minScore, filter: options?.filter,
        });
      } else {
        // Vector-only search
        if (!queryEmbedding) return [];
        results = await this.store.query({
          collection, embedding: queryEmbedding, topK,
          minScore: options?.minScore, filter: options?.filter,
        });
      }

      return results.map(r => ({ chunk: r.chunk, score: r.score, collection }));
    });

    const allResults = (await Promise.all(promises)).flat();
    allResults.sort((a, b) => b.score - a.score);
    return allResults.slice(0, topK);
  }

  /** Search only code chunks */
  async searchCode(query: string, filter?: SearchFilter, topK?: number): Promise<SearchResult[]> {
    return this.search(query, { collections: ['code'], filter, topK: topK ?? 10 });
  }

  /** Search only API definitions */
  async searchApi(query: string, filter?: SearchFilter, topK?: number): Promise<SearchResult[]> {
    return this.search(query, { collections: ['api'], filter, topK: topK ?? 10 });
  }

  /** Search only wiki/documentation */
  async searchWiki(query: string, filter?: SearchFilter, topK?: number): Promise<SearchResult[]> {
    return this.search(query, { collections: ['docs'], filter, topK: topK ?? 10 });
  }

  /** Get indexed project list (for scope validation) */
  async getIndexedProjects(): Promise<string[]> {
    return this.store.listProjects();
  }
}
