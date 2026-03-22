/**
 * `codebase-intelligence reindex <project>` — full reindex of a project.
 */

import { loadConfig } from '@codebase-intelligence/core';
import { SyncEngine, type SyncResult } from '@codebase-intelligence/providers';

export async function reindexCommand(project: string, options: { config?: string }) {
  const config = loadConfig(options.config);

  const engine = new SyncEngine({
    config,
    onProgress: (msg: string) => console.log(msg),
  });

  await engine.init();

  try {
    // Find which provider owns this project
    const providers = engine.getProviders();
    let found = false;

    for (const provider of providers) {
      const projects = await provider.listProjects();
      const match = projects.find(p => p.name === project);
      if (match) {
        const results = await engine.reindex(provider.type, project);
        printReindexResults(results);
        found = true;
        break;
      }
    }

    if (!found) {
      console.error(`Project not found: ${project}`);
      console.log('Available projects:');
      for (const provider of providers) {
        const projects = await provider.listProjects();
        for (const p of projects) {
          console.log(`  - ${p.name} (${p.provider})`);
        }
      }
    }
  } finally {
    await engine.close();
  }
}

function printReindexResults(results: SyncResult[]) {
  console.log('\nReindex complete (per branch):');
  for (const result of results) {
    console.log(`  ${result.branch}: ${result.status}`);
    if (result.indexResult) {
      const ir = result.indexResult;
      console.log(`    chunks +${ir.chunksAdded} -${ir.chunksDeleted}, files ${ir.filesProcessed}, errors ${ir.errors.length}`);
    }
    if (result.error) console.log(`    error: ${result.error}`);
  }
}
