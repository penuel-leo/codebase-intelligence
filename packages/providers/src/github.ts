/**
 * GitHub Provider — clone locally, then pull + diff.
 * Same strategy as GitLab: Git protocol for daily ops, API only for discovery.
 * Multi-branch: clone with --no-single-branch, fetch/checkout per branch.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { simpleGit, type SimpleGit } from 'simple-git';
import type {
  ProviderType,
  ProjectMeta,
  FileChange,
  DocsPage,
} from '@codebase-intelligence/core';
import type { SourceProvider, ProviderConfig, ProviderProjectConfig } from './interface.js';
import { parseNameStatus, safeCheckout, safePull, safeClone } from './git-utils.js';

interface GitHubProject {
  repo: string;  // "org/name"
  name: string;
  url: string;
  branches: string[];
  defaultBranch: string;
  includeDocs: boolean;
  localPath: string;
  git?: SimpleGit;
}

export class GitHubProvider implements SourceProvider {
  readonly type: ProviderType = 'github';
  readonly name: string;

  private token: string = '';
  private workspace: string = '';
  private projects: Map<string, GitHubProject> = new Map();

  constructor(name?: string) {
    this.name = name ?? 'GitHub';
  }

  async init(config: ProviderConfig): Promise<void> {
    this.token = config.token ?? '';
    this.workspace = config.workspace;

    if (!existsSync(this.workspace)) {
      mkdirSync(this.workspace, { recursive: true });
    }

    for (const projConfig of config.projects) {
      if (projConfig.org) {
        const orgProjects = await this.discoverOrgRepos(projConfig.org, config);
        for (const p of orgProjects) this.projects.set(p.name, p);
      } else {
        const project = this.buildProject(projConfig, config);
        if (project) this.projects.set(project.name, project);
      }
    }
  }

  async dispose(): Promise<void> {}

  async listProjects(): Promise<ProjectMeta[]> {
    return [...this.projects.values()].map(p => ({
      id: `github:${p.name}`,
      name: p.name,
      provider: 'github' as const,
      url: p.url,
      branches: p.branches,
      defaultBranch: p.defaultBranch,
    }));
  }

  async getChangedFiles(project: string, sinceCommit: string): Promise<FileChange[]> {
    const proj = this.getProject(project);
    if (!proj.git) throw new Error(`Project ${project} not cloned`);
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

  async pull(project: string, branch?: string): Promise<{ headCommit: string; hasChanges: boolean }> {
    const proj = this.getProject(project);
    if (!proj.git) throw new Error(`Project ${project} not cloned`);

    const targetBranch = branch ?? proj.defaultBranch;
    const beforeCommit = await this.getHeadCommit(project);

    await proj.git.fetch(['origin']);
    await safeCheckout(proj.git, targetBranch);
    await safePull(proj.git, targetBranch);

    const afterCommit = await this.getHeadCommit(project);
    return { headCommit: afterCommit, hasChanges: beforeCommit !== afterCommit };
  }

  async clone(project: string): Promise<void> {
    const proj = this.getProject(project);
    const cloneUrl = this.buildCloneUrl(proj);
    await safeClone(simpleGit(), cloneUrl, proj.localPath, [
      '--depth=1',
      '--no-single-branch',
    ]);
    if (!existsSync(join(proj.localPath, '.git'))) {
      throw new Error(`GitHub clone failed: no .git at ${proj.localPath}`);
    }
    const git = simpleGit(proj.localPath);
    proj.git = git;

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

  async getDocsPages(project: string): Promise<DocsPage[]> {
    const proj = this.getProject(project);
    if (!proj.includeDocs) return [];

    const docsPath = join(this.workspace, `${proj.name}.wiki`);
    if (!existsSync(docsPath)) {
      try {
        await simpleGit().clone(`https://github.com/${proj.repo}.wiki.git`, docsPath, ['--depth=1']);
      } catch { return []; }
    } else {
      try { await simpleGit(docsPath).pull(); } catch { /* ignore */ }
    }

    const pages: DocsPage[] = [];
    try {
      const files = readdirSync(docsPath).filter(f => f.endsWith('.md'));
      for (const file of files) {
        const content = readFileSync(join(docsPath, file), 'utf-8');
        pages.push({
          title: file.replace('.md', ''),
          slug: file.replace('.md', '').toLowerCase().replace(/\s+/g, '-'),
          content, format: 'markdown',
        });
      }
    } catch { /* ignore */ }
    return pages;
  }

  private getProject(name: string): GitHubProject {
    const proj = this.projects.get(name);
    if (!proj) throw new Error(`GitHub project not found: ${name}`);
    if (!proj.git && existsSync(join(proj.localPath, '.git'))) {
      proj.git = simpleGit(proj.localPath);
    }
    return proj;
  }

  private buildProject(config: ProviderProjectConfig, parent: ProviderConfig): GitHubProject | null {
    const repo = config.repo ?? '';
    if (!repo) return null;
    const name = config.name || repo.split('/').pop() || repo;
    const branches = config.branches ?? parent.branches ?? ['main'];
    return {
      repo, name, url: `https://github.com/${repo}`,
      branches, defaultBranch: branches[0] ?? 'main',
      includeDocs: config.includeDocs ?? parent.includeDocs ?? false,
      localPath: join(this.workspace, name),
    };
  }

  private buildCloneUrl(proj: GitHubProject): string {
    if (this.token) return `https://x-access-token:${this.token}@github.com/${proj.repo}.git`;
    return `https://github.com/${proj.repo}.git`;
  }

  private async discoverOrgRepos(org: string, config: ProviderConfig): Promise<GitHubProject[]> {
    if (!this.token) { console.warn(`Cannot discover GitHub org repos without a token. Org: ${org}`); return []; }
    try {
      const resp = await fetch(`https://api.github.com/orgs/${org}/repos?per_page=100&sort=updated`, {
        headers: { 'Authorization': `Bearer ${this.token}`, 'Accept': 'application/vnd.github+json' },
      });
      if (!resp.ok) { console.warn(`Failed to list GitHub org ${org}: ${resp.status}`); return []; }

      const data = await resp.json() as any[];
      const branches = config.branches ?? ['main'];
      return data.map(r => ({
        repo: r.full_name, name: r.name, url: r.html_url,
        branches, defaultBranch: r.default_branch ?? branches[0] ?? 'main',
        includeDocs: config.includeDocs ?? false,
        localPath: join(this.workspace, r.name),
      }));
    } catch (err: any) {
      console.warn(`Failed to discover GitHub org ${org}: ${err.message}`);
      return [];
    }
  }
}
