/**
 * File type router — determines how to parse and chunk each file.
 */

import { extname, basename } from 'node:path';
import type { ChunkType, CollectionName } from '../types/index.js';

export interface FileRouting {
  type: ChunkType;
  collection: CollectionName;
  language?: string;
  parser: 'code' | 'api-doc' | 'wiki' | 'config' | 'migration' | 'proto' | 'skip';
}

const CODE_EXTENSIONS: Record<string, string> = {
  '.java': 'java',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.go': 'go',
  '.py': 'python',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.rs': 'rust',
  '.rb': 'ruby',
  '.php': 'php',
  '.cs': 'csharp',
  '.cpp': 'cpp',
  '.c': 'c',
  '.h': 'c',
  '.hpp': 'cpp',
  '.swift': 'swift',
  '.scala': 'scala',
  '.lua': 'lua',
  '.sh': 'shell',
  '.bash': 'shell',
  '.zsh': 'shell',
  '.r': 'r',
  '.dart': 'dart',
  '.vue': 'vue',
  '.svelte': 'svelte',
};

const CONFIG_EXTENSIONS = new Set([
  '.yml', '.yaml', '.toml', '.ini', '.cfg', '.conf',
  '.env', '.properties',
]);

const WIKI_EXTENSIONS = new Set(['.md', '.mdx', '.rst', '.txt', '.adoc']);

const MIGRATION_PATTERNS = [
  /migrations?\//i,
  /migrate\//i,
  /flyway\//i,
  /liquibase\//i,
  /\.sql$/i,
];

const PROTO_EXTENSIONS = new Set(['.proto', '.thrift']);

const API_DOC_PATTERNS = [
  /swagger\.(json|ya?ml)$/i,
  /openapi\.(json|ya?ml)$/i,
  /api-docs?\.(json|ya?ml)$/i,
];

const SKIP_PATTERNS = [
  /node_modules\//,
  /vendor\//,
  /\.git\//,
  /dist\//,
  /build\//,
  /target\//,
  /\.next\//,
  /\.nuxt\//,
  /\.cache\//,
  /\.min\.(js|css)$/,
  /\.map$/,
  /\.lock$/,
  /package-lock\.json$/,
  /yarn\.lock$/,
  /pnpm-lock\.yaml$/,
  /\.png$/i,
  /\.jpg$/i,
  /\.jpeg$/i,
  /\.gif$/i,
  /\.svg$/i,
  /\.ico$/i,
  /\.woff2?$/i,
  /\.ttf$/i,
  /\.eot$/i,
  /\.mp[34]$/i,
  /\.webm$/i,
  /\.pdf$/i,
  /\.zip$/i,
  /\.tar\.(gz|bz2)$/i,
  /\.wasm$/i,
];

export function routeFile(filePath: string): FileRouting {
  const name = basename(filePath);
  const ext = extname(filePath).toLowerCase();

  // Skip binary / vendored files
  for (const pattern of SKIP_PATTERNS) {
    if (pattern.test(filePath)) {
      return { type: 'code', collection: 'code', parser: 'skip' };
    }
  }

  // API documentation (swagger/openapi)
  for (const pattern of API_DOC_PATTERNS) {
    if (pattern.test(filePath)) {
      return { type: 'api', collection: 'api', parser: 'api-doc' };
    }
  }

  // Proto / Thrift IDL
  if (PROTO_EXTENSIONS.has(ext)) {
    return { type: 'proto', collection: 'code', language: ext.slice(1), parser: 'proto' };
  }

  // SQL migrations
  for (const pattern of MIGRATION_PATTERNS) {
    if (pattern.test(filePath)) {
      return { type: 'migration', collection: 'code', language: 'sql', parser: 'migration' };
    }
  }

  // Wiki / documentation
  if (WIKI_EXTENSIONS.has(ext)) {
    return { type: 'wiki', collection: 'docs', parser: 'wiki' };
  }

  // Source code
  const lang = CODE_EXTENSIONS[ext];
  if (lang) {
    return { type: 'code', collection: 'code', language: lang, parser: 'code' };
  }

  // Config files
  if (CONFIG_EXTENSIONS.has(ext) || name === 'Dockerfile' || name === 'docker-compose.yml') {
    return { type: 'config', collection: 'config', parser: 'config' };
  }

  // JSON files (could be config or API doc)
  if (ext === '.json') {
    return { type: 'config', collection: 'config', parser: 'config' };
  }

  // Unknown — skip
  return { type: 'code', collection: 'code', parser: 'skip' };
}

/** Check if a file path should be indexed */
export function shouldIndex(filePath: string): boolean {
  return routeFile(filePath).parser !== 'skip';
}
