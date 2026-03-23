/**
 * Sync Engine — orchestrates incremental sync across all providers.
 *
 * 方案C 混合增量模式（三层递进）:
 *   L1 (可选): Webhook — GitLab/GitHub push event → 由 CIServer (server.ts) 接收,
 *              调用 syncProjectBranch() 实现秒级增量。通过 `codebase-intelligence serve` 启动。
 *   L2 (默认): git pull + diff — 定时增量，零 API 调用
 *   L3 (自动降级): diff 失败时自动 fallback 全量 reindex
 */

import type {
  AppConfig,
  FileChange,
  ProviderType,
} from '@codebase-intelligence/core';
import {
  Indexer,
  createVectorStore,
  createEmbeddingProvider,
  getWorkspaceDir,
  getDbPath,
} from '@codebase-intelligence/core';
import type { IndexResult } from '@codebase-intelligence/core';
import type { VectorStore } from '@codebase-intelligence/core';
import type { EmbeddingProvider } from '@codebase-intelligence/core';
import type { SourceProvider } from './interface.js';
import { createAllProviders } from './provider-factory.js';

export interface SyncResult {
  project: string;
  branch: string;
  provider: ProviderType;
  status: 'success' | 'skipped' | 'error';
  /** 'incremental' = L2 diff, 'full' = L3 fallback */
  syncMode?: 'incremental' | 'full';
  indexResult?: IndexResult;
  error?: string;
  duration: number;
}

export interface SyncEngineOptions {
  config: AppConfig;
  store?: VectorStore;
  embedding?: EmbeddingProvider;
  onProgress?: (msg: string) => void;
}

export class SyncEngine {
  private config: AppConfig;
  private store!: VectorStore;
  private embedding!: EmbeddingProvider;
  private indexer!: Indexer;
  private providers: SourceProvider[] = [];
  private onProgress: (msg: string) => void;

  constructor(options: SyncEngineOptions) {
    this.config = options.config;
    if (options.store) this.store = options.store;
    if (options.embedding) this.embedding = options.embedding;
    this.onProgress = options.onProgress ?? console.log;
  }

  async init(): Promise<void> {
    if (!this.store) {
      this.store = await createVectorStore(
        this.config.storage.vector,
        {
          dimensions: this.config.embedding.dimensions,
          dbPath: getDbPath(this.config, 'vectors'),
        },
      );
    }

    if (!this.embedding) {
      this.embedding = createEmbeddingProvider(this.config.embedding);
    }

    this.indexer = new Indexer(this.store, this.embedding, (msg) => this.onProgress(msg));

    const workspace = getWorkspaceDir(this.config);
    this.providers = await createAllProviders(this.config.sources, workspace);
  }

  /**
   * Sync all configured projects × all configured branches.
   *
   * Multi-branch safety:
   *   - Same project's branches are processed SERIALLY (shared git worktree)
   *   - Different projects can run in PARALLEL (up to concurrency limit)
   *
   * This avoids concurrent `git checkout` on the same repo directory.
   */
  async syncAll(): Promise<SyncResult[]> {
    const results: SyncResult[] = [];
    const concurrency = this.config.sync.concurrency ?? 3;

    // Group tasks by project — branches within a project must be serial
    const projectTasks = new Map<string, Array<{ provider: SourceProvider; project: string; branch: string }>>();

    for (const provider of this.providers) {
      const projects = await provider.listProjects();
      for (const proj of projects) {
        const key = `${provider.type}:${proj.name}`;
        if (!projectTasks.has(key)) projectTasks.set(key, []);
        for (const branch of proj.branches) {
          projectTasks.get(key)!.push({ provider, project: proj.name, branch });
        }
      }
    }

    // Each "project task group" is a sequential chain.
    // We run project groups in parallel with concurrency limit.
    const projectGroups = [...projectTasks.values()];
    const groupFns = projectGroups.map(group => async () => {
      const groupResults: SyncResult[] = [];
      for (const task of group) {
        // Serial within same project (safe git checkout)
        const r = await this.syncProjectBranch(task.provider, task.project, task.branch);
        groupResults.push(r);
      }
      return groupResults;
    });

    // Run project groups in parallel with concurrency limit
    for (let i = 0; i < groupFns.length; i += concurrency) {
      const batch = groupFns.slice(i, i + concurrency);
      const batchResults = await Promise.all(batch.map(fn => fn()));
      for (const group of batchResults) results.push(...group);
    }

    return results;
  }

