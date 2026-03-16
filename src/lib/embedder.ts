import type { EmbeddingConfig, EmbedderResult, EmbedderEmbedding } from "./types.js";
import { ONNXEmbedder, type ONNXEmbedderConfig } from "./onnx-embedder.js";
import { join } from "path";
import { existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { simpleHash } from "./hash.js";

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
    this.cache.delete(key);
    this.cache.set(key, value);
    return value;
  }

  set(model: string, text: string, embedding: number[]): void {
    const key = `${model}:${text}`;
    if (this.cache.has(key)) this.cache.delete(key);
    this.cache.set(key, embedding);
    if (this.cache.size > this.maxSize) {
      const firstKey = this.cache.keys().next().value as string;
      this.cache.delete(firstKey);
    }
  }

  clear(): void {
    this.cache.clear();
  }
}

export type EmbedderMode = "api" | "onnx" | "disabled";

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

function getDelayWithJitter(attempt: number): number {
  const baseDelay = BASE_DELAY_MS * Math.pow(2, attempt);
  const jitter = baseDelay * 0.3 * Math.random();
  return Math.min(baseDelay + jitter, 30000);
}

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

export class Embedder {
  private config: EmbeddingConfig;
  private queryCache = new QueryEmbeddingCache(256);
  private contextLimit: number;
  private enabled: boolean;
  private mode: EmbedderMode;
  private pendingRequests: Map<number, Promise<number[]>> = new Map();
  private onnxEmbedder: ONNXEmbedder | null = null;
  private storagePath: string | null = null;
  private timeoutMs: number;

  constructor(config: EmbeddingConfig, contextLimit?: number, storagePath?: string) {
    this.config = config;
    this.contextLimit = contextLimit ?? config.context_limit ?? 256;
    this.enabled = config.enabled !== false;
    this.storagePath = storagePath ?? null;
    this.timeoutMs = (config as any).timeout_ms ?? DEFAULT_TIMEOUT_MS;
    
    if (this.config.api_base === "local" || this.config.api_base === "onnx") {
      this.mode = "onnx";
      this.initializeONNX();
    } else if (!this.enabled) {
      this.mode = "disabled";
    } else {
      this.mode = "api";
    }
  }

  private initializeONNX(): void {
    const globalModelsDir = join(homedir(), ".cache", "beacon", "models");
    
    let modelPath: string;
    if (this.config.model.startsWith("/")) {
      modelPath = this.config.model;
    } else if (this.storagePath) {
      modelPath = join(this.storagePath, "models", `${this.config.model}.onnx`);
    } else {
      modelPath = join(globalModelsDir, `${this.config.model}.onnx`);
    }

    const vocabPath = join(
      modelPath.replace(/\.onnx$/, "").replace(/\.vocab\.txt$/, ""),
      "..",
      `${this.config.model}.vocab.json`
    );

    if (existsSync(modelPath)) {
      const onnxConfig: ONNXEmbedderConfig = {
        modelPath,
        dimensions: this.config.dimensions,
        maxTokens: this.contextLimit,
        cacheSize: 256,
      };
      this.onnxEmbedder = new ONNXEmbedder(onnxConfig);
      this.onnxEmbedder.initialize().catch(() => {
        this.mode = "disabled";
      });
    } else {
      const globalModelPath = join(globalModelsDir, `${this.config.model}.onnx`);
      if (existsSync(globalModelPath)) {
        const onnxConfig: ONNXEmbedderConfig = {
          modelPath: globalModelPath,
          dimensions: this.config.dimensions,
          maxTokens: this.contextLimit,
          cacheSize: 256,
        };
        this.onnxEmbedder = new ONNXEmbedder(onnxConfig);
        this.onnxEmbedder.initialize().catch(() => {
          this.mode = "disabled";
        });
      } else {
        this.mode = "disabled";
      }
    }
  }

