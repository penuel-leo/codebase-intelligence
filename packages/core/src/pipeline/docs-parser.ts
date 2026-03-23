/**
 * Documentation/Markdown parser — splits documentation into section-level chunks.
 * Supports cross-project association via knownProjects matching.
 */

import { createHash } from 'node:crypto';
import type { Chunk, ProviderType } from '../types/index.js';

export interface DocsParseContext {
  project: string;
  provider: ProviderType;
  branch: string;
  filePath: string;
  commitSha?: string;
  /** Known project names from the store — used for cross-project association */
  knownProjects?: string[];
}

export function parseDocs(content: string, ctx: DocsParseContext): Chunk[] {
  const lines = content.split('\n');
  const chunks: Chunk[] = [];

  // Extract page title from first heading or filename
  let pageTitle = ctx.filePath.replace(/\.(md|mdx|rst|txt|adoc)$/i, '').split('/').pop() || '';

  // Split by headings
  let currentHeading = '';
  let currentContent: string[] = [];
  let sectionStart = 1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);

    if (headingMatch) {
      // Save previous section
      if (currentContent.length > 0) {
        const sectionText = currentContent.join('\n').trim();
        if (sectionText.length > 10) {
          chunks.push(makeDocsChunk(sectionText, ctx, pageTitle, currentHeading, sectionStart, i));
        }
      }

      // If first heading, use as page title
      if (!pageTitle || currentHeading === '') {
        pageTitle = headingMatch[2].trim();
      }

      currentHeading = headingMatch[2].trim();
      currentContent = [line];
      sectionStart = i + 1;
    } else {
      currentContent.push(line);
    }
  }

  // Last section
  if (currentContent.length > 0) {
    const sectionText = currentContent.join('\n').trim();
    if (sectionText.length > 10) {
      chunks.push(makeDocsChunk(sectionText, ctx, pageTitle, currentHeading, sectionStart, lines.length));
    }
  }

  // If no headings found, treat entire file as one chunk
  if (chunks.length === 0 && content.trim().length > 10) {
    chunks.push(makeDocsChunk(content, ctx, pageTitle, '', 1, lines.length));
  }

  return chunks;
}

/**
 * Match known project names against file path segments and chunk content.
 * Returns project names referenced by this chunk (excluding the chunk's own project).
 */
function findRelatedProjects(
  content: string,
  filePath: string,
  ownProject: string,
  knownProjects?: string[],
): string[] | undefined {
  if (!knownProjects || knownProjects.length === 0) return undefined;

  const matched = new Set<string>();
  const pathSegments = filePath.toLowerCase().split('/');

  for (const proj of knownProjects) {
    if (proj === ownProject) continue;

    // Match against file path segments (e.g., docs/order-service/setup.md)
    const projLower = proj.toLowerCase();
    if (pathSegments.some(seg => seg === projLower || seg.includes(projLower))) {
      matched.add(proj);
      continue;
    }

    // Match as whole word in content (case-insensitive)
    // Escape regex special chars in project name
    const escaped = proj.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`\\b${escaped}\\b`, 'i');
    if (regex.test(content)) {
      matched.add(proj);
    }
  }

  return matched.size > 0 ? [...matched] : undefined;
}

function makeDocsChunk(
  content: string,
  ctx: DocsParseContext,
  pageTitle: string,
  sectionHeading: string,
  lineStart: number,
  lineEnd: number,
): Chunk {
  const hash = createHash('sha256').update(content).digest('hex').slice(0, 16);
  const id = `${ctx.project}__docs__${pageTitle}__${sectionHeading || 'intro'}__${hash}`;

  return {
    content,
    metadata: {
      id,
      source: ctx.provider,
      project: ctx.project,
      branch: ctx.branch,
      type: 'docs',
      chunkKind: sectionHeading ? 'section' : 'page',
      filePath: ctx.filePath,
      lineStart,
      lineEnd,
      pageTitle,
      sectionHeading: sectionHeading || undefined,
      relatedProjects: findRelatedProjects(content, ctx.filePath, ctx.project, ctx.knownProjects),
      contentHash: hash,
      commitSha: ctx.commitSha,
      indexedAt: new Date().toISOString(),
    },
  };
}
