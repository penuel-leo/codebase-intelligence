/**
 * Embedding generator — pluggable embedding model abstraction.
 *
 * Built-in providers:
 *   - ollama: Ollama local (default, nomic-embed-text)
 *   - openai: OpenAI API
 *   - custom_http: Any OpenAI-compatible HTTP endpoint
 *     (Aliyun DashScope, Azure OpenAI, Deepseek, vLLM, LiteLLM, etc.)
 */

import type { EmbeddingConfig } from '../types/config.js';
import type { EmbeddingResult } from '../types/index.js';

export interface EmbeddingProvider {
  /** Generate embedding for a single text */
  embed(text: string): Promise<EmbeddingResult>;
  /** Generate embeddings for a batch of texts */
  embedBatch(texts: string[]): Promise<EmbeddingResult[]>;
  /** Get model dimensions */
  getDimensions(): number;
}

// ─── Ollama Embedding Provider ────────────────────────────────

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  private url: string;
  private model: string;
  private dimensions: number;

  constructor(config: EmbeddingConfig) {
    this.url = config.url ?? 'http://localhost:11434';
    this.model = config.model ?? 'nomic-embed-text';
    this.dimensions = config.dimensions ?? 768;
  }

  async embed(text: string): Promise<EmbeddingResult> {
    const response = await fetch(`${this.url}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, input: text }),
    });

    if (!response.ok) {
      throw new Error(`Ollama embed failed: ${response.status} ${await response.text()}`);
    }

    const data = await response.json() as any;
    return { vector: data.embeddings[0], model: this.model, dimensions: data.embeddings[0].length };
  }

  async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    const response = await fetch(`${this.url}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, input: texts }),
    });

    if (!response.ok) {
      throw new Error(`Ollama embed batch failed: ${response.status} ${await response.text()}`);
    }

    const data = await response.json() as any;
    return data.embeddings.map((vec: number[]) => ({
      vector: vec, model: this.model, dimensions: vec.length,
    }));
  }

  getDimensions(): number { return this.dimensions; }
}

// ─── OpenAI-compatible Embedding Provider ─────────────────────
// Works with: OpenAI, Azure OpenAI, Aliyun DashScope, Deepseek,
// vLLM, LiteLLM, LocalAI, or any /v1/embeddings endpoint.

export class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
  private url: string;
  private model: string;
  private apiKey: string;
  private dimensions: number;
  private extraHeaders: Record<string, string>;

  constructor(config: EmbeddingConfig) {
    this.url = (config.url ?? 'https://api.openai.com').replace(/\/$/, '');
    this.model = config.model ?? 'text-embedding-3-small';
    this.apiKey = config.apiKeyEnv ? (process.env[config.apiKeyEnv] ?? '') : '';
    this.dimensions = config.dimensions ?? 1536;
    this.extraHeaders = config.extraHeaders ?? {};
  }

  async embed(text: string): Promise<EmbeddingResult> {
    const results = await this.embedBatch([text]);
    return results[0];
  }

  async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.extraHeaders,
    };

    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    const body: Record<string, any> = {
      model: this.model,
      input: texts,
    };

    // Some providers support dimensions param, some don't
    if (this.dimensions) {
      body.dimensions = this.dimensions;
    }

    const response = await fetch(`${this.url}/v1/embeddings`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Embedding API failed (${this.url}): ${response.status} ${errText}`);
    }

    const data = await response.json() as any;
    return data.data.map((item: any) => ({
      vector: item.embedding,
      model: this.model,
      dimensions: item.embedding.length,
    }));
  }

  getDimensions(): number { return this.dimensions; }
}

// Keep the old name as an alias for backward compatibility
export const OpenAIEmbeddingProvider = OpenAICompatibleEmbeddingProvider;

// ─── Factory ──────────────────────────────────────────────────

/**
 * Create embedding provider from config.
 *
 * Config examples:
 *
 * Ollama (default, free local):
 *   provider: ollama
 *   model: nomic-embed-text
 *   url: http://localhost:11434
 *
 * OpenAI:
 *   provider: openai
 *   model: text-embedding-3-small
 *   apiKeyEnv: OPENAI_API_KEY
 *
 * Aliyun DashScope (text-embedding-v4):
 *   provider: custom_http
 *   model: text-embedding-v4
 *   url: https://dashscope.aliyuncs.com/compatible-mode
 *   apiKeyEnv: DASHSCOPE_API_KEY
 *   dimensions: 1024
 *
 * Azure OpenAI:
 *   provider: custom_http
 *   model: text-embedding-ada-002
 *   url: https://YOUR_RESOURCE.openai.azure.com/openai/deployments/YOUR_DEPLOYMENT
 *   apiKeyEnv: AZURE_OPENAI_KEY
 *   extraHeaders:
 *     api-version: "2024-02-01"
 *
 * Self-hosted vLLM / LiteLLM:
 *   provider: custom_http
 *   model: BAAI/bge-m3
 *   url: http://localhost:8000
 *   dimensions: 1024
 */
export function createEmbeddingProvider(config: EmbeddingConfig): EmbeddingProvider {
  switch (config.provider) {
    case 'ollama':
      return new OllamaEmbeddingProvider(config);

    case 'openai':
      return new OpenAICompatibleEmbeddingProvider(config);

    case 'custom_http':
      // Generic OpenAI-compatible HTTP endpoint
      return new OpenAICompatibleEmbeddingProvider(config);

    default:
      // Treat any unknown provider as custom_http (最大兼容性)
      console.warn(
        `Unknown embedding provider '${config.provider}', treating as custom_http. ` +
        `Ensure your endpoint is OpenAI /v1/embeddings compatible.`
      );
      return new OpenAICompatibleEmbeddingProvider(config);
  }
}
