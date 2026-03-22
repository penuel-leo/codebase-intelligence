/**
 * API documentation parser — splits Swagger/OpenAPI into per-endpoint chunks.
 */

import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import type { Chunk, ProviderType } from '../types/index.js';

export interface ApiDocParseContext {
  project: string;
  provider: ProviderType;
  branch: string;
  filePath: string;
  commitSha?: string;
}

export function parseApiDoc(content: string, ctx: ApiDocParseContext): Chunk[] {
  let doc: any;
  try {
    doc = JSON.parse(content);
  } catch {
    try {
      doc = parseYaml(content);
    } catch {
      return [];
    }
  }

  if (!doc) return [];

  // Detect Swagger 2.0 vs OpenAPI 3.x
  const paths = doc.paths;
  if (!paths || typeof paths !== 'object') return [];

  const chunks: Chunk[] = [];
  const basePath = doc.basePath || '';

  for (const [path, methods] of Object.entries(paths)) {
    if (typeof methods !== 'object' || methods === null) continue;

    for (const [method, operation] of Object.entries(methods as Record<string, any>)) {
      if (['get', 'post', 'put', 'delete', 'patch', 'options', 'head'].indexOf(method.toLowerCase()) === -1) {
        continue;
      }

      const fullPath = basePath + path;
      const summary = operation.summary || '';
      const description = operation.description || '';
      const tags = operation.tags || [];
      const operationId = operation.operationId || '';

      // Build human-readable chunk content
      const parts: string[] = [
        `[Project: ${ctx.project}] [Type: API Definition]`,
        `[Path: ${method.toUpperCase()} ${fullPath}]`,
      ];

      if (tags.length > 0) parts.push(`[Tags: ${tags.join(', ')}]`);
      if (summary) parts.push(`[Summary: ${summary}]`);
      if (description) parts.push(`[Description: ${description}]`);

      // Parameters
      const params = operation.parameters || [];
      if (params.length > 0) {
        parts.push('[Parameters]');
        for (const p of params) {
          const required = p.required ? 'required' : 'optional';
          parts.push(`  - ${p.name} (${p.in}, ${p.type || p.schema?.type || 'any'}, ${required}): ${p.description || ''}`);
        }
      }

      // Request body (OpenAPI 3.x)
      if (operation.requestBody) {
        const rb = operation.requestBody;
        parts.push('[Request Body]');
        const contentTypes = rb.content || {};
        for (const [ct, schema] of Object.entries(contentTypes)) {
          parts.push(`  Content-Type: ${ct}`);
          if ((schema as any).schema) {
            parts.push(`  Schema: ${JSON.stringify((schema as any).schema, null, 2).slice(0, 500)}`);
          }
        }
      }

      // Responses
      const responses = operation.responses || {};
      for (const [code, resp] of Object.entries(responses)) {
        const r = resp as any;
        parts.push(`[Response ${code}: ${r.description || ''}]`);
        if (r.schema) {
          parts.push(`  Schema: ${JSON.stringify(r.schema, null, 2).slice(0, 300)}`);
        }
        if (r.content) {
          for (const [ct, s] of Object.entries(r.content)) {
            if ((s as any).schema) {
              parts.push(`  ${ct}: ${JSON.stringify((s as any).schema, null, 2).slice(0, 300)}`);
            }
          }
        }
      }

      const chunkContent = parts.join('\n');
      const hash = createHash('sha256').update(chunkContent).digest('hex').slice(0, 16);
      const id = `${ctx.project}__api__${method.toUpperCase()}_${fullPath.replace(/[^a-zA-Z0-9]/g, '_')}__${hash}`;

      chunks.push({
        content: chunkContent,
        metadata: {
          id,
          source: ctx.provider,
          project: ctx.project,
          branch: ctx.branch,
          type: 'api',
          chunkKind: 'endpoint',
          filePath: ctx.filePath,
          httpMethod: method.toUpperCase(),
          apiPath: fullPath,
          tags,
          contentHash: hash,
          commitSha: ctx.commitSha,
          indexedAt: new Date().toISOString(),
        },
      });
    }
  }

  return chunks;
}
