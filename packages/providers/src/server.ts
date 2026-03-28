/**
 * HTTP Server — webhook receiver + status API.
 *
 * Endpoints:
 *   POST /webhook/gitlab   ← GitLab push event
 *   POST /webhook/github   ← GitHub push event
 *   GET  /api/status       ← Overall sync status + per-project progress
 *   GET  /api/projects     ← Indexed project list
 *
 * Uses Node.js built-in http module — zero dependencies.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { SyncEngine, SyncResult } from './sync-engine.js';
import type { SourceProvider } from './interface.js';

export interface ServerConfig {
  port: number;
  host?: string;
}

export interface ProjectProgress {
  project: string;
  branch: string;
  provider: string;
  status: 'pending' | 'syncing' | 'done' | 'error' | 'skipped';
  progress?: string;        // e.g. "142/380 files"
  chunksAdded?: number;
  chunksDeleted?: number;
  errors?: number;
  duration?: number;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
}

export class CIServer {
  private engine: SyncEngine;
  private server: ReturnType<typeof createServer> | null = null;

  // ─── Live progress tracking ───
  private projectProgress: Map<string, ProjectProgress> = new Map();
  private isRunning = false;
  private lastSyncResults: SyncResult[] = [];

  /** Tracks which project@branch pairs are currently syncing (prevents concurrent webhook syncs). */
  private syncingProjects = new Set<string>();

  constructor(engine: SyncEngine) {
    this.engine = engine;
  }

  /** Start the HTTP server */
  async start(config: ServerConfig): Promise<void> {
    this.server = createServer((req, res) => this.handleRequest(req, res));

    return new Promise((resolve) => {
      this.server!.listen(config.port, config.host ?? '0.0.0.0', () => {
        console.log(`[server] Listening on ${config.host ?? '0.0.0.0'}:${config.port}`);
        console.log(`[server] Webhook:  POST http://localhost:${config.port}/webhook/gitlab`);
        console.log(`[server] Status:   GET  http://localhost:${config.port}/api/status`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (this.server) {
      return new Promise((resolve) => {
        this.server!.close(() => resolve());
      });
    }
  }

  /** Update progress for a project (called from sync engine) */
  updateProgress(key: string, update: Partial<ProjectProgress>): void {
    const existing = this.projectProgress.get(key) ?? {
      project: '', branch: '', provider: '', status: 'pending' as const,
    };
    this.projectProgress.set(key, { ...existing, ...update });
  }

  getProgressMap(): Map<string, ProjectProgress> { return this.projectProgress; }
  setRunning(v: boolean): void { this.isRunning = v; }
  setLastResults(r: SyncResult[]): void { this.lastSyncResults = r; }

  // ─── Request handler ───────────────────────────────

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? '/';
    const method = req.method ?? 'GET';

    try {
      // ─── Webhook: GitLab ───
      if (method === 'POST' && url === '/webhook/gitlab') {
        const body = await readBody(req);
        await this.handleGitLabWebhook(body, res);
        return;
      }

      // ─── Webhook: GitHub ───
      if (method === 'POST' && url === '/webhook/github') {
        const body = await readBody(req);
        await this.handleGitHubWebhook(body, res);
        return;
      }

      // ─── Status API ───
      if (method === 'GET' && url === '/api/status') {
        const status = {
          running: this.isRunning,
          projects: [...this.projectProgress.values()],
          lastSync: this.lastSyncResults.length > 0
            ? {
              totalProjects: this.lastSyncResults.length,
              success: this.lastSyncResults.filter(r => r.status === 'success').length,
              skipped: this.lastSyncResults.filter(r => r.status === 'skipped').length,
              errors: this.lastSyncResults.filter(r => r.status === 'error').length,
            }
            : null,
        };
        json(res, 200, status);
        return;
      }

      // ─── Projects API ───
      if (method === 'GET' && url === '/api/projects') {
        const projects = await this.engine.getStore().listProjects();
        json(res, 200, { projects });
        return;
      }

      // ─── 404 ───
      json(res, 404, { error: 'Not found', endpoints: [
        'POST /webhook/gitlab',
        'POST /webhook/github',
        'GET /api/status',
        'GET /api/projects',
      ]});
    } catch (err: any) {
      json(res, 500, { error: err.message });
    }
  }

  // ─── Webhook handlers ──────────────────────────────

  private async handleGitLabWebhook(body: string, res: ServerResponse): Promise<void> {
    let payload: any;
    try { payload = JSON.parse(body); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }

    // GitLab push event: https://docs.gitlab.com/ee/user/project/integrations/webhook_events.html#push-events
    const eventType = payload.object_kind ?? payload.event_name;
    if (eventType !== 'push') {
      json(res, 200, { message: `Ignoring event: ${eventType}` });
      return;
    }

    const pathWithNamespace = payload.project?.path_with_namespace as string | undefined;
    const branch = (payload.ref ?? '').replace('refs/heads/', '');

    if (!pathWithNamespace || !branch) {
      json(res, 400, { error: 'Missing project.path_with_namespace or branch in webhook payload' });
      return;
    }

    console.log(`[webhook] GitLab push: ${pathWithNamespace}@${branch}`);
    json(res, 202, { message: `Queued sync: ${pathWithNamespace}@${branch}` });

    this.triggerGitLabSync(pathWithNamespace, branch).catch(err => {
      console.error(`[webhook] Sync failed for ${pathWithNamespace}@${branch}: ${err.message}`);
    });
  }

  private async handleGitHubWebhook(body: string, res: ServerResponse): Promise<void> {
    let payload: any;
    try { payload = JSON.parse(body); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }

    // GitHub push event: https://docs.github.com/en/webhooks/webhook-events-and-payloads#push
    const ref = payload.ref ?? '';
    if (!ref.startsWith('refs/heads/')) {
      json(res, 200, { message: 'Ignoring non-branch push' });
      return;
    }

    const fullName = payload.repository?.full_name as string | undefined;
    const shortName = payload.repository?.name as string | undefined;
    const branch = ref.replace('refs/heads/', '');

    if (!branch || (!fullName && !shortName)) {
      json(res, 400, { error: 'Missing repository.full_name (or name) or branch in webhook payload' });
      return;
    }

    console.log(`[webhook] GitHub push: ${fullName ?? shortName}@${branch}`);
    json(res, 202, { message: `Queued sync: ${fullName ?? shortName}@${branch}` });

    this.triggerGitHubSync(fullName, shortName, branch).catch(err => {
      console.error(`[webhook] Sync failed: ${err.message}`);
    });
  }

  /**
   * Run syncProjectBranch with per-project lock and isRunning state tracking.
   * If the same project@branch is already syncing, the request is skipped.
   */
  private async runSyncWithLock(
    provider: SourceProvider,
    project: string,
    branch: string,
  ): Promise<void> {
    const key = `${project}@${branch}`;
    if (this.syncingProjects.has(key)) {
      console.log(`[webhook] ${key} is already syncing, skipping duplicate request.`);
      return;
    }
    this.syncingProjects.add(key);
    this.isRunning = true;
    try {
      const result = await this.engine.syncProjectBranch(provider, project, branch);
      this.lastSyncResults = this.lastSyncResults
        .filter(r => !(r.project === project && r.branch === branch));
      this.lastSyncResults.push(result);
    } finally {
      this.syncingProjects.delete(key);
      this.isRunning = this.syncingProjects.size > 0;
    }
  }

  private async triggerGitLabSync(pathWithNamespace: string, branch: string): Promise<void> {
    for (const provider of this.engine.getProviders()) {
      if (provider.type !== 'gitlab') continue;
      const projects = await provider.listProjects();
      const match = projects.find(p => p.name === pathWithNamespace);
      if (match) {
        await this.runSyncWithLock(provider, match.name, branch);
        return;
      }
    }
    console.warn(`[webhook] No GitLab source matches path_with_namespace: ${pathWithNamespace}`);
  }

  private async triggerGitHubSync(
    fullName: string | undefined,
    shortName: string | undefined,
    branch: string,
  ): Promise<void> {
    for (const provider of this.engine.getProviders()) {
      if (provider.type !== 'github') continue;
      const projects = await provider.listProjects();
      const match = projects.find(p => {
        if (fullName && (p.name === fullName || p.url?.endsWith(`/${fullName}`) || p.url?.includes(`/${fullName}.git`))) {
          return true;
        }
        if (shortName && p.name === shortName) return true;
        return false;
      });
      if (match) {
        await this.runSyncWithLock(provider, match.name, branch);
        return;
      }
    }
    console.warn(
      `[webhook] No GitHub source matches repository (full_name=${fullName ?? 'n/a'}, name=${shortName ?? 'n/a'})`,
    );
  }
}

// ─── Helpers ─────────────────────────────────────────

function json(res: ServerResponse, status: number, data: any): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data, null, 2));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}
