/**
 * Configuration loader.
 * Loads from YAML file, merges with defaults, resolves env vars.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';

/** Resolve leading `~/` (or `~`) to the user home directory; otherwise return as-is. */
function expandHomeDir(input: string): string {
  if (input === '~') return homedir();
  if (input.startsWith('~/') || (input.startsWith('~\\') && process.platform === 'win32')) {
    return join(homedir(), input.slice(2));
  }
  return input;
}
import { parse as parseYaml } from 'yaml';
import type { AppConfig } from './types/config.js';

const DEFAULT_DATA_DIR = join(homedir(), '.codebase-intelligence');

const DEFAULT_CONFIG: AppConfig = {
  sources: [],
  storage: {
    vector: {
      provider: 'sqlite',
      collectionPrefix: 'ci_',
    },
    meta: {
      provider: 'sqlite',
    },
    dataDir: DEFAULT_DATA_DIR,
  },
  embedding: {
    provider: 'ollama',
    model: 'nomic-embed-text',
    url: 'http://localhost:11434',
    dimensions: 768,
    batchSize: 32,
  },
  sync: {
    strategy: 'incremental',
    cron: '0 */6 * * *',
    concurrency: 3,
  },
  server: {
    port: 9876,
  },
};

/** Search order for config file */
const CONFIG_SEARCH_PATHS = [
  'codebase-intelligence.yaml',
  'codebase-intelligence.yml',
  '.codebase-intelligence.yaml',
  '.codebase-intelligence.yml',
  join(homedir(), '.codebase-intelligence', 'config.yaml'),
  join(homedir(), '.codebase-intelligence', 'config.yml'),
];

export function findConfigFile(explicitPath?: string): string | null {
  if (explicitPath) {
    const abs = resolve(explicitPath);
    return existsSync(abs) ? abs : null;
  }
  for (const p of CONFIG_SEARCH_PATHS) {
    const abs = resolve(p);
    if (existsSync(abs)) return abs;
  }
  return null;
}

export function loadConfig(filePath?: string): AppConfig {
  const configPath = findConfigFile(filePath);
  if (!configPath) {
    return { ...DEFAULT_CONFIG };
  }

  const raw = readFileSync(configPath, 'utf-8');
  const userConfig = parseYaml(raw) as Partial<AppConfig>;

  return mergeConfig(DEFAULT_CONFIG, userConfig);
}

function mergeConfig(defaults: AppConfig, user: Partial<AppConfig>): AppConfig {
  return {
    sources: user.sources ?? defaults.sources,
    storage: {
      ...defaults.storage,
      ...user.storage,
      vector: { ...defaults.storage.vector, ...user.storage?.vector },
      meta: { ...defaults.storage.meta, ...user.storage?.meta },
    },
    embedding: { ...defaults.embedding, ...user.embedding },
    sync: { ...defaults.sync, ...user.sync },
    server: user.server
      ? { ...defaults.server, ...user.server } as NonNullable<AppConfig['server']>
      : defaults.server,
  };
}

/** Resolve a token from env var name */
export function resolveToken(envVarName?: string): string | undefined {
  if (!envVarName) return undefined;
  return process.env[envVarName];
}

/** Get the data directory, creating it if needed */
export function getDataDir(config: AppConfig): string {
  return resolve(expandHomeDir(config.storage.dataDir));
}

/** Get the workspace directory for cloned repos */
export function getWorkspaceDir(config: AppConfig): string {
  return config.sync.workspace
    ? resolve(expandHomeDir(config.sync.workspace))
    : join(getDataDir(config), 'repos');
}

/** Get the SQLite database path */
export function getDbPath(config: AppConfig, name: string): string {
  return join(getDataDir(config), `${name}.db`);
}
