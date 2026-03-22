/**
 * Shared git utilities for all providers.
 */

import { existsSync, rmSync } from 'node:fs';
import type { SimpleGit } from 'simple-git';
import type { FileChange } from '@codebase-intelligence/core';

/**
 * Parse `git diff --name-status` output into FileChange[].
 *
 * Format: "<status>\t<path>" or "<status>\t<old>\t<new>" for renames.
 *   A  src/new-file.ts        → added
 *   M  src/changed.ts         → modified
 *   D  src/removed.ts         → deleted
 *   R100  old/path.ts  new/path.ts  → renamed
 */
export function parseNameStatus(raw: string): FileChange[] {
  const changes: FileChange[] = [];

  for (const line of raw.trim().split('\n')) {
    if (!line.trim()) continue;

    const parts = line.split('\t');
    const status = parts[0].trim();
    const path = parts[1]?.trim();

    if (!path) continue;

    if (status === 'A') {
      changes.push({ path, action: 'added' });
    } else if (status === 'D') {
      changes.push({ path, action: 'deleted' });
    } else if (status.startsWith('R')) {
      const newPath = parts[2]?.trim();
      changes.push({
        path: newPath ?? path,
        action: 'renamed',
        oldPath: path,
      });
    } else {
      changes.push({ path, action: 'modified' });
    }
  }

  return changes;
}

// ─── Git Self-Healing ─────────────────────────────────────────

/**
 * Safe checkout: try checkout, if dirty working tree → reset --hard first, then retry.
 */
export async function safeCheckout(git: SimpleGit, branch: string): Promise<void> {
  try {
    await git.checkout(branch);
  } catch (err: any) {
    const msg = err.message ?? '';
    // Dirty working tree or merge conflict → reset and retry
    if (
      msg.includes('overwritten by checkout') ||
      msg.includes('conflict') ||
      msg.includes('not clean') ||
      msg.includes('local changes') ||
      msg.includes('would be overwritten')
    ) {
      console.warn(`[git] Working tree dirty, resetting before checkout ${branch}`);
      await git.reset(['--hard', 'HEAD']);
      await git.clean('f', ['-d']);
      try {
        await git.checkout(branch);
      } catch {
        await git.checkout(['-b', branch, `origin/${branch}`]);
      }
    } else if (
      msg.includes('did not match') ||
      msg.includes('not a valid') ||
      msg.includes('not found') ||
      msg.includes('pathspec') ||
      msg.includes('Invalid reference')
    ) {
      await git.checkout(['-b', branch, `origin/${branch}`]);
    } else {
      throw err;
    }
  }
}

/**
 * Safe pull: try pull, if fails → reset --hard to remote tracking branch and re-pull.
 */
export async function safePull(git: SimpleGit, branch: string): Promise<void> {
  try {
    await git.pull('origin', branch);
  } catch (err: any) {
    const msg = err.message ?? '';
    const healable =
      msg.includes('CONFLICT') ||
      msg.includes('not possible') ||
      msg.includes('diverged') ||
      msg.includes('unrelated histories') ||
      msg.includes('refusing to merge') ||
      msg.includes('Could not fast-forward') ||
      msg.includes('Cannot fast-forward') ||
      msg.includes('Merge conflict');

    if (healable) {
      console.warn(`[git] Pull failed on ${branch}, hard-reset to origin/${branch} (${msg.slice(0, 120)})`);
      try {
        await git.fetch(['origin', branch]);
      } catch {
        await git.fetch(['origin']);
      }
      try {
        await git.reset(['--hard', `origin/${branch}`]);
      } catch {
        await git.checkout(['-B', branch, `origin/${branch}`]);
      }
    } else {
      throw err;
    }
  }
}

/**
 * Safe clone: if the target directory exists but is corrupt, delete it and re-clone.
 * Returns true if a fresh clone was done.
 */
export async function safeClone(
  git: SimpleGit,
  cloneUrl: string,
  localPath: string,
  cloneArgs: string[],
): Promise<boolean> {
  // If directory exists, check if it's a valid git repo
  if (existsSync(localPath)) {
    const { join } = await import('node:path');
    if (!existsSync(join(localPath, '.git'))) {
      // Directory exists but no .git → corrupt, nuke and re-clone
      console.warn(`[git] ${localPath} exists but is not a git repo, removing and re-cloning`);
      rmSync(localPath, { recursive: true, force: true });
    } else {
      // Valid repo already exists
      return false;
    }
  }

  await git.clone(cloneUrl, localPath, cloneArgs);
  return true;
}
