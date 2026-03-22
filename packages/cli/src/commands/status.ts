/**
 * `codebase-intelligence status` — show sync status for all projects.
 */

import {
  loadConfig,
  createVectorStore,
  getDbPath,
} from '@codebase-intelligence/core';
import type { CollectionName } from '@codebase-intelligence/core';

export async function statusCommand(options: { config?: string }) {
  const config = loadConfig(options.config);

  const store = await createVectorStore(config.storage.vector, {
    dimensions: config.embedding.dimensions,
    dbPath: getDbPath(config, 'vectors'),
  });

  try {
    const projects = await store.listProjects();

    if (projects.length === 0) {
      console.log('No projects indexed yet. Run: codebase-intelligence sync');
      return;
    }

    console.log('─── Indexed Projects ───\n');

    for (const project of projects.sort()) {
      const codeCount = await store.count('code', { project });
      const apiCount = await store.count('api', { project });
      const docsCount = await store.count('docs', { project });
      const configCount = await store.count('config', { project });

      console.log(`${project}`);
      console.log(`  Code chunks:    ${codeCount}`);
      console.log(`  API endpoints:  ${apiCount}`);
      console.log(`  Docs sections:  ${docsCount}`);
      console.log(`  Config files:   ${configCount}`);
      console.log(`  Total:          ${codeCount + apiCount + docsCount + configCount}`);
      console.log();
    }

    // Overall stats
    const collections: CollectionName[] = ['code', 'api', 'docs', 'config'];
    let total = 0;
    for (const col of collections) {
      const count = await store.count(col);
      total += count;
    }
    console.log(`─── Total: ${projects.length} projects, ${total} chunks ───`);
  } finally {
    await store.close();
  }
}