  getMode(): EmbedderMode {
    return this.mode;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  async ping(): Promise<EmbedderResult> {
    if (!this.enabled) {
      return { ok: true, error: "Embeddings disabled - using BM25-only mode" };
    }

    if (this.mode === "onnx") {
      if (!this.onnxEmbedder) {
        return { ok: false, error: "ONNX embedder not initialized - model file may be missing" };
      }
      if (!this.onnxEmbedder.isInitialized()) {
        const result = await this.onnxEmbedder.initialize();
        if (!result.ok) {
          return result;
        }
      }
      return { ok: true };
    }

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };

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

  async embedQuery(text: string): Promise<number[]> {
    if (this.mode === "disabled") {
      return this.generatePlaceholderEmbedding(text);
    }

    if (this.mode === "onnx" && this.onnxEmbedder) {
      if (!this.onnxEmbedder.isInitialized()) {
        const result = await this.onnxEmbedder.initialize();
        if (!result.ok) {
          return this.generatePlaceholderEmbedding(text);
        }
      }
      return this.onnxEmbedder.embed(text);
    }

    const cached = this.queryCache.get(this.config.model, text);
    if (cached) return cached;

    const hash = simpleHash(`${this.config.model}:${text}`);
    const pending = this.pendingRequests.get(hash);
    if (pending) return pending;

    const request = this.embedSingle(text);
    this.pendingRequests.set(hash, request);

    try {
      const embedding = await request;
      this.queryCache.set(this.config.model, text, embedding);
      return embedding;
    } finally {
      this.pendingRequests.delete(hash);
    }
  }

  private truncateToContextLimit(text: string, maxTokens: number): string {
    const safeMaxTokens = Math.floor(maxTokens * 0.8);
    const maxChars = safeMaxTokens * 3;
    if (text.length <= maxChars) return text;
    return text.slice(0, maxChars);
  }

  async embedDocuments(documents: string[]): Promise<number[][]> {
    if (!documents.length) {
      return [];
    }

    if (this.mode === "disabled") {
      return documents.map((d) => this.generatePlaceholderEmbedding(d));
    }

    if (this.mode === "onnx" && this.onnxEmbedder) {
      if (!this.onnxEmbedder.isInitialized()) {
        const result = await this.onnxEmbedder.initialize();
        if (!result.ok) {
          return documents.map((d) => this.generatePlaceholderEmbedding(d));
        }
      }
      return this.onnxEmbedder.embedBatch(documents);
    }

    documents = documents.map((d) => this.truncateToContextLimit(d, this.contextLimit));

    const batchSize = this.config.batch_size ?? 10;

    if (documents.length <= batchSize) {
      return this.embedBatchWithRetry(documents);
    }

    const results: number[][] = new Array(documents.length);
    const batches: Array<{ start: number; docs: string[] }> = [];
    
    for (let i = 0; i < documents.length; i += batchSize) {
      const end = Math.min(i + batchSize, documents.length);
      batches.push({ start: i, docs: documents.slice(i, end) });
    }

    const concurrency = 4;
    for (let i = 0; i < batches.length; i += concurrency) {
      const batchGroup = batches.slice(i, i + concurrency);
      const batchResults = await Promise.all(
        batchGroup.map((batch) => this.embedBatchWithRetry(batch.docs))
      );
      for (let j = 0; j < batchResults.length; j++) {
        const batchStart = batchGroup[j].start;
        results.splice(batchStart, batchResults[j].length, ...batchResults[j]);
      }
    }
    
    return results;
  }

  private async embedSingle(text: string): Promise<number[]> {
    const truncated = this.truncateToContextLimit(text, this.contextLimit);
    
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        return await this.performSingleEmbedding(truncated);
      } catch (error: unknown) {
        lastError = error instanceof Error ? error : new Error("Unknown embedding error");

        if (attempt < MAX_RETRIES - 1) {
          const delay = getDelayWithJitter(attempt);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError ?? new Error("Failed to embed query after all retries");
  }

  private async embedBatchWithRetry(documents: string[]): Promise<number[][]> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        return await this.performBatchEmbedding(documents);
      } catch (error: unknown) {
        lastError =
          error instanceof Error
            ? error
            : new Error("Unknown embedding error");

        if (attempt < MAX_RETRIES - 1) {
          const delay = getDelayWithJitter(attempt);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    try {
      const results: number[][] = [];
      for (const doc of documents) {
        const embedding = await this.embedSingle(doc);
        results.push(embedding);
      }
      return results;
    } catch {
      throw lastError ?? new Error("Failed to embed documents after all retries");
    }
  }

  private async performSingleEmbedding(text: string): Promise<number[]> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (this.config.api_key_env) {
      const apiKey: string | undefined = process.env[this.config.api_key_env];
      if (apiKey) {
        headers["Authorization"] = `Bearer ${apiKey}`;
      }
    }

    const body: Record<string, unknown> = {
      model: this.config.model,
      input: text,
    };

    let response: Response;
    try {
      response = await fetchWithTimeout(
        `${this.config.api_base}/embeddings`,
        {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        },
        this.timeoutMs
      );
    } catch (error: unknown) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`Embedding request timed out after ${this.timeoutMs}ms`);
      }
      throw error;
    }

    if (!response.ok) {
      const errorText: string = await response.text().catch(() => "");
      throw new Error(
        `Embedding API error (${response.status}): ${errorText || response.statusText}`
      );
    }

    const data = (await response.json()) as Record<string, unknown>;

    if (!Array.isArray(data.data) || data.data.length === 0) {
      throw new Error("Invalid embedding response: missing data array");
    }

    const embedding = (data.data as EmbedderEmbedding[])[0].embedding;
    return embedding;
  }

  private async performBatchEmbedding(documents: string[]): Promise<number[][]> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

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

    let response: Response;
    try {
      response = await fetchWithTimeout(
        `${this.config.api_base}/embeddings`,
        {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        },
        this.timeoutMs
      );
    } catch (error: unknown) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`Embedding request timed out after ${this.timeoutMs}ms`);
      }
      throw error;
    }

    if (!response.ok) {
      const errorText: string = await response.text().catch(() => "");
      throw new Error(
        `Embedding API error (${response.status}): ${errorText || response.statusText}`
      );
    }

    const data = (await response.json()) as Record<string, unknown>;

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

  private generatePlaceholderEmbedding(text: string): number[] {
    const dims = this.config.dimensions;
    const embedding = new Float32Array(dims);
    
    const hash = simpleHash(text);
    const seed = hash % 2147483647;
    let rng = seed;
    
    for (let i = 0; i < dims; i++) {
      rng = (rng * 16807) % 2147483647;
      embedding[i] = (rng / 2147483647) * 2 - 1;
    }
    
    let magnitude = 0;
    for (let i = 0; i < dims; i++) {
      magnitude += embedding[i] * embedding[i];
    }
    magnitude = Math.sqrt(magnitude);
    
    if (magnitude > 0) {
      for (let i = 0; i < dims; i++) {
        embedding[i] /= magnitude;
      }
    }
    
    return Array.from(embedding);
  }

  async close(): Promise<void> {
    if (this.mode === "onnx" && this.onnxEmbedder) {
      await this.onnxEmbedder.close();
    }
    this.queryCache.clear();
    this.pendingRequests.clear();
  }
}
