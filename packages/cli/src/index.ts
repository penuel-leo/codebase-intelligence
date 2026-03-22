#!/usr/bin/env node

/**
 * codebase-intelligence CLI
 *
 * Usage:
 *   npx codebase-intelligence init          # Initialize config
 *   npx codebase-intelligence sync          # Sync all projects
 *   npx codebase-intelligence query "..."   # Search the index
 *   npx codebase-intelligence status        # Show sync status
 *   npx codebase-intelligence reindex <project>  # Full reindex
 */

import { Command } from 'commander';
import { initCommand } from './commands/init.js';
import { syncCommand } from './commands/sync.js';
import { queryCommand } from './commands/query.js';
import { statusCommand } from './commands/status.js';
import { reindexCommand } from './commands/reindex.js';
import { serveCommand } from './commands/serve.js';

const program = new Command();

program
  .name('codebase-intelligence')
  .description('Pluggable code repository intelligence engine')
  .version('0.1.0');

program
  .command('init')
  .description('Initialize configuration file')
  .option('-p, --provider <type>', 'Provider type: gitlab, github, local', 'local')
  .option('-d, --dir <path>', 'Data directory', '')
  .action(initCommand);

program
  .command('sync')
  .description('Sync all configured projects')
  .option('-c, --config <path>', 'Config file path')
  .option('-p, --project <name>', 'Sync only this project')
  .option('--full', 'Force full sync (ignore incremental)')
  .action(syncCommand);

program
  .command('query <text>')
  .description('Search the codebase index (only enrolled projects)')
  .option('-c, --config <path>', 'Config file path')
  .option('-t, --type <type>', 'Filter by type: code, api, docs, config')
  .option('-p, --project <name>', 'Filter by project')
  .option('-b, --branch <name>', 'Filter by branch')
  .option('-n, --limit <number>', 'Max results', '10')
  .option('-m, --mode <mode>', 'Search mode: hybrid (default), keyword, vector', 'hybrid')
  .option('--context', 'Output full context for LLM (OpenClaw/agent)')
  .option('--detail', 'Show full content for all results')
  .action(queryCommand);

program
  .command('status')
  .description('Show sync status for all projects')
  .option('-c, --config <path>', 'Config file path')
  .action(statusCommand);

program
  .command('reindex <project>')
  .description('Full reindex of a project')
  .option('-c, --config <path>', 'Config file path')
  .action(reindexCommand);

program
  .command('serve')
  .description('Start HTTP server (webhook receiver + status API)')
  .option('-c, --config <path>', 'Config file path')
  .option('-p, --port <port>', 'Server port (default: 9876)')
  .option('--sync-on-start', 'Run a full sync when server starts')
  .action(serveCommand);

program.parse();
