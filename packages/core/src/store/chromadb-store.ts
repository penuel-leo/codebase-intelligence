/**
 * ChromaDB vector store implementation.
 * Optional upgrade from SQLite for production scale (100K+ chunks).
 *
 * Requires: npm install chromadb
 */

import type { Chunk, CollectionName, SearchFilter } from '../types/index.js';
import type { VectorStore, VectorStoreQueryOptions, VectorStoreQueryResult } from './vector-store.js';

interface ChromaDbConfig {
  url?: string;
  collectionPrefix?: string;
  dimensions?: number;
  apiKey?: string;
}

export class ChromaDbStore implements VectorStore {
  private client: any;
  private collections: Map<string, any> = new Map();
  private prefix: string;
  private config: ChromaDbConfig;

  constructor(config: ChromaDbConfig) {
    this.config = config;
    this.prefix = config.collectionPrefix ?? 'ci_';
  }

  async init(): Promise<void> {
    let chromadb: any;
    try {
      chromadb = await import('chromadb');
    } catch {
      throw new Error(
        'ChromaDB is not installed. Install it with: npm install chromadb\n' +
        'Or switch to SQLite (default) in your config: storage.vector.provider: sqlite'
      );
    }

    this.client = new chromadb.ChromaClient({
      path: this.config.url ?? 'http://localhost:8000',
    });

    // Create or get collections
    const collectionNames: CollectionName[] = ['code', 'api', 'docs', 'config'];
    for (const name of collectionNames) {
      const fullName = `${this.prefix}${name}`;
      const collection = await this.client.getOrCreateCollection({
        name: fullName,
        metadata: { 'hnsw:space': 'cosine' },
      });
      this.collections.set(name, collection);
    }
  }

  async upsert(collection: CollectionName, chunks: Chunk[]): Promise<void> {
    const col = this.getCollection(collection);
    if (chunks.length === 0) return;

    const ids = chunks.map(c => c.metadata.id);
    const embeddings = chunks.map(c => c.embedding ?? []);
    const documents = chunks.map(c => c.content);
    const metadatas = chunks.map(c => this.chunkToMetadata(c));

    // ChromaDB batch limit is typically 5000
    const batchSize = 500;
    for (let i = 0; i < chunks.length; i += batchSize) {
      await col.upsert({
        ids: ids.slice(i, i + batchSize),
        embeddings: embeddings.slice(i, i + batchSize),
        documents: documents.slice(i, i + batchSize),
        metadatas: metadatas.slice(i, i + batchSize),
      });
    }
  }

  async deleteByFile(collection: CollectionName, project: string, filePath: string): Promise<number> {
    const col = this.getCollection(collection);
    const results = await col.get({
      where: { $and: [{ project }, { file_path: filePath }] },
    });
    if (results.ids.length > 0) {
      await col.delete({ ids: results.ids });
    }
    return results.ids.length;
  }

  async deleteByProject(collection: CollectionName, project: string): Promise<number> {
    const col = this.getCollection(collection);
    const results = await col.get({ where: { project } });
    if (results.ids.length > 0) {
      await col.delete({ ids: results.ids });
    }
    return results.ids.length;
  }

  async query(options: VectorStoreQueryOptions): Promise<VectorStoreQueryResult[]> {
    const col = this.getCollection(options.collection);
    const topK = options.topK ?? 10;
    const where = this.buildChromaFilter(options.filter);

    const results = await col.query({
      queryEmbeddings: [options.embedding],
      nResults: topK,
      ...(where ? { where } : {}),
    });

    const output: VectorStoreQueryResult[] = [];
    if (results.ids[0]) {
      for (let i = 0; i < results.ids[0].length; i++) {
        const score = results.distances?.[0]?.[i] != null
          ? 1 - results.distances[0][i]  // ChromaDB returns distance, convert to similarity
          : 0;

        if (options.minScore && score < options.minScore) continue;

        output.push({
          chunk: {
            content: results.documents?.[0]?.[i] ?? '',
            metadata: this.metadataToChunk(results.metadatas?.[0]?.[i] ?? {}, results.ids[0][i]),
          },
          score,
        });
      }
    }

    return output;
  }