  /**
   * Sync a single project + branch.
   *
   * L2: git pull + diff → incremental index
   * L3: if diff fails → auto fallback to full reindex
   */
  async syncProjectBranch(
    provider: SourceProvider,
    project: string,
    branch: string,
  ): Promise<SyncResult> {
    const start = Date.now();
    // Sync state key includes branch to support multi-branch
    const stateKey = `${project}@${branch}`;

    try {
      this.onProgress(`[${provider.type}] Syncing ${project}@${branch}...`);

      // Step 1: Clone if needed
      if (!provider.isCloned(project)) {
        this.onProgress(`[${provider.type}] Cloning ${project}...`);
        await provider.clone(project);
      }

      // Step 2: Checkout & pull target branch
      const { headCommit, hasChanges } = await provider.pull(project, branch);

      // Step 3: Check sync state
      const syncState = (this.store as any).getSyncState?.(stateKey);
      const lastCommit = syncState?.last_commit_sha;

      if (!hasChanges && lastCommit === headCommit) {
        this.onProgress(`[${provider.type}] ${project}@${branch} — no changes`);
        return {
          project, branch, provider: provider.type,
          status: 'skipped', duration: Date.now() - start,
        };
      }

      // Step 4: L2 — Try incremental diff
      let changes: FileChange[];
      let syncMode: 'incremental' | 'full' = 'incremental';
      /** Offset into full first-sync file list (for resume). */
      let resumeBase = 0;

      if (lastCommit) {
        try {
          changes = await provider.getChangedFiles(project, lastCommit);
          this.onProgress(
            `[${provider.type}] ${project}@${branch} — L2 incremental: ${changes.length} changed file(s)`,
          );
        } catch (diffErr: any) {
          // L3 — Diff failed (force push, shallow clone lost history, etc.)
          // Auto fallback to full reindex
          this.onProgress(
            `[${provider.type}] ${project}@${branch} — L2 diff failed (${diffErr.message}), falling back to L3 full reindex`,
          );
          syncMode = 'full';
          (this.store as any).setSyncState?.(stateKey, {
            index_resume_offset: null,
            index_resume_head: null,
          });
          // Delete old chunks for this project+branch, then index all
          for (const col of ['code', 'api', 'docs', 'config'] as const) {
            await this.store.deleteByFile(col, project, `__branch__${branch}`);
          }
          const allFiles = await provider.getFileTree(project);
          changes = allFiles.map(f => ({ path: f, action: 'added' as const }));
        }
      } else {
        // First sync — full index (optional resume via sync_state)
        syncMode = 'full';
        const allFiles = await provider.getFileTree(project);
        const allChanges = allFiles.map(f => ({ path: f, action: 'added' as const }));
        this.onProgress(
          `[${provider.type}] ${project}@${branch} — first sync: ${allChanges.length} file(s)`,
        );

        const storeAny = this.store as any;
        const stale = storeAny.getSyncState?.(stateKey);
        if (stale?.index_resume_head && stale.index_resume_head !== headCommit) {
          storeAny.setSyncState?.(stateKey, {
            index_resume_offset: null,
            index_resume_head: null,
          });
        }

        const st = storeAny.getSyncState?.(stateKey);
        if (
          st?.index_resume_head === headCommit &&
          typeof st.index_resume_offset === 'number' &&
          st.index_resume_offset > 0
        ) {
          resumeBase = st.index_resume_offset;
          if (resumeBase >= allChanges.length) {
            this.onProgress(
              `[${provider.type}] ${project}@${branch} — resume checkpoint complete ` +
              `(${allChanges.length} file(s)), finalizing state`,
            );
            changes = [];
          } else {
            changes = allChanges.slice(resumeBase);
            this.onProgress(
              `[${provider.type}] ${project}@${branch} — resuming first sync from file ` +
              `${resumeBase + 1}/${allChanges.length} (HEAD ${headCommit.slice(0, 8)})`,
            );
          }
        } else {
          changes = allChanges;
        }
      }

      // Step 5: Index
      const indexCheckpoint =
        !lastCommit && syncMode === 'full' && changes.length > 0
          ? {
            resumeBase,
            flushEvery: 40,
            flush: (absoluteExclusive: number) => {
              (this.store as any).setSyncState?.(stateKey, {
                index_resume_offset: absoluteExclusive,
                index_resume_head: headCommit,
                provider: provider.type,
                status: 'indexing',
              });
            },
          }
          : undefined;

      const indexResult =
        changes.length === 0 && !lastCommit && syncMode === 'full'
          ? {
            chunksAdded: 0,
            chunksDeleted: 0,
            filesProcessed: 0,
            filesSkipped: 0,
            errors: [] as { file: string; error: string }[],
          }
          : await this.indexer.indexChanges(changes, {
            project,
            provider: provider.type,
            branch,
            repoDir: provider.getLocalPath(project),
            commitSha: headCommit,
            parserMode: this.config.parser?.mode,
            indexCheckpoint,
          });

      // Step 6: Update sync state
      if ((this.store as any).setSyncState) {
        (this.store as any).setSyncState(stateKey, {
          provider: provider.type,
          last_commit_sha: headCommit,
          last_sync_at: new Date().toISOString(),
          total_chunks: indexResult.chunksAdded,
          status: 'idle',
          index_resume_offset: null,
          index_resume_head: null,
        });
      }

      this.onProgress(
        `[${provider.type}] ${project}@${branch} — done (${syncMode}): ` +
        `+${indexResult.chunksAdded} -${indexResult.chunksDeleted} ` +
        `${indexResult.errors.length} errors`,
      );

      return {
        project, branch, provider: provider.type,
        status: 'success', syncMode, indexResult,
        duration: Date.now() - start,
      };
    } catch (err: any) {
      this.onProgress(`[${provider.type}] ${project}@${branch} — ERROR: ${err.message}`);
      return {
        project, branch, provider: provider.type,
        status: 'error', error: err.message,
        duration: Date.now() - start,
      };
    }
  }

