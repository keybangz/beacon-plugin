import type { EmbeddingConfig, EmbedderResult, EmbedderEmbedding } from "./types.js";
import { log } from "./logger.js";
import { ONNXEmbedder, type ONNXEmbedderConfig } from "./onnx-embedder.js";
import { join } from "path";
import { existsSync } from "fs";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { Worker } from "worker_threads";
import { simpleHash } from "./hash.js";
import type { WorkerEmbedderConfig } from "./embedder-worker.js";

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

// ---------------------------------------------------------------------------
// WorkerEmbedder — runs ONNX inside a worker_threads Worker so that
// session.run() never blocks the main thread's event loop.
// ---------------------------------------------------------------------------

const WORKER_INIT_TIMEOUT_MS = 90_000;

class WorkerEmbedder {
  private worker: Worker | null = null;
  private ready = false;
  private initPromise: Promise<void> | null = null;
  private pending = new Map<number, { resolve: (v: number[][]) => void; reject: (e: Error) => void }>();
  private nextRequestId = 1;
  private workerScriptPath: string;
  private cfg: WorkerEmbedderConfig;
  private closing = false;

  constructor(cfg: WorkerEmbedderConfig) {
    this.cfg = cfg;
    // Resolve path to the compiled worker script at runtime.
    const thisFilePath = fileURLToPath(import.meta.url);
    this.workerScriptPath = join(thisFilePath, "..", "embedder-worker.js");
  }

  /** Returns true if the worker script exists on disk (i.e. compiled). */
  isAvailable(): boolean {
    return existsSync(this.workerScriptPath);
  }

  /** Lazily starts the worker and sends the init message. */
  initialize(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._startWorker();
    // Clear on rejection so the next call retries instead of returning a stale rejected promise.
    this.initPromise.catch(() => {
      this.initPromise = null;
    });
    return this.initPromise;
  }

