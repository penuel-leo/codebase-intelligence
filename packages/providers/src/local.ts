/**
 * Local Workspace Provider — reads from local filesystem + git.
 * No API calls, no auth, uses fs.watch / chokidar for real-time updates.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { simpleGit, type SimpleGit } from 'simple-git';
import type {
  ProviderType,
  ProjectMeta,
  FileChange,
  ChangeEvent,
  WikiPage,
} from '@codebase-intelligence/core';
import type { SourceProvider, ProviderConfig, ProviderProjectConfig } from './interface.js';
import { parseNameStatus } from './git-utils.js';

interface LocalProject {
  name: string;
  path: string;
  branches: string[];
  git: SimpleGit;
}

export class LocalProvider implements SourceProvider {
  readonly type: ProviderType = 'local';
  readonly name: string;

  private projects: Map<string, LocalProject> = new Map();
  private watcher: any; // chokidar instance
  private config!: ProviderConfig;

  constructor(name?: string) {
    this.name = name ?? 'Local Workspace';
  }

  async init(config: ProviderConfig): Promise<void> {
    this.config = config;

    for (const projConfig of config.projects) {
      const localPath = projConfig.path;
      if (!localPath) continue;

      const name = projConfig.name || localPath.split('/').pop() || 'unknown';

      if (!existsSync(localPath)) {
        console.warn(`Local project path not found: ${localPath}`);
        continue;
      }

      const git = simpleGit(localPath);
      const isGitRepo = existsSync(join(localPath, '.git'));

      this.projects.set(name, {
        name,
        path: localPath,
        branches: projConfig.branches ?? config.branches ?? ['main'],
        git: isGitRepo ? git : git,
      });
    }
  }

  async dispose(): Promise<void> {
    await this.stopWatching?.();
  }

  async listProjects(): Promise<ProjectMeta[]> {
    return [...this.projects.values()].map(p => ({
      id: `local:${p.name}`,
      name: p.name,
      provider: 'local' as const,
      url: p.path,
      branches: p.branches,
      defaultBranch: p.branches[0] ?? 'main',
    }));
  }

  async getChangedFiles(project: string, sinceCommit: string): Promise<FileChange[]> {
    const proj = this.getProject(project);
    try {
      const raw = await proj.git.raw(['diff', '--name-status', sinceCommit, 'HEAD']);
      return parseNameStatus(raw);
    } catch {
      return [];
    }
  }

  async getHeadCommit(project: string): Promise<string> {
    const proj = this.getProject(project);
    try {
      const log = await proj.git.log({ maxCount: 1 });
      return log.latest?.hash ?? '';
    } catch {
      return '';
    }
  }

  async getFileContent(project: string, filePath: string): Promise<string> {
    const proj = this.getProject(project);
    return readFileSync(join(proj.path, filePath), 'utf-8');
  }

  async getFileTree(project: string): Promise<string[]> {
    const proj = this.getProject(project);
    try {
      // Use git ls-files if available (faster, respects .gitignore)
      const result = await proj.git.raw(['ls-files']);
      return result.trim().split('\n').filter(Boolean);
    } catch {
      // Fallback to filesystem walk
      return walkDirectory(proj.path);
    }
  }

  async pull(project: string, branch?: string): Promise<{ headCommit: string; hasChanges: boolean }> {
    const proj = this.getProject(project);
    const beforeCommit = await this.getHeadCommit(project);
    try {
      if (branch) {
        // Checkout the target branch first
        try {
          await proj.git.checkout(branch);
        } catch {
          await proj.git.checkout(['-b', branch, `origin/${branch}`]);
        }
      }
      await proj.git.pull();
    } catch {
      // Not a git repo or no remote — local files are always "current"
    }
    const afterCommit = await this.getHeadCommit(project);
    return {
      headCommit: afterCommit || `local-${Date.now()}`,
      hasChanges: beforeCommit !== afterCommit,
    };
  }

  async clone(_project: string): Promise<void> {
    // Local projects don't need cloning
  }

  isCloned(_project: string): boolean {
    return true; // Local projects are always "cloned"
  }

  getLocalPath(project: string): string {
    return this.getProject(project).path;
  }

  async getWikiPages(project: string): Promise<WikiPage[]> {
    const proj = this.getProject(project);
    const docsDir = join(proj.path, 'docs');
    const pages: WikiPage[] = [];

    if (!existsSync(docsDir)) return pages;

    const files = walkDirectory(docsDir)
      .filter(f => f.endsWith('.md') || f.endsWith('.mdx'));

    for (const file of files) {
      const content = readFileSync(join(docsDir, file), 'utf-8');
      pages.push({
        title: file.replace(/\.(md|mdx)$/, ''),
        slug: file.replace(/\.(md|mdx)$/, '').replace(/\//g, '-'),
        content,
        format: 'markdown',
      });
    }

    return pages;
  }

  async startWatching(callback: (event: ChangeEvent) => void): Promise<void> {
    let chokidar: any;
    try {
      chokidar = await import('chokidar');
    } catch {
      console.warn('chokidar not installed, file watching disabled');
      return;
    }

    const paths = [...this.projects.values()].map(p => p.path);

    this.watcher = chokidar.watch(paths, {
      ignored: [
        /(^|[\/\\])\../, // dotfiles
        /node_modules/,
        /dist/,
        /build/,
        /target/,
      ],
      persistent: true,
      ignoreInitial: true,
    });

    this.watcher.on('all', (event: string, filePath: string) => {
      // Find which project this file belongs to
      for (const [name, proj] of this.projects) {
        if (filePath.startsWith(proj.path)) {
          const relPath = relative(proj.path, filePath);
          callback({
            provider: 'local',
            project: name,
            branch: proj.branches[0] ?? 'main',
            changes: [{
              path: relPath,
              action: event === 'unlink' ? 'deleted' : event === 'add' ? 'added' : 'modified',
            }],
            timestamp: Date.now(),
          });
          break;
        }
      }
    });
  }

  async stopWatching(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }

  private getProject(name: string): LocalProject {
    const proj = this.projects.get(name);
    if (!proj) throw new Error(`Project not found: ${name}`);
    return proj;
  }

  private mapDiffAction(file: any): FileChange['action'] {
    if (file.insertions > 0 && file.deletions === 0 && file.changes === file.insertions) {
      return 'added';
    }
    return 'modified';
  }
}

function walkDirectory(dir: string, base: string = ''): string[] {
  const files: string[] = [];
  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      if (entry.startsWith('.') || entry === 'node_modules' || entry === 'dist' || entry === 'build') {
        continue;
      }
      const fullPath = join(dir, entry);
      const relPath = base ? `${base}/${entry}` : entry;
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        files.push(...walkDirectory(fullPath, relPath));
      } else {
        files.push(relPath);
      }
    }
  } catch { /* permission errors, etc */ }
  return files;
}
