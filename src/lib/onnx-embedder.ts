import { existsSync } from "fs";
import { dirname, join } from "path";
import { cpus } from "os";
import type { EmbedderResult } from "./types.js";
import { BertTokenizer } from "./bert-tokenizer.js";
import { CodeBertTokenizer } from "./code-tokenizer.js";
import { log } from "./logger.js";

// Lazy-loaded to avoid crashing the plugin if the native binding is unavailable.
let _onnxRuntime: { InferenceSession: any; Tensor: any } | null = null;
let _onnxLoadPromise: Promise<void> | null = null;

async function ensureOnnx(): Promise<boolean> {
  if (_onnxRuntime !== null) return true;
  if (_onnxLoadPromise) {
    await _onnxLoadPromise;
    return _onnxRuntime !== null;
  }
  _onnxLoadPromise = import("onnxruntime-node")
    .then((mod) => {
      _onnxRuntime = {
        InferenceSession: mod.InferenceSession,
        Tensor: mod.Tensor,
      };
      // Suppress global ORT C++ logger warnings. The per-session `logSeverityLevel`
      // option only controls run-time logging; the "Some nodes were not assigned to
      // the preferred execution providers" warning is emitted during EP assignment
      // at session-creation time through the global ORT environment logger.
      // Setting env.logLevel = 'error' (≡ level 3) silences it globally.
      // This is harmless: initialization errors are still surfaced via the
      // InferenceSession.create() rejection path.
      try {
        if (mod.env && typeof mod.env === "object") {
          (mod.env as any).logLevel = "error";
        }
      } catch {
        // env access may not exist in older onnxruntime-node versions — ignore.
      }
    })
    .catch((e) => {
      log.warn("beacon", "onnxruntime-node unavailable, embeddings disabled", { error: e instanceof Error ? e.message : String(e) });
    });
  await _onnxLoadPromise;
  return _onnxRuntime !== null;
}

export type ModelType =
  | "bert"
  | "codebert"
  | "unixcoder"
  | "sentence-transformer";

export interface ONNXEmbedderConfig {
  modelPath: string;
  dimensions: number;
  maxTokens: number;
  cacheSize?: number;
  modelType?: ModelType;
  /**
   * ONNX execution provider.
   * - "cpu"    — always available (default)
   * - "cuda"   — NVIDIA GPU (requires onnxruntime-node with CUDA 12 binaries on Linux x64)
   * - "rocm"   — AMD GPU (requires a custom onnxruntime build with ROCm EP)
   * - "webgpu" — cross-platform GPU via WebGPU/Dawn → Vulkan on Linux (experimental;
   *              AMD/NVIDIA/Intel with Vulkan drivers; onnxruntime-node ≥ 1.22 required)
   * If the requested provider fails to initialise, automatically falls back to "cpu".
   */
  executionProvider?: "cpu" | "cuda" | "rocm" | "webgpu";
  /**
   * Number of texts to embed per ONNX inference call.
   * Larger batches improve throughput at the cost of peak memory.
   * Defaults to 32 if not specified.
   */
  batchSize?: number;
}

interface Tokenizer {
  encode(text: string, addSpecialTokens?: boolean): number[];
  getPadTokenId(): number;
}

export class ONNXEmbedder {
  private session: any | null = null;
  private tokenizer: Tokenizer | null = null;
  private config: ONNXEmbedderConfig;
  private queryCache: Map<string, number[]>;
  private initialized: boolean = false;

  constructor(config: ONNXEmbedderConfig) {
    this.config = config;
    this.queryCache = new Map();
  }