  /**
   * Full reindex of a specific project (all branches).
   */
  async reindex(providerType: ProviderType, project: string): Promise<SyncResult[]> {
    const provider = this.providers.find(p => p.type === providerType);
    if (!provider) {
      return [{ project, branch: '*', provider: providerType, status: 'error', error: 'Provider not found', duration: 0 }];
    }

    const projects = await provider.listProjects();
    const meta = projects.find(p => p.name === project);
    if (!meta) {
      return [{ project, branch: '*', provider: providerType, status: 'error', error: 'Project not found', duration: 0 }];
    }

    // Delete all existing chunks for this project
    for (const col of ['code', 'api', 'docs', 'config'] as const) {
      await this.store.deleteByProject(col, project);
    }

    const storeAny = this.store as any;
    if (storeAny.clearOutgoingDependencies) {
      storeAny.clearOutgoingDependencies(project);
    }

    // Reset per-branch sync cursor so sync does not skip as "no git changes" while the index is empty
    for (const branch of meta.branches) {
      const stateKey = `${project}@${branch}`;
      storeAny.setSyncState?.(stateKey, {
        provider: providerType,
        last_commit_sha: null,
        index_resume_offset: null,
        index_resume_head: null,
        status: 'idle',
      });
    }

    // Reindex all branches
    const results: SyncResult[] = [];
    for (const branch of meta.branches) {
      const result = await this.syncProjectBranch(provider, project, branch);
      results.push(result);
    }

    return results;
  }

  getStore(): VectorStore { return this.store; }
  getEmbedding(): EmbeddingProvider { return this.embedding; }
  getProviders(): SourceProvider[] { return this.providers; }

  async close(): Promise<void> {
    for (const provider of this.providers) {
      await provider.dispose();
    }
    await this.store.close();
  }
}
