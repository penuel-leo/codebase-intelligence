/**
 * `codebase-intelligence reload` — parse and validate the config file (no HTTP).
 * Long-running processes (e.g. `serve`) still need a restart to pick up YAML changes.
 */

import { findConfigFile, loadConfig } from '@codebase-intelligence/core';

export function reloadCommand(options: { config?: string }) {
  const path = findConfigFile(options.config);
  if (!path) {
    console.error('[reload] No configuration file found.');
    process.exit(1);
  }

  try {
    loadConfig(path);
  } catch (err: any) {
    console.error(`[reload] Invalid configuration: ${err?.message ?? err}`);
    process.exit(1);
  }

  console.log(`[reload] OK — ${path}`);
  console.log('[reload] One-shot commands read config on each run. If `serve` is running, restart it to apply changes.');
}