  async initialize(): Promise<EmbedderResult> {
    if (this.initialized) {
      return { ok: true };
    }

    const onnxAvailable = await ensureOnnx();
    if (!onnxAvailable) {
      return {
        ok: false,
        error: "onnxruntime-node native binding unavailable",
      };
    }

    try {
      if (!existsSync(this.config.modelPath)) {
        return {
          ok: false,
          error: `Model not found at ${this.config.modelPath}`,
        };
      }

      // Build execution provider list. The requested provider is tried first;
      // "cpu" is always appended as an automatic fallback so ONNX Runtime
      // silently degrades rather than throwing when the GPU EP is unavailable.
      //
      // "webgpu" must be supplied as an object { name: "webgpu" } — ONNX Runtime
      // does not recognise it as a plain string EP the way "cpu"/"cuda"/"rocm" are.
      const requestedEP = this.config.executionProvider ?? "cpu";
      const primaryEP: string | { name: string; deviceId?: number } =
        requestedEP === "webgpu"
          ? { name: "webgpu" }
          : requestedEP === "cuda"
            ? { name: "cuda", deviceId: 0 }
            : requestedEP === "rocm"
              ? { name: "rocm", deviceId: 0 }
              : requestedEP;
      const executionProviders: Array<string | { name: string; deviceId?: number }> =
        requestedEP === "cpu"
          ? ["cpu"]
          : [primaryEP, "cpu"]; // GPU first, CPU fallback

      // Wrap session creation in a timeout to guard against Dawn/Vulkan shader
      // compilation hangs. WebGPU shader compilation can stall indefinitely on
      // certain drivers; 60 s is generous but prevents a permanent freeze.
      const SESSION_CREATE_TIMEOUT_MS = 60_000;
      const createSession = (providers: Array<string | { name: string; deviceId?: number }>) => {
        const hasGpuFallback = providers.length > 1;
        let sessionTimer: ReturnType<typeof setTimeout> | undefined;
        return Promise.race([
          _onnxRuntime!.InferenceSession.create(this.config.modelPath, {
            executionProviders: providers,
            graphOptimizationLevel: "all",
            logSeverityLevel: hasGpuFallback ? 3 : 2,
            // P0: Limit ORT's thread pool to half the CPU cores.
            // By default ORT uses ALL cores (intraOpNumThreads=0), which saturates
            // the CPU and causes OS-level stutter for the host process.
            // Using N/2 cores keeps inference fast while leaving headroom for the
            // event loop's I/O callbacks and the rest of the application.
            // interOpNumThreads=1: BERT is sequential (each layer depends on the
            // previous), so inter-op parallelism adds overhead with no benefit.
            intraOpNumThreads: Math.max(1, Math.floor(cpus().length / 2)),
            interOpNumThreads: 1,
          }),
          new Promise<never>((_, reject) => {
            sessionTimer = setTimeout(
              () => reject(new Error(`InferenceSession.create timed out after ${SESSION_CREATE_TIMEOUT_MS / 1000}s`)),
              SESSION_CREATE_TIMEOUT_MS,
            );
          }),
        ]).finally(() => { if (sessionTimer !== undefined) clearTimeout(sessionTimer); });
      };

      try {
        this.session = await createSession(executionProviders);
      } catch (epError: unknown) {
        // If the session creation failed or timed out, retry with CPU only.
        if (requestedEP !== "cpu") {
          log.warn("beacon", `${requestedEP.toUpperCase()} execution provider failed — falling back to CPU`, { error: epError instanceof Error ? epError.message : String(epError) });
          this.session = await createSession(["cpu"]);
        } else {
          throw epError;
        }
      }

      const vocabPath = join(dirname(this.config.modelPath), "vocab.txt");
      if (existsSync(vocabPath)) {
        const modelType = this.config.modelType ?? "bert";
        if (modelType === "codebert" || modelType === "unixcoder") {
          this.tokenizer = new CodeBertTokenizer(vocabPath);
        } else {
          this.tokenizer = new BertTokenizer(vocabPath);
        }
      } else {
        return {
          ok: false,
          error: `Vocabulary not found at ${vocabPath}`,
        };
      }

      this.initialized = true;
      return { ok: true };
    } catch (error: unknown) {
      return {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to initialize ONNX embedder",
      };
    }
  }

