/**
 * `codebase-intelligence sync` — sync all or specific projects.
 * Shows file-level progress during sync.
 */

import { loadConfig } from '@codebase-intelligence/core';
import { SyncEngine } from '@codebase-intelligence/providers';

export async function syncCommand(options: { config?: string; project?: string; full?: boolean; parser?: string }) {
  const config = loadConfig(options.config);

  // Override parser mode from CLI if specified
  if (options.parser === 'regex' || options.parser === 'tree-sitter') {
    config.parser = { mode: options.parser };
  }

  const startTime = Date.now();
  let projectsDone = 0;
  let projectsTotal = 0;

  const engine = new SyncEngine({
    config,
    onProgress: (msg: string) => {
      // Prefix with timestamp
      const ts = new Date().toISOString().slice(11, 19);
      console.log(`[${ts}] ${msg}`);
    },
  });

  await engine.init();

  // Count total tasks for project-level progress
  for (const provider of engine.getProviders()) {
    const projects = await provider.listProjects();
    for (const proj of projects) {
      projectsTotal += proj.branches.length;
    }
  }

  console.log(`\n═══ Codebase Intelligence Sync ═══`);
  console.log(`Projects × Branches: ${projectsTotal} task(s)`);
  console.log(`Concurrency: ${config.sync.concurrency ?? 3}`);
  console.log(`Strategy: incremental (L2 pull+diff, L3 fallback full reindex)`);
  console.log(`──────────────────────────────────\n`);

  try {
    const results = await engine.syncAll();

    // Summary
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n══════════════════════════════════`);
    console.log(`  Sync Summary (${elapsed}s total)`);
    console.log(`──────────────────────────────────`);

    let totalAdded = 0;
    let totalDeleted = 0;
    let totalErrors = 0;

    for (const r of results) {
      const icon = r.status === 'success' ? '✓' : r.status === 'skipped' ? '○' : '✗';
      const time = `${(r.duration / 1000).toFixed(1)}s`;
      const mode = r.syncMode ? ` [${r.syncMode}]` : '';

      if (r.indexResult) {
        totalAdded += r.indexResult.chunksAdded;
        totalDeleted += r.indexResult.chunksDeleted;
        totalErrors += r.indexResult.errors.length;
        console.log(
          `  ${icon} ${r.project}@${r.branch}${mode}` +
          ` — +${r.indexResult.chunksAdded} -${r.indexResult.chunksDeleted}` +
          ` (${r.indexResult.filesProcessed} files, ${time})`
        );
        if (r.indexResult.errors.length > 0) {
          for (const e of r.indexResult.errors.slice(0, 3)) {
            console.log(`    ⚠ ${e.file}: ${e.error}`);
          }
          if (r.indexResult.errors.length > 3) {
            console.log(`    ... and ${r.indexResult.errors.length - 3} more errors`);
          }
        }
      } else if (r.error) {
        totalErrors++;
        console.log(`  ${icon} ${r.project}@${r.branch} — ERROR: ${r.error} (${time})`);
      } else {
        console.log(`  ${icon} ${r.project}@${r.branch} — no changes (${time})`);
      }
    }

    console.log(`──────────────────────────────────`);
    console.log(`  Total: +${totalAdded} chunks, -${totalDeleted} chunks, ${totalErrors} errors`);
    console.log(`══════════════════════════════════\n`);
  } finally {
    await engine.close();
  }
}
