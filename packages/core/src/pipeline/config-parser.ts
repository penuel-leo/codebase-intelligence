/**
 * Config file parser — indexes configuration files as single chunks.
 */

import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import type { Chunk, ProviderType, ConfigChunkKind } from '../types/index.js';

export interface ConfigParseContext {
  project: string;
  provider: ProviderType;
  branch: string;
  filePath: string;
  commitSha?: string;
}

export function parseConfig(content: string, ctx: ConfigParseContext): Chunk[] {
  const name = basename(ctx.filePath);
  const kind = detectConfigKind(ctx.filePath);

  // Truncate very large config files
  const maxLen = 5000;
  const truncated = content.length > maxLen
    ? content.slice(0, maxLen) + '\n... (truncated)'
    : content;

  const hash = createHash('sha256').update(content).digest('hex').slice(0, 16);
  const id = `${ctx.project}__config__${name}__${hash}`;

  return [{
    content: `[Project: ${ctx.project}] [Config: ${name}]\n---\n${truncated}`,
    metadata: {
      id,
      source: ctx.provider,
      project: ctx.project,
      branch: ctx.branch,
      type: 'config',
      chunkKind: kind,
      filePath: ctx.filePath,
      contentHash: hash,
      commitSha: ctx.commitSha,
      indexedAt: new Date().toISOString(),
    },
  }];
}

function detectConfigKind(filePath: string): ConfigChunkKind {
  const lower = filePath.toLowerCase();
  if (lower.includes('dockerfile') || lower.includes('docker-compose')) return 'dockerfile';
  if (lower.includes('.gitlab-ci') || lower.includes('.github/workflows')) return 'ci';
  if (lower.includes('k8s') || lower.includes('kubernetes') || lower.includes('helm')) return 'k8s';
  if (lower.includes('.env')) return 'env';
  return 'config';
}
