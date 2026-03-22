/**
 * GitLab Provider — clone locally, then pull + diff.
 * Zero REST API calls in normal operation (uses Git protocol).
 * API calls only for project discovery and webhook registration.
 *
 * Multi-branch: clone with full refs, fetch/checkout per branch on pull.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { simpleGit, type SimpleGit } from 'simple-git';
import type {
  ProviderType,
  ProjectMeta,
  FileChange,
  WikiPage,
} from '@codebase-intelligence/core';
import type { SourceProvider, ProviderConfig, ProviderProjectConfig } from './interface.js';
import { parseNameStatus, safeCheckout, safePull, safeClone } from './git-utils.js';

interface GitLabProject {
  id: number | string;
  name: string;
  url: string;
  branches: string[];
  defaultBranch: string;
  includeWiki: boolean;
  localPath: string;
  git?: SimpleGit;
}

export class GitLabProvider implements SourceProvider {
  readonly type: ProviderType = 'gitlab';
  readonly name: string;

  private baseUrl: string = '';
  private token: string = '';
  private workspace: string = '';
  private projects: Map<string, GitLabProject> = new Map();

  constructor(name?: string) {
    this.name = name ?? 'GitLab';
  }

  async init(config: ProviderConfig): Promise<void> {
    this.baseUrl = (config.url ?? 'https://gitlab.com').replace(/\/$/, '');
    this.token = config.token ?? '';
    this.workspace = config.workspace;

    if (!existsSync(this.workspace)) {
      mkdirSync(this.workspace, { recursive: true });
    }

    for (const projConfig of config.projects) {
      if (projConfig.group) {
        const groupProjects = await this.discoverGroupProjects(projConfig.group, config);
        for (const p of groupProjects) this.projects.set(p.name, p);
      } else {
        const project = this.buildProject(projConfig, config);
        if (project) this.projects.set(project.name, project);
      }
    }
  }

  async dispose(): Promise<void> {}

  async listProjects(): Promise<ProjectMeta[]> {
    return [...this.projects.values()].map(p => ({
      id: `gitlab:${p.name}`,
      name: p.name,
      provider: 'gitlab' as const,
      url: p.url,
      branches: p.branches,
      defaultBranch: p.defaultBranch,
    }));
  }

  async getChangedFiles(project: string, sinceCommit: string): Promise<FileChange[]> {
    const proj = this.getProject(project);
    if (!proj.git) throw new Error(`Project ${project} not cloned`);

    // Use --name-status to get accurate A/M/D/R status
    const raw = await proj.git.raw(['diff', '--name-status', sinceCommit, 'HEAD']);
    return parseNameStatus(raw);
  }

  async getHeadCommit(project: string): Promise<string> {
    const proj = this.getProject(project);
    if (!proj.git) return '';
    const log = await proj.git.log({ maxCount: 1 });
    return log.latest?.hash ?? '';
  }

  async getFileContent(project: string, filePath: string): Promise<string> {
    const proj = this.getProject(project);
    return readFileSync(join(proj.localPath, filePath), 'utf-8');
  }

  async getFileTree(project: string): Promise<string[]> {
    const proj = this.getProject(project);
    if (!proj.git) return [];
    const result = await proj.git.raw(['ls-files']);
    return result.trim().split('\n').filter(Boolean);
  }

  /**
   * Pull a specific branch. Fetch + checkout + pull.
   */
  async pull(project: string, branch?: string): Promise<{ headCommit: string; hasChanges: boolean }> {
    const proj = this.getProject(project);
    if (!proj.git) throw new Error(`Project ${project} not cloned`);

    const targetBranch = branch ?? proj.defaultBranch;
    const beforeCommit = await this.getHeadCommit(project);

    // Fetch all remote refs (lightweight, only downloads new objects)
    await proj.git.fetch(['origin']);
    await safeCheckout(proj.git, targetBranch);
    await safePull(proj.git, targetBranch);

    const afterCommit = await this.getHeadCommit(project);
    return { headCommit: afterCommit, hasChanges: beforeCommit !== afterCommit };
  }

  /**
   * Clone with --no-single-branch so we can later checkout any branch.
   * Uses --depth=1 for shallow clone (saves disk).
   */
  async clone(project: string): Promise<void> {
    const proj = this.getProject(project);
    const cloneUrl = this.buildCloneUrl(proj);
    await safeClone(simpleGit(), cloneUrl, proj.localPath, [
      '--depth=1',
      '--no-single-branch',
    ]);
    if (!existsSync(join(proj.localPath, '.git'))) {
      throw new Error(`GitLab clone failed: no .git at ${proj.localPath}`);
    }
    const git = simpleGit(proj.localPath);
    proj.git = git;

    // Auto-detect default branch from remote HEAD
    try {
      const remote = await git.remote(['show', 'origin']);
      const match = (remote ?? '').match(/HEAD branch:\s*(\S+)/);
      if (match) proj.defaultBranch = match[1];
    } catch { /* use configured default */ }
  }

  isCloned(project: string): boolean {
    const proj = this.projects.get(project);
    return !!proj && existsSync(join(proj.localPath, '.git'));
  }

  getLocalPath(project: string): string {
    return this.getProject(project).localPath;
  }

  async getWikiPages(project: string): Promise<WikiPage[]> {
    const proj = this.getProject(project);
    if (!proj.includeWiki) return [];

    const wikiPath = join(this.workspace, `${proj.name}.wiki`);
    if (!existsSync(wikiPath)) {
      const wikiUrl = `${this.buildCloneUrl(proj).replace('.git', '.wiki.git')}`;
      try {
        await simpleGit().clone(wikiUrl, wikiPath, ['--depth=1']);
      } catch { return []; }
    } else {
      try { await simpleGit(wikiPath).pull(); } catch { /* ignore */ }
    }

    const pages: WikiPage[] = [];
    try {
      const files = readdirSync(wikiPath).filter(f => f.endsWith('.md'));
      for (const file of files) {
        const content = readFileSync(join(wikiPath, file), 'utf-8');
        pages.push({
          title: file.replace('.md', ''),
          slug: file.replace('.md', '').toLowerCase().replace(/\s+/g, '-'),
          content,
          format: 'markdown',
        });
      }
    } catch { /* ignore */ }
    return pages;
  }

  // ─── Private ────────────────────────────────────────

  private getProject(name: string): GitLabProject {
    const proj = this.projects.get(name);
    if (!proj) throw new Error(`GitLab project not found: ${name}`);
    if (!proj.git && existsSync(join(proj.localPath, '.git'))) {
      proj.git = simpleGit(proj.localPath);
    }
    return proj;
  }

  private buildProject(config: ProviderProjectConfig, parentConfig: ProviderConfig): GitLabProject | null {
    const name = config.name || String(config.id) || 'unknown';
    const branches = config.branches ?? parentConfig.branches ?? ['main'];
    return {
      id: config.id ?? name,
      name,
      url: `${this.baseUrl}/${name}`,
      branches,
      defaultBranch: branches[0] ?? 'main',
      includeWiki: config.includeWiki ?? parentConfig.includeWiki ?? false,
      localPath: join(this.workspace, name),
    };
  }

  private buildCloneUrl(proj: GitLabProject): string {
    if (this.token) {
      const url = new URL(proj.url);
      return `https://oauth2:${this.token}@${url.host}${url.pathname}.git`;
    }
    return `${proj.url}.git`;
  }

  private async discoverGroupProjects(group: string, config: ProviderConfig): Promise<GitLabProject[]> {
    if (!this.token) {
      console.warn(`Cannot discover GitLab group projects without a token. Group: ${group}`);
      return [];
    }

    try {
      const resp = await fetch(
        `${this.baseUrl}/api/v4/groups/${encodeURIComponent(group)}/projects?per_page=100&simple=true`,
        { headers: { 'PRIVATE-TOKEN': this.token } },
      );
      if (!resp.ok) { console.warn(`Failed to list GitLab group ${group}: ${resp.status}`); return []; }

      const data = await resp.json() as any[];
      const branches = config.branches ?? ['main'];
      return data.map(p => ({
        id: p.id,
        name: p.path,
        url: p.web_url,
        branches,
        defaultBranch: p.default_branch ?? branches[0] ?? 'main',
        includeWiki: config.includeWiki ?? false,
        localPath: join(this.workspace, p.path),
      }));
    } catch (err: any) {
      console.warn(`Failed to discover GitLab group ${group}: ${err.message}`);
      return [];
    }
  }
}