  private _startWorker(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      // Guard: ensures resolve/reject are each called at most once,
      // preventing double-settlement across timeout / error / exit races.
      let settled = false;

      const w = new Worker(this.workerScriptPath, { workerData: null });
      this.worker = w;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          w.terminate().catch(() => {});
          reject(new Error(`Worker init timed out after ${WORKER_INIT_TIMEOUT_MS / 1000}s`));
        }
      }, WORKER_INIT_TIMEOUT_MS);

      w.on("message", (msg: any) => {
        if (msg.type === "ready") {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            this.ready = true;
            resolve();
          }
          return;
        }
        if (msg.type === "initError") {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(new Error(msg.error as string));
          }
          return;
        }
        if (msg.type === "result") {
          const p = this.pending.get(msg.requestId as number);
          if (p) {
            this.pending.delete(msg.requestId as number);
            p.resolve(msg.embeddings as number[][]);
          }
          return;
        }
        if (msg.type === "error") {
          const p = this.pending.get(msg.requestId as number);
          if (p) {
            this.pending.delete(msg.requestId as number);
            p.reject(new Error(msg.error as string));
          }
          return;
        }
      });

      w.on("error", (err) => {
        clearTimeout(timer);
        this.ready = false;
        for (const p of this.pending.values()) p.reject(err);
        this.pending.clear();
        log.error("beacon", "Worker thread error", { error: err.message });
        if (!settled) {
          settled = true;
          reject(err);
        }
      });

      w.on("exit", (code) => {
        // Belt-and-suspenders: clear the timer in case exit fires before init completes.
        clearTimeout(timer);
        this.ready = false;
        const exitErr = new Error(`Worker exited with code ${code}`);
        for (const p of this.pending.values()) p.reject(exitErr);
        this.pending.clear();
        this.worker = null;
        this.initPromise = null;
        if (!settled) {
          settled = true;
          reject(exitErr);
        }
      });

      // Send init message
      w.postMessage({ type: "init", config: this.cfg });
    });
  }

  /** Embed a batch of texts. Initializes the worker on first call. */
  async embedTexts(texts: string[]): Promise<number[][]> {
    if (!this.ready || !this.worker) {
      await this.initialize();
    }
    // Capture w after initialization — this.worker could be nulled asynchronously.
    const w = this.worker;
    if (!this.ready || !w) {
      throw new Error("Worker failed to initialize");
    }

    const requestId = this.nextRequestId++;
    return new Promise<number[][]>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      w.postMessage({ type: "embed", requestId, texts });
    });
  }

  async close(): Promise<void> {
    // Guard against concurrent close() calls (e.g. pool cleanup + explicit close).
    if (this.closing) return;
    this.closing = true;
    const w = this.worker;
    if (w) {
      this.worker = null; // prevent exit handler from double-nulling
      w.postMessage({ type: "close" });
      // Give it 2s to exit gracefully, then force-terminate.
      await Promise.race([
        new Promise<void>((r) => w.once("exit", () => r())),
        new Promise<void>((r) => setTimeout(r, 2000)),
      ]);
      await w.terminate().catch(() => {});
    }
    this.ready = false;
    this.initPromise = null;
    this.closing = false;
  }
}

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
  private workerEmbedder: WorkerEmbedder | null = null;
  private storagePath: string | null = null;
  private timeoutMs: number;
  /** Guards against concurrent ONNX initialization calls creating duplicate sessions. */
  private onnxInitPromise: Promise<void> | null = null;
  /** Simple semaphore to limit concurrent ONNX inference sessions */
  private onnxConcurrencyLimit: number = 8;
  private onnxActiveCount: number = 0;
  private onnxWaitQueue: Array<() => void> = [];

  constructor(config: EmbeddingConfig, contextLimit?: number, storagePath?: string) {
    this.config = config;
    this.contextLimit = contextLimit ?? config.context_limit ?? 256;
    this.enabled = config.enabled !== false;
    this.storagePath = storagePath ?? null;
    this.timeoutMs = config.timeout_ms ?? DEFAULT_TIMEOUT_MS;
    
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
      // Absolute path provided — use as-is (must point directly to the .onnx file)
      modelPath = this.config.model;
    } else if (this.storagePath) {
      // Subdirectory layout: {storagePath}/models/{model}/model.onnx
      modelPath = join(this.storagePath, "models", this.config.model, "model.onnx");
    } else {
      // Subdirectory layout: ~/.cache/beacon/models/{model}/model.onnx
      modelPath = join(globalModelsDir, this.config.model, "model.onnx");
    }

    // Fallback: check global models dir if storagePath was used but not found
    if (!existsSync(modelPath) && this.storagePath) {
      const globalModelPath = join(globalModelsDir, this.config.model, "model.onnx");
      if (existsSync(globalModelPath)) {
        modelPath = globalModelPath;
      }
    }

    if (!existsSync(modelPath)) {
      this.mode = "disabled";
      return;
    }

    const workerCfg: WorkerEmbedderConfig = {
      modelPath,
      dimensions: this.config.dimensions,
      maxTokens: this.contextLimit,
      executionProvider: this.config.execution_provider,
      batchSize: this.config.batch_size,
    };

    const worker = new WorkerEmbedder(workerCfg);

    if (worker.isAvailable()) {
      // ── Worker-thread path (non-blocking) ──
      this.workerEmbedder = worker;
      this.onnxInitPromise = worker.initialize().then(() => {
        log.info("beacon", "ONNX worker thread ready", undefined);
        this.onnxInitPromise = null;
      }).catch((e: unknown) => {
        log.warn("beacon", "ONNX worker init failed, falling back to main-thread ONNX", { error: e instanceof Error ? e.message : String(e) });
        this.workerEmbedder = null;
        // Fall back to main-thread ONNXEmbedder
        this._initONNXFallback(modelPath);
        this.onnxInitPromise = null;
      });
    } else {
      // ── Fallback: worker script not compiled yet (dev mode / first run) ──
      log.debug("beacon", "Worker script not found, using main-thread ONNXEmbedder", { path: worker["workerScriptPath"] });
      this._initONNXFallback(modelPath);
    }
  }

  private _initONNXFallback(modelPath: string): void {
    const onnxConfig: ONNXEmbedderConfig = {
      modelPath,
      dimensions: this.config.dimensions,
      maxTokens: this.contextLimit,
      cacheSize: 256,
      executionProvider: this.config.execution_provider,
      batchSize: this.config.batch_size,
    };
    this.onnxEmbedder = new ONNXEmbedder(onnxConfig);
    const INIT_TIMEOUT_MS = 90_000;
    let initTimer: ReturnType<typeof setTimeout> | undefined;
    const initWithTimeout = Promise.race([
      this.onnxEmbedder.initialize(),
      new Promise<never>((_, reject) => {
        initTimer = setTimeout(
          () => reject(new Error(`ONNX initialization timed out after ${INIT_TIMEOUT_MS / 1000}s`)),
          INIT_TIMEOUT_MS,
        );
      }),
    ]).finally(() => { if (initTimer !== undefined) clearTimeout(initTimer); });
    this.onnxInitPromise = initWithTimeout.then(() => {
      this.onnxInitPromise = null;
    }).catch((e: unknown) => {
      log.warn("beacon", "ONNX init failed or timed out, disabling embeddings", { error: e instanceof Error ? e.message : String(e) });
      this.mode = "disabled";
      this.onnxInitPromise = null;
    });
  }

  getMode(): EmbedderMode {
    return this.mode;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Returns the resolved model path and whether the ONNX file exists on disk.
   * Works for both local (api_base="local") and absolute-path model configs.
   * Returns null for API-based embedders (no local file to check).
   */
  static checkModelDownloaded(config: EmbeddingConfig, storagePath?: string): {
    modelPath: string;
    downloaded: boolean;
  } | null {
    if (config.api_base !== "local" && !config.model.startsWith("/")) {
      return null; // API-based — no local file
    }
    const globalModelsDir = join(homedir(), ".cache", "beacon", "models");
    let modelPath: string;
    if (config.model.startsWith("/")) {
      modelPath = config.model;
    } else if (storagePath) {
      modelPath = join(storagePath, "models", config.model, "model.onnx");
    } else {
      modelPath = join(globalModelsDir, config.model, "model.onnx");
    }

    if (existsSync(modelPath)) {
      return { modelPath, downloaded: true };
    }

    // Fallback: global cache when storagePath was set but primary not found
    const globalModelPath = join(globalModelsDir, config.model, "model.onnx");
    if (storagePath && existsSync(globalModelPath)) {
      return { modelPath: globalModelPath, downloaded: true };
    }

    return { modelPath, downloaded: false };
  }

  async ping(): Promise<EmbedderResult> {
    if (!this.enabled) {
      return { ok: true, error: "Embeddings disabled - using BM25-only mode" };
    }

    if (this.mode === "onnx") {
      // Worker path
      if (this.workerEmbedder) {
        if (this.onnxInitPromise) await this.onnxInitPromise;
        return { ok: true };
      }
      // Fallback path
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

      const response = await fetchWithTimeout(
        `${this.config.api_base}/models`,
        { method: "GET", headers },
        this.timeoutMs,
      );

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

  private async acquireOnnxSlot(): Promise<void> {
    if (this.onnxActiveCount < this.onnxConcurrencyLimit) {
      this.onnxActiveCount++;
      return;
    }
    // P2: Cap the wait queue to prevent unbounded growth during reindex.
    // When the queue is full, reject immediately so callers can fall back
    // to placeholder embeddings rather than piling up forever.
    const ONNX_QUEUE_LIMIT = 8;
    if (this.onnxWaitQueue.length >= ONNX_QUEUE_LIMIT) {
      throw new Error(`ONNX wait queue full (${ONNX_QUEUE_LIMIT} entries) — dropping embedding request`);
    }
    // Timeout prevents callers from queuing forever if a session.run() hangs
    // and releaseOnnxSlot() is never called.
    const SLOT_WAIT_TIMEOUT_MS = 45_000;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Remove this entry from the queue so it doesn't fire after rejection.
        const idx = this.onnxWaitQueue.indexOf(entry);
        if (idx !== -1) this.onnxWaitQueue.splice(idx, 1);
        reject(new Error(`acquireOnnxSlot timed out after ${SLOT_WAIT_TIMEOUT_MS / 1000}s — ONNX inference may be hung`));
      }, SLOT_WAIT_TIMEOUT_MS);
      const entry = () => {
        clearTimeout(timer);
        this.onnxActiveCount++;
        resolve();
      };
      this.onnxWaitQueue.push(entry);
    });
  }

  private releaseOnnxSlot(): void {
    this.onnxActiveCount--;
    const next = this.onnxWaitQueue.shift();
    if (next) next();
  }

  async embedQuery(text: string): Promise<number[]> {
    if (this.mode === "disabled") {
      return this.generatePlaceholderEmbedding(text);
    }

    if (this.mode === "onnx") {
      if (this.onnxInitPromise) {
        await this.onnxInitPromise;
      }

      // Worker path
      if (this.workerEmbedder) {
        try {
          const results = await this.workerEmbedder.embedTexts([text]);
          return results[0];
        } catch {
          return this.generatePlaceholderEmbedding(text);
        }
      }

      // Main-thread fallback
      if (this.onnxEmbedder) {
        if (!this.onnxEmbedder.isInitialized()) {
          const result = await this.onnxEmbedder.initialize();
          if (!result.ok) {
            return this.generatePlaceholderEmbedding(text);
          }
        }
        await this.acquireOnnxSlot();
        try {
          return await this.onnxEmbedder.embed(text);
        } finally {
          this.releaseOnnxSlot();
        }
      }

      return this.generatePlaceholderEmbedding(text);
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

    // Apply document prefix (e.g. "search_document: " for nomic-embed-text-v1.5)
    const docPrefix = this.config.document_prefix ?? "";
    if (docPrefix) {
      documents = documents.map((d) => `${docPrefix}${d}`);
    }

    if (this.mode === "disabled") {
      return documents.map((d) => this.generatePlaceholderEmbedding(d));
    }

    if (this.mode === "onnx") {
      // Await any in-flight initialization before proceeding.
      if (this.onnxInitPromise) {
        await this.onnxInitPromise;
      }

      // ── Worker-thread path (preferred — non-blocking) ──
      if (this.workerEmbedder) {
        const ONNX_PER_TEXT_MS = 2_000;
        const ONNX_MAX_MS = 120_000;
        const onnxTotalTimeout = Math.min(documents.length * ONNX_PER_TEXT_MS, ONNX_MAX_MS);
        let onnxTimer: ReturnType<typeof setTimeout> | undefined;
        const onnxTimeoutPromise = new Promise<never>((_, reject) => {
          onnxTimer = setTimeout(
            () => reject(new Error(`ONNX worker embedDocuments timed out after ${onnxTotalTimeout / 1000}s for ${documents.length} texts`)),
            onnxTotalTimeout,
          );
        });
        try {
          return await Promise.race([
            this.workerEmbedder.embedTexts(documents),
            onnxTimeoutPromise,
          ]);
        } catch (e: unknown) {
          log.warn("beacon", "Worker embed failed, falling back to placeholder", { error: e instanceof Error ? e.message : String(e) });
          return documents.map((d) => this.generatePlaceholderEmbedding(d));
        } finally {
          if (onnxTimer !== undefined) clearTimeout(onnxTimer);
        }
      }

      // ── Main-thread fallback path (ONNXEmbedder) ──
      if (this.onnxEmbedder) {
        if (!this.onnxEmbedder.isInitialized()) {
          const result = await this.onnxEmbedder.initialize();
          if (!result.ok) {
            return documents.map((d) => this.generatePlaceholderEmbedding(d));
          }
        }
        // Limit concurrent ONNX inference to prevent memory spikes
        await this.acquireOnnxSlot();
        try {
          const ONNX_PER_TEXT_MS = 2_000;
          const ONNX_MAX_MS = 120_000;
          const onnxTotalTimeout = Math.min(documents.length * ONNX_PER_TEXT_MS, ONNX_MAX_MS);
          let onnxTimer: ReturnType<typeof setTimeout> | undefined;
          const onnxTimeoutPromise = new Promise<never>((_, reject) => {
            onnxTimer = setTimeout(
              () => reject(new Error(`ONNX embedDocuments timed out after ${onnxTotalTimeout / 1000}s for ${documents.length} texts`)),
              onnxTotalTimeout,
            );
          });
          try {
            return await Promise.race([
              this.onnxEmbedder.embedBatch(documents),
              onnxTimeoutPromise,
            ]);
          } finally {
            if (onnxTimer !== undefined) clearTimeout(onnxTimer);
          }
        } finally {
          this.releaseOnnxSlot();
        }
      }

      // Neither worker nor ONNXEmbedder available — fall through to placeholder
      return documents.map((d) => this.generatePlaceholderEmbedding(d));
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
        for (let k = 0; k < batchResults[j].length; k++) {
          results[batchStart + k] = batchResults[j][k];
        }
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
    // Guard against the degenerate zero seed: the LCG rng = (rng * 16807) % 2147483647
    // produces all-zeros forever when seeded with 0.
    const seed = (hash % 2147483647) || 1;
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
    if (this.workerEmbedder) {
      await this.workerEmbedder.close();
      this.workerEmbedder = null;
    }
    if (this.mode === "onnx" && this.onnxEmbedder) {
      await this.onnxEmbedder.close();
    }
    this.queryCache.clear();
    this.pendingRequests.clear();
  }
}
