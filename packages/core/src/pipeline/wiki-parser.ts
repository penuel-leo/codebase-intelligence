/**
 * Wiki/Markdown parser — splits documentation into section-level chunks.
 */

import { createHash } from 'node:crypto';
import type { Chunk, ProviderType } from '../types/index.js';

export interface WikiParseContext {
  project: string;
  provider: ProviderType;
  branch: string;
  filePath: string;
  commitSha?: string;
}

export function parseWiki(content: string, ctx: WikiParseContext): Chunk[] {
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
          chunks.push(makeWikiChunk(sectionText, ctx, pageTitle, currentHeading, sectionStart, i));
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
      chunks.push(makeWikiChunk(sectionText, ctx, pageTitle, currentHeading, sectionStart, lines.length));
    }
  }

  // If no headings found, treat entire file as one chunk
  if (chunks.length === 0 && content.trim().length > 10) {
    chunks.push(makeWikiChunk(content, ctx, pageTitle, '', 1, lines.length));
  }

  return chunks;
}

function makeWikiChunk(
  content: string,
  ctx: WikiParseContext,
  pageTitle: string,
  sectionHeading: string,
  lineStart: number,
  lineEnd: number,
): Chunk {
  const hash = createHash('sha256').update(content).digest('hex').slice(0, 16);
  const id = `${ctx.project}__wiki__${pageTitle}__${sectionHeading || 'intro'}__${hash}`;

  return {
    content,
    metadata: {
      id,
      source: ctx.provider,
      project: ctx.project,
      branch: ctx.branch,
      type: 'wiki',
      chunkKind: sectionHeading ? 'section' : 'page',
      filePath: ctx.filePath,
      lineStart,
      lineEnd,
      pageTitle,
      sectionHeading: sectionHeading || undefined,
      contentHash: hash,
      commitSha: ctx.commitSha,
      indexedAt: new Date().toISOString(),
    },
  };
}
