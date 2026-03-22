/**
 * Factory for creating VectorStore instances based on config.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { VectorStoreConfig } from '../types/config.js';
import type { VectorStore } from './vector-store.js';
import { SqliteVecStore } from './sqlite-vec-store.js';

export async function createVectorStore(
  config: VectorStoreConfig,
  options?: { dimensions?: number; dbPath?: string },
): Promise<VectorStore> {
  let store: VectorStore;

  switch (config.provider) {
    case 'sqlite': {
      const url = config.url ?? options?.dbPath ?? ':memory:';
      if (url !== ':memory:') {
        const dir = dirname(url);
        if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
      }
      store = new SqliteVecStore({
        url,
        collectionPrefix: config.collectionPrefix,
        dimensions: options?.dimensions,
      });
      break;
    }

    case 'chromadb': {
      const { ChromaDbStore } = await import('./chromadb-store.js');
      store = new ChromaDbStore({
        url: config.url ?? 'http://localhost:8000',
        collectionPrefix: config.collectionPrefix,
        dimensions: options?.dimensions,
        apiKey: config.apiKey,
      });
      break;
    }

    case 'qdrant': {
      // Future: implement QdrantStore
      throw new Error(
        'Qdrant support is planned but not yet implemented. ' +
        'Use "sqlite" (default) or "chromadb" for now.'
      );
    }

    default:
      throw new Error(`Unknown vector store provider: ${config.provider}`);
  }

  await store.init();
  return store;
}
