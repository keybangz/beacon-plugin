/**
 * Embedding API coordination
 * Handles requests to embedding services with retry logic, batching, and query caching
 */

import type { EmbeddingConfig, EmbedderResult, EmbedderEmbedding } from "./types.js";

/**
 * Simple LRU cache for single-text query embeddings.
 * Keyed on `${model}:${text}` so it's safe across model changes.
 * Max 256 entries — enough for repeated queries within a session without
 * consuming significant memory (256 × 384 floats × 4 bytes ≈ 400 KB).
 */
class QueryEmbeddingCache {
  private cache = new Map<string, number[]>();
  private readonly maxSize: number;

  constructor(maxSize = 256) {
    this.maxSize = maxSize;
  }

  get(model: string, text: string): number[] | null {
    const key = `${model}:${text}`;
    const value = this.cache.get(key);
    if (!value) return null;
    // Move to end (most recently used)
    this.cache.delete(key);
    this.cache.set(key, value);
    return value;
  }

  set(model: string, text: string, embedding: number[]): void {
    const key = `${model}:${text}`;
    if (this.cache.has(key)) this.cache.delete(key);
    this.cache.set(key, embedding);
    if (this.cache.size > this.maxSize) {
      // Evict LRU entry (first key in insertion order)
      const firstKey = this.cache.keys().next().value as string;
      this.cache.delete(firstKey);
    }
  }

  clear(): void {
    this.cache.clear();
  }
}

/**
 * Embedder class handles communication with embedding API
 * Supports OpenAI-compatible endpoints (Ollama, OpenAI, Voyage AI, LiteLLM, etc.)
 */
export class Embedder {
  private config: EmbeddingConfig;
  private retryDelays: number[] = [1000, 4000]; // 1s, 4s backoff
  private queryCache = new QueryEmbeddingCache(256);
  /** Maximum tokens the embedding model accepts. Used for hard-truncation. */
  private contextLimit: number;

  /**
   * @param config - Embedding API configuration
   * @param contextLimit - Model context limit in tokens (defaults to config.embedding.context_limit or 256)
   */
  constructor(config: EmbeddingConfig, contextLimit?: number) {
    this.config = config;
    this.contextLimit = contextLimit ?? config.context_limit ?? 256;
  }

  /**
   * Health check for embedding endpoint
   * @returns Result object with ok status
   */
  async ping(): Promise<EmbedderResult> {
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };

      // Add API key if configured
      if (this.config.api_key_env) {
        const apiKey: string | undefined = process.env[this.config.api_key_env];
        if (apiKey) {
          headers["Authorization"] = `Bearer ${apiKey}`;
        }
      }

      const response = await fetch(`${this.config.api_base}/models`, {
        method: "GET",
        headers,
      });

      if (!response.ok) {
        return {
          ok: false,
          error: `HTTP ${response.status}: ${response.statusText}`,
        };
      }

