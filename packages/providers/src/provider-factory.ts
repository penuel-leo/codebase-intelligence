/**
 * Provider factory — creates SourceProvider instances from config.
 */

import type { SourceConfig } from '@codebase-intelligence/core';
import { resolveToken } from '@codebase-intelligence/core';
import type { SourceProvider, ProviderConfig } from './interface.js';
import { LocalProvider } from './local.js';
import { GitLabProvider } from './gitlab.js';
import { GitHubProvider } from './github.js';

/** Token: explicit tokenEnv first, then conventional env vars for remote providers. */
function resolveProviderToken(source: SourceConfig): string | undefined {
  const fromConfig = resolveToken(source.tokenEnv);
  if (fromConfig) return fromConfig;
  if (source.provider === 'gitlab') return resolveToken('GITLAB_TOKEN');
  if (source.provider === 'github') return resolveToken('GITHUB_TOKEN');
  return undefined;
}

export async function createProvider(
  source: SourceConfig,
  workspace: string,
): Promise<SourceProvider> {
  let provider: SourceProvider;

  switch (source.provider) {
    case 'local':
      provider = new LocalProvider(source.name);
      break;
    case 'gitlab':
      provider = new GitLabProvider(source.name);
      break;
    case 'github':
      provider = new GitHubProvider(source.name);
      break;
    default:
      throw new Error(`Unknown provider type: ${source.provider}`);
  }

  const config: ProviderConfig = {
    type: source.provider,
    name: source.name,
    url: source.url,
    token: resolveProviderToken(source),
    workspace,
    projects: source.projects,
    branches: source.branches,
    includeDocs: source.includeDocs,
  };

  if ((source.provider === 'gitlab' || source.provider === 'github') && !config.token) {
    const fallback = source.provider === 'gitlab' ? 'GITLAB_TOKEN' : 'GITHUB_TOKEN';
    console.warn(
      `[${source.provider}] No token resolved (tokenEnv or ${fallback} empty). `
      + 'Clone will fail unless you set the variable for this process (check: same shell, no sudo without -E, or use npm link / npx from the repo you built).',
    );
  }

  await provider.init(config);
  return provider;
}

/**
 * Create all providers from config.
 */
export async function createAllProviders(
  sources: SourceConfig[],
  workspace: string,
): Promise<SourceProvider[]> {
  const providers: SourceProvider[] = [];

  for (const source of sources) {
    try {
      const provider = await createProvider(source, workspace);
      providers.push(provider);
    } catch (err: any) {
      console.error(`Failed to create provider '${source.name ?? source.provider}': ${err.message}`);
    }
  }

  return providers;
}
