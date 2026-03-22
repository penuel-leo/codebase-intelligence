/**
 * Context builder — assembles search results into structured output.
 *
 * Two consumers:
 *   1. LLM (OpenClaw/agent): buildContext() → full content with rich metadata headers
 *   2. Human (CLI): formatResults() → concise summary with project scope awareness
 */

import type { SearchResult } from '../types/index.js';

export interface ContextOptions {
  maxTokens?: number;
  includeMetadata?: boolean;
}

/**
 * Build structured context for LLM consumption.
 * Each result includes full metadata header + complete content (not truncated).
 * This is what OpenClaw/agents should use via `--context`.
 */
export function buildContext(results: SearchResult[], options?: ContextOptions): string {
  const maxTokens = options?.maxTokens ?? 16000;
  const includeMetadata = options?.includeMetadata ?? true;
  const parts: string[] = [];
  let estimatedTokens = 0;

  parts.push(`# Codebase Search Results (${results.length} matches)\n`);

  for (let i = 0; i < results.length; i++) {
    const { chunk, score, collection } = results[i];
    const m = chunk.metadata;

    const header: string[] = [];
    header.push(`## Result ${i + 1} [${collection}] (score: ${score.toFixed(3)})`);

    if (includeMetadata) {
      const meta: string[] = [];
      meta.push(`- **Project**: ${m.project}`);
      meta.push(`- **Branch**: ${m.branch}`);
      meta.push(`- **File**: ${m.filePath}`);
      if (m.lineStart && m.lineEnd) meta.push(`- **Lines**: ${m.lineStart}-${m.lineEnd}`);
      if (m.language) meta.push(`- **Language**: ${m.language}`);
      if (m.symbolName) meta.push(`- **Symbol**: ${m.symbolName}`);
      if (m.className) meta.push(`- **Class**: ${m.className}`);
      if (m.packageName) meta.push(`- **Package**: ${m.packageName}`);
      if (m.httpMethod && m.apiPath) meta.push(`- **API**: ${m.httpMethod} ${m.apiPath}`);
      if (m.pageTitle) meta.push(`- **Page**: ${m.pageTitle}`);
      if (m.sectionHeading) meta.push(`- **Section**: ${m.sectionHeading}`);
      if (m.tags && m.tags.length > 0) meta.push(`- **Tags**: ${m.tags.join(', ')}`);
      if (m.webUrl) meta.push(`- **URL**: ${m.webUrl}`);
      header.push(meta.join('\n'));
    }

    const lang = m.language ?? '';
    const section = [
      ...header,
      '',
      '```' + lang,
      chunk.content,
      '```',
      '',
    ].join('\n');

    const sectionTokens = Math.ceil(section.length / 4);
    if (estimatedTokens + sectionTokens > maxTokens) {
      parts.push(`\n*... ${results.length - i} more results truncated due to token limit.*`);
      break;
    }

    parts.push(section);
    estimatedTokens += sectionTokens;
  }

  return parts.join('\n');
}

/**
 * Format search results as a concise human-readable summary.
 */
export function formatResults(results: SearchResult[], indexedProjects?: string[]): string {
  if (results.length === 0) {
    return formatEmptyResults(indexedProjects);
  }

  const lines: string[] = [`Found ${results.length} result(s):\n`];

  for (let i = 0; i < results.length; i++) {
    const { chunk, score, collection } = results[i];
    const m = chunk.metadata;
    const num = i + 1;

    let desc = `${num}. [${collection}] ${m.project}/${m.filePath}`;
    if (m.branch && m.branch !== 'main') desc += ` @${m.branch}`;
    if (m.symbolName) desc += ` → ${m.symbolName}`;
    if (m.className) desc += ` (${m.className})`;
    if (m.httpMethod && m.apiPath) desc += ` → ${m.httpMethod} ${m.apiPath}`;
    if (m.pageTitle) desc += ` → ${m.pageTitle}`;
    desc += ` (score: ${score.toFixed(3)})`;

    lines.push(desc);
  }

  return lines.join('\n');
}

function formatEmptyResults(indexedProjects?: string[]): string {
  const lines: string[] = [
    'No results found.',
    '',
    'Note: This tool only searches projects that have been enrolled and indexed.',
    '  It does NOT search arbitrary GitHub/GitLab repositories.',
  ];

  if (indexedProjects && indexedProjects.length > 0) {
    lines.push('');
    lines.push(`Currently indexed projects (${indexedProjects.length}):`);
    for (const p of indexedProjects.slice(0, 20)) {
      lines.push(`  - ${p}`);
    }
    if (indexedProjects.length > 20) {
      lines.push(`  ... and ${indexedProjects.length - 20} more`);
    }
  } else {
    lines.push('');
    lines.push('No projects indexed yet. Run: codebase-intelligence sync');
  }

  lines.push('');
  lines.push('To add a project, configure it in codebase-intelligence.yaml and run sync.');

  return lines.join('\n');
}

/**
 * Validate that a queried project is in the indexed scope.
 */
export function validateProjectScope(
  queriedProject: string | undefined,
  indexedProjects: string[],
): string | null {
  if (!queriedProject) return null;

  const isIndexed = indexedProjects.some(
    p => p === queriedProject || p.toLowerCase() === queriedProject.toLowerCase(),
  );

  if (!isIndexed) {
    return (
      `Project "${queriedProject}" is not in the indexed scope.\n` +
      `This tool only searches enrolled projects, not arbitrary repositories.\n` +
      `Indexed projects: ${indexedProjects.join(', ') || '(none)'}\n` +
      `To add it, configure it in codebase-intelligence.yaml and run sync.`
    );
  }

  return null;
}