  async embed(text: string): Promise<number[]> {
    if (!this.initialized || !this.session || !this.tokenizer) {
      throw new Error("ONNX embedder not initialized");
    }

    const cached = this.queryCache.get(text);
    if (cached) return cached;

    const embeddings = await this.embedBatch([text]);
    return embeddings[0];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (!this.initialized || !this.session || !this.tokenizer) {
      throw new Error("ONNX embedder not initialized");
    }

    const results: number[][] = [];
    const uncachedTexts: string[] = [];
    const uncachedIndices: number[] = [];

    for (let i = 0; i < texts.length; i++) {
      const cached = this.queryCache.get(texts[i]);
      if (cached) {
        results[i] = cached;
      } else {
        uncachedTexts.push(texts[i]);
        uncachedIndices.push(i);
      }
    }

    if (uncachedTexts.length === 0) {
      return results;
    }

    const batchSize = Math.min(uncachedTexts.length, this.config.batchSize ?? (
      // Adaptive: GPU providers can process larger batches efficiently.
      // CPU batch size of 64 keeps ONNX SIMD pipelines saturated.
      (this.config.executionProvider && this.config.executionProvider !== "cpu") ? 128 : 64
    ));

    for (
      let batchStart = 0;
      batchStart < uncachedTexts.length;
      batchStart += batchSize
    ) {
      const batchEnd = Math.min(batchStart + batchSize, uncachedTexts.length);
      const batchTexts = uncachedTexts.slice(batchStart, batchEnd);
      const batchIndices = uncachedIndices.slice(batchStart, batchEnd);

      const allInputIds: number[][] = [];
      const allAttentionMasks: number[][] = [];
      let maxLen = 0;

      for (const text of batchTexts) {
        const inputIds = this.tokenizer!.encode(text, true);
        const seqLength = Math.min(inputIds.length, this.config.maxTokens);
        const truncatedIds = inputIds.slice(0, seqLength);
        const attentionMask = new Array(seqLength).fill(1);

        allInputIds.push(truncatedIds);
        allAttentionMasks.push(attentionMask);
        maxLen = Math.max(maxLen, truncatedIds.length);
      }

      maxLen = Math.min(maxLen, this.config.maxTokens);

      // P3: Yield after synchronous tokenization + BigInt tensor construction
      // and before dispatching to ONNX Runtime.  The tokenizer (BertTokenizer)
      // and BigInt64Array construction are pure-JS blocking operations that can
      // take tens of ms per batch (e.g. 30 chunks × 256 tokens each).
      // One setImmediate here gives the event loop a chance to drain I/O
      // callbacks (tool calls, file watcher events) before inference starts.
      await new Promise<void>((resolve) => setImmediate(resolve));

      const paddedInputIds: bigint[] = [];
      const paddedAttentionMask: bigint[] = [];
      const paddedTokenTypeIds: bigint[] = [];

      for (let i = 0; i < allInputIds.length; i++) {
        const ids = allInputIds[i];
        const mask = allAttentionMasks[i];

        for (let j = 0; j < maxLen; j++) {
          if (j < ids.length) {
            paddedInputIds.push(BigInt(ids[j]));
            paddedAttentionMask.push(BigInt(mask[j] ?? 1));
          } else {
            paddedInputIds.push(BigInt(this.tokenizer!.getPadTokenId()));
            paddedAttentionMask.push(BigInt(0));
          }
          paddedTokenTypeIds.push(BigInt(0));
        }
      }

      const inputIdsTensor = new _onnxRuntime!.Tensor(
        "int64",
        BigInt64Array.from(paddedInputIds),
        [batchTexts.length, maxLen],
      );

      const attentionMaskTensor = new _onnxRuntime!.Tensor(
        "int64",
        BigInt64Array.from(paddedAttentionMask),
        [batchTexts.length, maxLen],
      );

      const tokenTypeIdsTensor = new _onnxRuntime!.Tensor(
        "int64",
        BigInt64Array.from(paddedTokenTypeIds),
        [batchTexts.length, maxLen],
      );

      const feeds: Record<string, any> = {
        input_ids: inputIdsTensor,
        attention_mask: attentionMaskTensor,
        token_type_ids: tokenTypeIdsTensor,
      };

      // Guard against GPU driver stalls — if run() never resolves the process
      // would freeze. 30 s is well above any legitimate inference time for the
      // embedding models this plugin uses (typical: <500 ms on GPU, <2 s on CPU).
      const INFERENCE_TIMEOUT_MS = 30_000;
      let inferenceTimer: ReturnType<typeof setTimeout> | undefined;
      const outputs = await Promise.race([
        this.session!.run(feeds),
        new Promise<never>((_, reject) => {
          inferenceTimer = setTimeout(
            () => reject(new Error(`ONNX session.run timed out after ${INFERENCE_TIMEOUT_MS / 1000}s`)),
            INFERENCE_TIMEOUT_MS,
          );
        }),
      ]).finally(() => { if (inferenceTimer !== undefined) clearTimeout(inferenceTimer); });
      const outputName = this.session!.outputNames[0];
      const output = outputs[outputName];
      const outputData = output.data as Float32Array;

      for (let i = 0; i < batchTexts.length; i++) {
        const text = batchTexts[i];
        const originalIdx = batchIndices[i];
        const mask = allAttentionMasks[i];

        const startIdx = i * maxLen * this.config.dimensions;
        const endIdx = startIdx + maxLen * this.config.dimensions;
        const tokenEmbeddings = outputData.slice(startIdx, endIdx);

        const embedding = this.meanPool(tokenEmbeddings, mask, maxLen);

        if (this.queryCache.size >= (this.config.cacheSize ?? 256)) {
          const firstKey = this.queryCache.keys().next().value;
          if (firstKey) this.queryCache.delete(firstKey);
        }
        this.queryCache.set(text, embedding);

        results[originalIdx] = embedding;
      }
    }

    return results;
  }

