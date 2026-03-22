/**
 * SourceProvider interface — the pluggable abstraction for code sources.
 * All providers (GitLab, GitHub, Local) implement this interface.
 */

import type {
  ProviderType,
  ProjectMeta,
  FileChange,
  ChangeEvent,
  WikiPage,
  TreeEntry,
} from '@codebase-intelligence/core';

export interface ProviderConfig {
  /** Provider type identifier */
  type: ProviderType;
  /** Human-readable name */
  name?: string;
  /** Base URL (for GitLab/GitHub) */
  url?: string;
  /** Auth token */
  token?: string;
  /** Workspace directory for cloned repos */
  workspace: string;
  /** Project configurations */
  projects: ProviderProjectConfig[];
  /** Default branches to track */
  branches?: string[];
  /** Include wiki */
  includeWiki?: boolean;
}

export interface ProviderProjectConfig {
  id?: number | string;
  name?: string;
  repo?: string;
  path?: string;
  group?: string;
  org?: string;
  branches?: string[];
  includeWiki?: boolean;
}

export interface SourceProvider {
  readonly type: ProviderType;
  readonly name: string;

  /** Initialize the provider */
  init(config: ProviderConfig): Promise<void>;

  /** Cleanup resources */
  dispose(): Promise<void>;

  /** Discover and list all configured projects */
  listProjects(): Promise<ProjectMeta[]>;

  /** Get files changed since a commit SHA */
  getChangedFiles(project: string, sinceCommit: string): Promise<FileChange[]>;

  /** Get current HEAD commit SHA */
  getHeadCommit(project: string): Promise<string>;

  /** Get file content at current HEAD */
  getFileContent(project: string, filePath: string): Promise<string>;

  /** Get full file tree of a project */
  getFileTree(project: string): Promise<string[]>;

  /** Pull latest changes for a specific branch. If branch is omitted, pull default branch. */
  pull(project: string, branch?: string): Promise<{ headCommit: string; hasChanges: boolean }>;

  /** Clone a project (first-time setup). Uses --no-single-branch to allow multi-branch fetch. */
  clone(project: string): Promise<void>;

  /** Check if project is cloned locally */
  isCloned(project: string): boolean;

  /** Get local repo path for a project */
  getLocalPath(project: string): string;

  /** Get wiki pages (optional) */
  getWikiPages?(project: string): Promise<WikiPage[]>;

  /** Start watching for changes (real-time mode) */
  startWatching?(callback: (event: ChangeEvent) => void): Promise<void>;

  /** Stop watching */
  stopWatching?(): Promise<void>;
}
