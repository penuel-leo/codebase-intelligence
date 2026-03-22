/**
 * `codebase-intelligence query "..."` — search the codebase index.
 *
 * Output modes:
 *   (default)     Human-readable: metadata + top-3 content preview (1200 chars each)
 *   --context     LLM-consumable: full content with structured headers (for OpenClaw/agent)
 *   --detail      Human + full content for every result
 *
 * Only searches enrolled (indexed) projects.
 */

import {
  loadConfig,
  createVectorStore,
  createEmbeddingProvider,
  SearchEngine,
  buildContext,
  formatResults,
  getDbPath,
  validateProjectScope,
} from '@codebase-intelligence/core';
import type { CollectionName, SearchFilter } from '@codebase-intelligence/core';

export async function queryCommand(
  text: string,
  options: {
    config?: string;
    type?: string;
    project?: string;
    branch?: string;
    limit?: string;
    mode?: string;
    context?: boolean;
    detail?: boolean;
  },
) {
  const config = loadConfig(options.config);

  const store = await createVectorStore(config.storage.vector, {
    dimensions: config.embedding.dimensions,
    dbPath: getDbPath(config, 'vectors'),
  });

  const embedding = createEmbeddingProvider(config.embedding);
  const search = new SearchEngine(store, embedding);

  try {
    const indexedProjects = await search.getIndexedProjects();

    if (options.project) {
      const warning = validateProjectScope(options.project, indexedProjects);
      if (warning) {
        console.warn(warning);
        return;
      }
    }

    const filter: SearchFilter = {};
    if (options.project) filter.project = options.project;
    if (options.branch) filter.branch = options.branch;

    let collections: CollectionName[] | undefined;
    if (options.type) {
      const typeMap: Record<string, CollectionName> = {
        code: 'code', api: 'api', docs: 'docs', wiki: 'docs', config: 'config',
      };
      const col = typeMap[options.type];
      if (col) collections = [col];
    }

    const mode = (options.mode as any) ?? 'hybrid';

    const results = await search.search(text, {
      collections,
      filter: Object.keys(filter).length > 0 ? filter : undefined,
      topK: parseInt(options.limit ?? '10', 10),
      mode,
    });

    // ─── Output: --context (LLM consumption, full content) ───
    if (options.context) {
      console.log(buildContext(results, { maxTokens: 16000, includeMetadata: true }));
      return;
    }

    // ─── Output: human-readable ───
    console.log(formatResults(results, indexedProjects));

    if (results.length === 0) return;

    // ─── Show each result with content ───
    const showFull = options.detail;
    const maxContentLen = showFull ? Infinity : 1200;
    const maxResults = showFull ? results.length : Math.min(3, results.length);

    console.log(`\n─── Results Detail (${maxResults} of ${results.length}) ───\n`);

    for (let i = 0; i < maxResults; i++) {
      const { chunk, score, collection } = results[i];
      const m = chunk.metadata;

      console.log(`[${i + 1}/${results.length}] ── ${collection.toUpperCase()} ──`);
      console.log(`  Project:  ${m.project}`);
      console.log(`  Branch:   ${m.branch}`);
      console.log(`  File:     ${m.filePath}`);
      if (m.lineStart && m.lineEnd) console.log(`  Lines:    ${m.lineStart}-${m.lineEnd}`);
      if (m.symbolName) console.log(`  Symbol:   ${m.symbolName}`);
      if (m.className) console.log(`  Class:    ${m.className}`);
      if (m.packageName) console.log(`  Package:  ${m.packageName}`);
      if (m.httpMethod && m.apiPath) console.log(`  API:      ${m.httpMethod} ${m.apiPath}`);
      if (m.pageTitle) console.log(`  Page:     ${m.pageTitle}`);
      if (m.language) console.log(`  Language: ${m.language}`);
      if (m.webUrl) console.log(`  URL:      ${m.webUrl}`);
      console.log(`  Score:    ${score.toFixed(3)} (${mode})`);

      const content = chunk.content;
      if (content.length <= maxContentLen) {
        console.log(`  ┄┄┄`);
        console.log(indent(content, '  '));
      } else {
        console.log(`  ┄┄┄ (${content.length} chars, showing first ${maxContentLen})`);
        console.log(indent(content.slice(0, maxContentLen), '  '));
        console.log('  ...');
      }
      console.log();
    }

    if (!showFull && results.length > maxResults) {
      console.log(`... ${results.length - maxResults} more results. Use --detail to see all, or --context for LLM output.`);
    }
  } finally {
    await store.close();
  }
}

function indent(text: string, prefix: string): string {
  return text.split('\n').map(line => prefix + line).join('\n');
}
