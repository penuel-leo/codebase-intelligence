/**
 * Main indexing pipeline — routes files to parsers, generates embeddings, stores chunks.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { glob } from 'glob';
import type { Chunk, DependencyEdge, FileChange, ProviderType } from '../types/index.js';
import type { VectorStore } from '../store/vector-store.js';
import type { EmbeddingProvider } from './embedding.js';
import { analyzeDependencies, toEdges } from '../analysis/dependency-analyzer.js';
import { routeFile, shouldIndex } from './router.js';
import { parseCode } from './code-parser.js';
import { parseWiki } from './wiki-parser.js';
import { parseApiDoc } from './api-doc-parser.js';
import { parseConfig } from './config-parser.js';

export interface IndexerConfig {
  project: string;
  provider: ProviderType;
  branch: string;
  repoDir: string;
  commitSha?: string;
  /** Base web URL for the source (e.g., "https://gitlab.com/group/project"). Used to build webUrl for each chunk. */
  sourceUrl?: string;
  /**
   * First-sync resume: `resumeBase` = number of files skipped from the front of the full list.
   * `flush(absoluteExclusive)` is called with base+done (1-based count in full list).
   */
  indexCheckpoint?: {
    resumeBase: number;
    flushEvery: number;
    flush: (absoluteExclusive: number) => void;
  };
}

export interface IndexResult {
  chunksAdded: number;
  chunksDeleted: number;
  filesProcessed: number;
  filesSkipped: number;
  errors: Array<{ file: string; error: string }>;
}

export class Indexer {
  constructor(
    private store: VectorStore,
    private embedding: EmbeddingProvider,
    private onProgress?: (msg: string) => void,
  ) {}

  /**
   * Index changed files incrementally.
   */
  async indexChanges(changes: FileChange[], config: IndexerConfig): Promise<IndexResult> {
    const result: IndexResult = {
      chunksAdded: 0,
      chunksDeleted: 0,
      filesProcessed: 0,
      filesSkipped: 0,
      errors: [],
    };

    const total = changes.length;
    const progressEvery = total <= 25 ? 1 : Math.max(10, Math.floor(total / 25));

    this.onProgress?.(
      `[${config.provider}] index ${config.project}@${config.branch}: ` +
      `starting ${total} file(s) — parse → embed → vector upsert (FTS where applicable)`,
    );

    for (let i = 0; i < changes.length; i++) {
      const change = changes[i];
      const done = i + 1;

      try {
        if (!shouldIndex(change.path)) {
          result.filesSkipped++;
          if (this.onProgress && (done % progressEvery === 0 || done === total)) {
            this.reportFileProgress(config, done, total, result);
          }
          continue;
        }

        const routing = routeFile(change.path);
        if (routing.parser === 'skip') {
          result.filesSkipped++;
          if (this.onProgress && (done % progressEvery === 0 || done === total)) {
            this.reportFileProgress(config, done, total, result);
          }
          continue;
        }

        try {
          if (change.action === 'deleted') {
            const deleted = await this.store.deleteByFile(
              routing.collection, config.project, change.path
            );
            result.chunksDeleted += deleted;
            result.filesProcessed++;
            if (this.onProgress && (done % progressEvery === 0 || done === total)) {
              this.reportFileProgress(config, done, total, result);
            }
            continue;
          }

          // Renamed: delete chunks under the OLD path, then index the new path below
          if (change.action === 'renamed' && change.oldPath) {
            const oldRouting = routeFile(change.oldPath);
            if (oldRouting.parser !== 'skip') {
              const deleted = await this.store.deleteByFile(
                oldRouting.collection, config.project, change.oldPath
              );
              result.chunksDeleted += deleted;
            }
          }

          // Read file content
          const filePath = join(config.repoDir, change.path);
          let content: string;
          try {
            content = readFileSync(filePath, 'utf-8');
          } catch {
            result.errors.push({ file: change.path, error: 'Failed to read file' });
            if (this.onProgress && (done % progressEvery === 0 || done === total)) {
              this.reportFileProgress(config, done, total, result);
            }
            continue;
          }

          // Delete old chunks for this file (current path) first
          await this.store.deleteByFile(routing.collection, config.project, change.path);

          // Parse into chunks
          const chunks = this.parseFile(content, change.path, routing, config);

          // Attach webUrl to each chunk
          if (config.sourceUrl) {
            const webUrl = buildWebUrl(config.sourceUrl, config.provider, config.branch, change.path);
            for (const chunk of chunks) {
              chunk.metadata.webUrl = webUrl;
            }
          }

          if (chunks.length > 0) {
            const disp = change.path.length > 72 ? `…${change.path.slice(-69)}` : change.path;
            this.onProgress?.(
              `[${config.provider}] index ${config.project}@${config.branch}: ` +
              `[${done}/${total}] ${disp} — ${chunks.length} chunk(s) → embedding…`,
            );
            await this.embedChunks(chunks, config);

            await this.store.upsert(routing.collection, chunks);
            result.chunksAdded += chunks.length;
          }

          result.filesProcessed++;
        } catch (err: any) {
          result.errors.push({ file: change.path, error: err.message });
        }

        if (this.onProgress && (done % progressEvery === 0 || done === total)) {
          this.reportFileProgress(config, done, total, result);
        }
      } finally {
        const ck = config.indexCheckpoint;
        if (ck) {
          const fe = Math.max(1, ck.flushEvery);
          if (done % fe === 0 || done === total) {
            ck.flush(ck.resumeBase + done);
          }
        }
      }
    }

    if (total > 0) {
      await this.refreshProjectDependencyEdges(config);
    }

    return result;
  }