  private meanPool(
    data: Float32Array,
    attentionMask: number[],
    seqLen: number,
  ): number[] {
    const dimensions = this.config.dimensions;
    const result = new Float32Array(dimensions);
    let maskSum = 0;

    for (let i = 0; i < seqLen; i++) {
      maskSum += attentionMask[i] ?? 0;
    }

    for (let i = 0; i < seqLen; i++) {
      if ((attentionMask[i] ?? 0) === 0) continue;
      for (let d = 0; d < dimensions; d++) {
        result[d] += data[i * dimensions + d];
      }
    }

    for (let d = 0; d < dimensions; d++) {
      result[d] /= maskSum > 0 ? maskSum : 1;
    }

    this.normalize(result);
    return Array.from(result);
  }

  private normalize(vec: Float32Array): void {
    let magnitude = 0;
    for (let i = 0; i < vec.length; i++) {
      magnitude += vec[i] * vec[i];
    }
    magnitude = Math.sqrt(magnitude);

    if (magnitude > 0) {
      for (let i = 0; i < vec.length; i++) {
        vec[i] /= magnitude;
      }
    }
  }

  clearCache(): void {
    this.queryCache.clear();
  }

  async close(): Promise<void> {
    if (this.session) {
      await this.session.release();
      this.session = null;
    }
    this.initialized = false;
  }

  isInitialized(): boolean {
    return this.initialized;
  }
}

const activeEmbedders = new Map<
  string,
  { embedder: ONNXEmbedder; refCount: number }
>();

export function getOrCreateONNXEmbedder(
  config: ONNXEmbedderConfig,
): ONNXEmbedder {
  let entry = activeEmbedders.get(config.modelPath);

  if (!entry) {
    const embedder = new ONNXEmbedder(config);
    entry = { embedder, refCount: 0 };
    activeEmbedders.set(config.modelPath, entry);
  }

  entry.refCount++;
  return entry.embedder;
}

export function releaseONNXEmbedder(modelPath: string): void {
  const entry = activeEmbedders.get(modelPath);
  if (entry) {
    entry.refCount--;
    if (entry.refCount <= 0) {
      entry.embedder.close();
      activeEmbedders.delete(modelPath);
    }
  }
}

export async function closeONNXEmbedder(modelPath: string): Promise<void> {
  const entry = activeEmbedders.get(modelPath);
  if (entry) {
    await entry.embedder.close();
    activeEmbedders.delete(modelPath);
  }
}

export async function closeAllONNXEmbedders(): Promise<void> {
  for (const entry of activeEmbedders.values()) {
    await entry.embedder.close();
  }
  activeEmbedders.clear();
}

export function getONNXEmbedderStats(): { count: number; models: string[] } {
  return {
    count: activeEmbedders.size,
    models: Array.from(activeEmbedders.keys()),
  };
}
