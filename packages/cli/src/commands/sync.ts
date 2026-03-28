/**
 * `codebase-intelligence sync` — sync all or specific projects.
 * Shows file-level progress during sync.
 *
 * Uses a PID lock file to prevent concurrent sync processes
 * (e.g. overlapping cron triggers).
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { findConfigFile, loadConfig, getDataDir } from '@codebase-intelligence/core';
import { SyncEngine } from '@codebase-intelligence/providers';

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireLock(lockFile: string): boolean {
  if (existsSync(lockFile)) {
    const raw = readFileSync(lockFile, 'utf8').trim();
    const pid = parseInt(raw, 10);
    if (!isNaN(pid) && isProcessAlive(pid)) {
      console.log(
        `[sync] Another sync process (PID ${pid}) is already running. Skipping this run.`,
      );
      return false;
    }
    console.log(
      `[sync] Stale lock file found (PID ${raw} no longer alive). Removing and proceeding.`,
    );
  }
  writeFileSync(lockFile, String(process.pid), 'utf8');
  return true;
}

function releaseLock(lockFile: string): void {
  try {
    const raw = readFileSync(lockFile, 'utf8').trim();
    if (parseInt(raw, 10) === process.pid) {
      unlinkSync(lockFile);
    }
  } catch {
    /* lock already removed or unreadable */
  }
}

export async function syncCommand(options: { config?: string; project?: string; full?: boolean; parser?: string }) {
  const resolvedPath = findConfigFile(options.config);
  console.log(`[sync] Config file: ${resolvedPath ? resolvedPath : '(none found, using defaults — add codebase-intelligence.yaml in cwd or use -c)'}`);
  const config = loadConfig(options.config);

  const dataDir = getDataDir(config);
  mkdirSync(dataDir, { recursive: true });
  const lockFile = join(dataDir, 'sync.lock');

  if (!acquireLock(lockFile)) {
    process.exit(0);
  }

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
      const ts = new Date().toISOString().slice(11, 19);
      console.log(`[${ts}] ${msg}`);
    },
  });

  let interrupted = false;
  const shutdown = async (signal: string) => {
    if (interrupted) return;
    interrupted = true;
    console.log(`\n[sync] Received ${signal}. Shutting down gracefully...`);
    try {
      await engine.close();
    } catch { /* best effort */ }
    releaseLock(lockFile);
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  try {
    await engine.init();

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

    const results = await engine.syncAll();

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
    releaseLock(lockFile);
  }
}
