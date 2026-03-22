/**
 * `codebase-intelligence serve` — start HTTP server for webhook + status API.
 *
 * This starts a long-running process that:
 *   1. Listens for GitLab/GitHub webhook push events
 *   2. Exposes GET /api/status for live progress
 *   3. Optionally runs an initial sync on startup
 */

import { loadConfig } from '@codebase-intelligence/core';
import { SyncEngine } from '@codebase-intelligence/providers';
import { CIServer } from '@codebase-intelligence/providers';

export async function serveCommand(options: {
  config?: string;
  port?: string;
  syncOnStart?: boolean;
}) {
  const config = loadConfig(options.config);
  const port = parseInt(
    options.port ?? String(config.server?.port ?? 9876),
    10,
  );

  const engine = new SyncEngine({
    config,
    onProgress: (msg: string) => {
      const ts = new Date().toISOString().slice(11, 19);
      console.log(`[${ts}] ${msg}`);
    },
  });

  await engine.init();

  const server = new CIServer(engine);
  await server.start({ port });

  // Initial sync if requested
  if (options.syncOnStart) {
    console.log('\n[serve] Running initial sync...\n');
    server.setRunning(true);
    const results = await engine.syncAll();
    server.setLastResults(results);
    server.setRunning(false);

    const success = results.filter(r => r.status === 'success').length;
    const skipped = results.filter(r => r.status === 'skipped').length;
    const errors = results.filter(r => r.status === 'error').length;
    console.log(`\n[serve] Initial sync complete: ${success} success, ${skipped} skipped, ${errors} errors`);
  }

  console.log('\n[serve] Waiting for webhook events... (Ctrl+C to stop)\n');

  // Keep process alive
  process.on('SIGINT', async () => {
    console.log('\n[serve] Shutting down...');
    await server.stop();
    await engine.close();
    process.exit(0);
  });
}