  /**
   * Full index of a project directory.
   */
  async indexFullProject(config: IndexerConfig, files: string[]): Promise<IndexResult> {
    const changes: FileChange[] = files.map(path => ({
      path,
      action: 'added' as const,
    }));
    return this.indexChanges(changes, config);
  }

  private parseFile(
    content: string,
    filePath: string,
    routing: ReturnType<typeof routeFile>,
    config: IndexerConfig,
  ): Chunk[] {
    const baseCtx = {
      project: config.project,
      provider: config.provider,
      branch: config.branch,
      filePath,
      commitSha: config.commitSha,
    };

    switch (routing.parser) {
      case 'code':
        return parseCode(content, { ...baseCtx, language: routing.language ?? 'text' });
      case 'wiki':
        return parseWiki(content, baseCtx);
      case 'api-doc':
        return parseApiDoc(content, baseCtx);
      case 'config':
        return parseConfig(content, baseCtx);
      case 'migration':
        // Treat migrations as code chunks with sql language
        return parseCode(content, { ...baseCtx, language: 'sql' });
      case 'proto':
        return parseCode(content, { ...baseCtx, language: routing.language ?? 'proto' });
      default:
        return [];
    }
  }

  private reportFileProgress(
    config: IndexerConfig,
    done: number,
    total: number,
    result: IndexResult,
  ): void {
    const pct = total ? ((done / total) * 100).toFixed(1) : '100';
    this.onProgress?.(
      `[${config.provider}] index ${config.project}@${config.branch}: ` +
      `queue ${done}/${total} (${pct}%) | +${result.chunksAdded} chunks | ` +
      `${result.filesProcessed} done | ${result.filesSkipped} skip | ${result.errors.length} err`,
    );
  }

  private buildWebUrlForChunk(config: IndexerConfig, filePath: string): string | undefined {
    if (!config.sourceUrl) return undefined;
    return buildWebUrl(config.sourceUrl, config.provider, config.branch, filePath);
  }

  /**
   * Rebuild outgoing dependency edges for this project from a full code scan (SQLite store only).
   */
  private async refreshProjectDependencyEdges(config: IndexerConfig): Promise<void> {
    const store = this.store as VectorStore & {
      clearOutgoingDependencies?: (project: string) => void;
      upsertDependencies?: (edges: DependencyEdge[]) => void;
    };
    if (!store.clearOutgoingDependencies || !store.upsertDependencies) {
      return;
    }

    const files = await glob('**/*', {
      cwd: config.repoDir,
      nodir: true,
      dot: false,
      ignore: [
        '**/node_modules/**',
        '**/.git/**',
        '**/dist/**',
        '**/build/**',
        '**/target/**',
        '**/.next/**',
        '**/.nuxt/**',
        '**/vendor/**',
      ],
    });

    const edges: DependencyEdge[] = [];
    for (const rel of files) {
      if (!shouldIndex(rel)) continue;
      const routing = routeFile(rel);
      if (routing.parser !== 'code' && routing.parser !== 'migration' && routing.parser !== 'proto') {
        continue;
      }
      const lang = routing.language ?? 'text';
      let content: string;
      try {
        content = readFileSync(join(config.repoDir, rel), 'utf-8');
      } catch {
        continue;
      }
      const analysis = analyzeDependencies(content, lang);
      edges.push(...toEdges(config.project, analysis));
    }

    store.clearOutgoingDependencies(config.project);

    const seen = new Map<string, DependencyEdge>();
    for (const e of edges) {
      if (!e.to?.trim() || e.to === e.from) continue;
      const key = `${e.from}\0${e.to}\0${e.type}`;
      if (!seen.has(key)) seen.set(key, e);
    }
    store.upsertDependencies([...seen.values()]);

    this.onProgress?.(
      `[${config.provider}] index ${config.project}@${config.branch}: ` +
      `dependency graph — ${seen.size} outgoing edge(s)`,
    );
  }

  private async embedChunks(chunks: Chunk[], config: IndexerConfig): Promise<void> {
    const batchSize = 32;
    const totalBatches = Math.ceil(chunks.length / batchSize);
    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);
      const texts = batch.map(c => c.content.slice(0, 8000)); // Truncate long content
      const batchIdx = Math.floor(i / batchSize) + 1;

      if (totalBatches > 3 && (batchIdx === 1 || batchIdx % 5 === 0 || batchIdx === totalBatches)) {
        this.onProgress?.(
          `[${config.provider}] index ${config.project}@${config.branch}: ` +
          `embedding HTTP ${batchIdx}/${totalBatches} batches | ${batch.length} vectors (file has ${chunks.length} chunks)`,
        );
      }

      try {
        const results = await this.embedding.embedBatch(texts);
        for (let j = 0; j < batch.length; j++) {
          batch[j].embedding = results[j].vector;
        }
      } catch (err: any) {
        // If batch embed fails, try one by one
        for (const chunk of batch) {
          try {
            const result = await this.embedding.embed(chunk.content.slice(0, 8000));
            chunk.embedding = result.vector;
          } catch {
            // Skip embedding for this chunk — it will still be stored but not searchable by vector
          }
        }
      }
    }
  }
}

/**
 * Build a web-browsable URL for a file in a Git hosting platform.
 * GitLab:  {baseUrl}/-/blob/{branch}/{filePath}
 * GitHub:  {baseUrl}/blob/{branch}/{filePath}
 * Local:   undefined (no web URL)
 */
function buildWebUrl(
  sourceUrl: string,
  provider: ProviderType,
  branch: string,
  filePath: string,
): string {
  const base = sourceUrl.replace(/\/$/, '');
  switch (provider) {
    case 'gitlab':
      return `${base}/-/blob/${branch}/${filePath}`;
    case 'github':
      return `${base}/blob/${branch}/${filePath}`;
    default:
      return `${base}/${filePath}`;
  }
}