  async count(collection: CollectionName, filter?: SearchFilter): Promise<number> {
    const col = this.getCollection(collection);
    const where = this.buildChromaFilter(filter);
    const result = await col.count(where ? { where } : undefined);
    return result;
  }

  async listProjects(): Promise<string[]> {
    const projects = new Set<string>();
    for (const col of this.collections.values()) {
      const result = await col.get({ include: ['metadatas'] });
      for (const meta of result.metadatas ?? []) {
        if (meta?.project) projects.add(meta.project as string);
      }
    }
    return [...projects];
  }

  async close(): Promise<void> {
    // ChromaDB client doesn't require explicit close
  }

  private getCollection(name: CollectionName): any {
    const col = this.collections.get(name);
    if (!col) throw new Error(`Collection '${name}' not initialized`);
    return col;
  }

  private chunkToMetadata(chunk: Chunk): Record<string, any> {
    const m = chunk.metadata;
    const meta: Record<string, any> = {
      source: m.source,
      project: m.project,
      branch: m.branch,
      type: m.type,
      chunk_kind: m.chunkKind,
      file_path: m.filePath,
      content_hash: m.contentHash,
      indexed_at: m.indexedAt,
    };
    if (m.language) meta.language = m.language;
    if (m.lineStart != null) meta.line_start = m.lineStart;
    if (m.lineEnd != null) meta.line_end = m.lineEnd;
    if (m.symbolName) meta.symbol_name = m.symbolName;
    if (m.className) meta.class_name = m.className;
    if (m.packageName) meta.package_name = m.packageName;
    if (m.httpMethod) meta.http_method = m.httpMethod;
    if (m.apiPath) meta.api_path = m.apiPath;
    if (m.tags) meta.tags = JSON.stringify(m.tags);
    if (m.pageTitle) meta.page_title = m.pageTitle;
    if (m.sectionHeading) meta.section_heading = m.sectionHeading;
    if (m.commitSha) meta.commit_sha = m.commitSha;
    return meta;
  }

  private metadataToChunk(meta: Record<string, any>, id: string): any {
    return {
      id,
      source: meta.source,
      project: meta.project,
      branch: meta.branch,
      type: meta.type,
      chunkKind: meta.chunk_kind,
      language: meta.language,
      filePath: meta.file_path,
      lineStart: meta.line_start,
      lineEnd: meta.line_end,
      symbolName: meta.symbol_name,
      className: meta.class_name,
      packageName: meta.package_name,
      httpMethod: meta.http_method,
      apiPath: meta.api_path,
      tags: meta.tags ? JSON.parse(meta.tags) : undefined,
      pageTitle: meta.page_title,
      sectionHeading: meta.section_heading,
      contentHash: meta.content_hash,
      commitSha: meta.commit_sha,
      indexedAt: meta.indexed_at,
    };
  }

  private buildChromaFilter(filter?: SearchFilter): Record<string, any> | undefined {
    if (!filter) return undefined;
    const conditions: Record<string, any>[] = [];

    if (filter.source) {
      conditions.push(Array.isArray(filter.source)
        ? { source: { $in: filter.source } }
        : { source: filter.source });
    }
    if (filter.project) {
      conditions.push(Array.isArray(filter.project)
        ? { project: { $in: filter.project } }
        : { project: filter.project });
    }
    if (filter.branch) conditions.push({ branch: filter.branch });
    if (filter.language) {
      conditions.push(Array.isArray(filter.language)
        ? { language: { $in: filter.language } }
        : { language: filter.language });
    }
    if (filter.httpMethod) conditions.push({ http_method: filter.httpMethod });

    if (conditions.length === 0) return undefined;
    if (conditions.length === 1) return conditions[0];
    return { $and: conditions };
  }
}
