/**
 * Provider factory — creates SourceProvider instances from config.
 */

import type { SourceConfig } from '@codebase-intelligence/core';
import { resolveToken } from '@codebase-intelligence/core';
import type { SourceProvider, ProviderConfig } from './interface.js';
import { LocalProvider } from './local.js';
import { GitLabProvider } from './gitlab.js';
import { GitHubProvider } from './github.js';

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
    token: resolveToken(source.tokenEnv),
    workspace,
    projects: source.projects,
    branches: source.branches,
    includeDocs: source.includeDocs,
  };

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