      return { ok: true };
    } catch (error: unknown) {
      return {
        ok: false,
        error:
          error instanceof Error ? error.message : "Unknown error occurred",
      };
    }
  }

  /**
   * Embed a single query text with LRU caching.
   * Use this for search queries instead of embedDocuments([text]) to avoid
   * a redundant HTTP round-trip on repeated or identical queries.
   * @param text - Query text (query_prefix should already be prepended if needed)
   * @returns Embedding vector
   */
  async embedQuery(text: string): Promise<number[]> {
    const cached = this.queryCache.get(this.config.model, text);
    if (cached) return cached;

    const [embedding] = await this.embedBatchWithRetry([text]);
    this.queryCache.set(this.config.model, text, embedding);
    return embedding;
  }

  /**
   * Truncate text to stay within the embedding model's context window.
   * Uses a conservative 3-char/token estimate with 80% safety margin
   * to account for tokenization differences between our estimator and
   * the actual embedding model.
   * This is a last-resort safety net; the chunker should already produce
   * correctly-sized chunks, but oversized inputs to Ollama cause hard
   * "input length exceeds context length" errors that silently drop chunks.
   * @param text - Input text
   * @param maxTokens - Maximum allowed tokens (will apply 80% safety margin)
   * @returns Truncated text
   */
  private truncateToContextLimit(text: string, maxTokens: number): string {
    // Apply 80% safety margin to account for tokenization differences
    const safeMaxTokens = Math.floor(maxTokens * 0.8);
    const maxChars = safeMaxTokens * 3; // 3 chars/token conservative estimate
    if (text.length <= maxChars) return text;
    return text.slice(0, maxChars);
  }

  /**
   * Embed documents with retry logic and batch_size splitting.
   * Splits large arrays into chunks of config.batch_size before sending,
   * preventing Ollama from stalling on files with many chunks.
   * @param documents - Array of text documents to embed
   * @returns Array of embedding vectors (same order as input)
   * @throws Error if embedding fails after retries
   */
  async embedDocuments(documents: string[]): Promise<number[][]> {
    console.log(`embedDocuments called with ${documents.length} documents`);
    if (!documents.length) {
      return [];
    }

    // Hard-truncate any document that exceeds the model context window.
    // The chunker now applies a 90% safety margin, but this provides an
    // additional safety net for tokenization differences.
    console.log(`Truncating ${documents.length} documents to context limit of ${this.contextLimit} tokens (with 90% safety margin)`);
    documents = documents.map((d) => this.truncateToContextLimit(d, this.contextLimit));

    const batchSize = this.config.batch_size ?? 50;

    // If documents fit in one batch, embed directly
    if (documents.length <= batchSize) {
      return this.embedBatchWithRetry(documents);
    }

    // Split into batches and concatenate results in order
    const results: number[][] = [];
    for (let i = 0; i < documents.length; i += batchSize) {
      const batch = documents.slice(i, i + batchSize);
      const batchResults = await this.embedBatchWithRetry(batch);
      results.push(...batchResults);
    }
    return results;
  }

  /**
   * Embed a single batch with retry logic
   * @param documents - Batch of documents to embed (must fit within batch_size)
   * @returns Array of embedding vectors
   * @throws Error if all retries are exhausted
   */
  private async embedBatchWithRetry(documents: string[]): Promise<number[][]> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.retryDelays.length; attempt++) {
      try {
        return await this.performEmbedding(documents);
      } catch (error: unknown) {
        lastError =
          error instanceof Error
            ? error
            : new Error("Unknown embedding error");

        if (attempt < this.retryDelays.length) {
          const delay: number = this.retryDelays[attempt];
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw (
      lastError ?? new Error("Failed to embed documents after all retries")
    );
  }

  /**
   * Perform single embedding request
   * @param documents - Documents to embed
   * @returns Array of embedding vectors
   * @throws Error if request fails
   */
  private async performEmbedding(documents: string[]): Promise<number[][]> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    // Add API key if configured
    if (this.config.api_key_env) {
      const apiKey: string | undefined = process.env[this.config.api_key_env];
      if (apiKey) {
        headers["Authorization"] = `Bearer ${apiKey}`;
      }
    }

    const body: Record<string, unknown> = {
      model: this.config.model,
      input: documents,
    };

    const response = await fetch(`${this.config.api_base}/embeddings`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText: string = await response.text().catch(() => "");
      throw new Error(
        `Embedding API error (${response.status}): ${errorText || response.statusText}`
      );
    }

    const data = (await response.json()) as Record<string, unknown>;

    // Extract embeddings from response
    if (!Array.isArray(data.data)) {
      throw new Error("Invalid embedding response: missing data array");
    }

    const embeddings: number[][] = (
      data.data as EmbedderEmbedding[]
    ).sort((a, b) => a.index - b.index).map((item) => item.embedding);

    if (embeddings.length !== documents.length) {
      throw new Error(
        `Embedding count mismatch: expected ${documents.length}, got ${embeddings.length}`
      );
    }

    return embeddings;
  }
}
