/**
 * Register a periodic `codebase-intelligence sync` line in the **system user crontab**
 * (`crontab -l` / `crontab <file>`). Does not install any npm "cron" package — only shells out
 * to the OS `crontab` command. Failures are reported to the caller; never throw.
 */

import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getDataDir, loadConfig } from '@codebase-intelligence/core';

const MARKER_BEGIN = '# BEGIN codebase-intelligence sync';
const MARKER_END = '# END codebase-intelligence sync';

function getCliPath(): string {
  try {
    return execSync('command -v codebase-intelligence', { encoding: 'utf8' }).trim();
  } catch {
    return 'codebase-intelligence';
  }
}

function validCronFiveFields(expr: string): boolean {
  const t = expr.trim();
  return t.length > 0 && !t.startsWith('#') && t.split(/\s+/).length >= 5;
}

function readUserCrontab(): string {
  try {
    return execSync('crontab -l', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  } catch {
    return '';
  }
}

function writeUserCrontab(content: string): void {
  const tmp = join(homedir(), `.ci-crontab-${process.pid}.tmp`);
  writeFileSync(tmp, content, 'utf-8');
  try {
    execSync(`crontab "${tmp}"`, { stdio: 'pipe' });
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
}

function stripManagedBlock(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let skip = false;
  for (const line of lines) {
    if (line.trim() === MARKER_BEGIN) {
      skip = true;
      continue;
    }
    if (line.trim() === MARKER_END) {
      skip = false;
      continue;
    }
    if (!skip) out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

/**
 * Refresh the managed crontab block for `resolvedConfigPath`. Safe to call on every `init`.
 */
export function tryRegisterUserCrontabSync(resolvedConfigPath: string): void {
  if (process.platform === 'win32') {
    console.log(
      '[init] This OS has no user crontab. Use Task Scheduler to run `codebase-intelligence sync` on a schedule.',
    );
    return;
  }

  try {
    const config = loadConfig(resolvedConfigPath);
    const expr = (config.sync?.cron ?? '0 */6 * * *').trim();
    if (!validCronFiveFields(expr)) {
      console.warn('[init] sync.cron is not a valid 5-field expression; crontab not updated.');
      return;
    }

    const cli = getCliPath();
    const cfg = `-c ${resolvedConfigPath}`;
    const dataDir = getDataDir(config);
    mkdirSync(dataDir, { recursive: true });
    const logFile = join(dataDir, 'schedule-sync.log');
    const line = `${expr} ${cli} sync ${cfg} >> "${logFile}" 2>&1`;

    const current = readUserCrontab();
    const without = stripManagedBlock(current);
    const block = `${MARKER_BEGIN}\n${line}\n${MARKER_END}`;
    const next = (without ? `${without}\n\n` : '') + `${block}\n`;
    writeUserCrontab(next);
    console.log(`[init] Registered periodic sync in user crontab (system \`crontab\`). Log: ${logFile}`);
  } catch (err: any) {
    console.warn(
      '[init] Could not update user crontab (run `sync` yourself or add a line manually):',
      err?.message ?? err,
    );
  }
}
