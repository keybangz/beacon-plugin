/**
 * embedder-worker.ts
 *
 * Runs inside a worker_threads Worker.  Owns the ONNX InferenceSession so
 * that session.run() never blocks the main thread's event loop.
 *
 * Protocol (parentPort messages):
 *
 *   Main -> Worker:
 *     { type: 'init',  config: WorkerEmbedderConfig }
 *     { type: 'embed', requestId: number, texts: string[] }
 *     { type: 'close' }
 *
 *   Worker -> Main:
 *     { type: 'ready' }                          — after init succeeds
 *     { type: 'initError', error: string }       — after init fails
 *     { type: 'result',  requestId, embeddings: number[][] }
 *     { type: 'error',   requestId, error: string }
 */

import { parentPort, workerData } from "worker_threads";
import { existsSync } from "fs";
import { dirname, join } from "path";
import { cpus } from "os";

// ---------------------------------------------------------------------------
// Types mirrored from onnx-embedder.ts to avoid cross-file imports in the
// worker bundle (the worker is compiled to a standalone ESM file).
// ---------------------------------------------------------------------------
export interface WorkerEmbedderConfig {
  modelPath: string;
  dimensions: number;
  maxTokens: number;
  executionProvider?: "cpu" | "cuda" | "rocm" | "webgpu";
  /** Batch size for a single ONNX inference call. Default: auto (cpu=32, gpu=128). */
  batchSize?: number;
}

// ---------------------------------------------------------------------------
// Lazy ONNX Runtime load
// ---------------------------------------------------------------------------
let _ort: { InferenceSession: any; Tensor: any } | null = null;

async function ensureOrt(): Promise<boolean> {
  if (_ort) return true;
  try {
    const mod = await import("onnxruntime-node");
    _ort = { InferenceSession: mod.InferenceSession, Tensor: mod.Tensor };
    // Suppress global ORT C++ logger — the EP-assignment warning fires through
    // the global Ort::Env logger before per-session logSeverityLevel takes effect.
    try {
      if (mod.env && typeof mod.env === "object") {
        (mod.env as any).logLevel = "error";
      }
    } catch {
      // Older onnxruntime-node versions may not expose env — ignore.
    }
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Tokenizer (minimal re-implementation — avoids importing the full module
// graph which would pull in logger, db, etc.)
// We import BertTokenizer directly; that module has no side-effects.
// ---------------------------------------------------------------------------
import { BertTokenizer } from "./bert-tokenizer.js";
import { CodeBertTokenizer } from "./code-tokenizer.js";

interface Tokenizer {
  encode(text: string, addSpecialTokens?: boolean): number[];
  getPadTokenId(): number;
}

// ---------------------------------------------------------------------------
// Worker state
// ---------------------------------------------------------------------------
let session: any = null;
let tokenizer: Tokenizer | null = null;
let cfg: WorkerEmbedderConfig | null = null;
let effectiveBatchSize = 32;

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
async function initWorker(config: WorkerEmbedderConfig): Promise<void> {
  cfg = config;

  const ok = await ensureOrt();
  if (!ok) throw new Error("onnxruntime-node unavailable in worker");

  if (!existsSync(config.modelPath)) {
    throw new Error(`Model not found: ${config.modelPath}`);
  }

  const requestedEP = config.executionProvider ?? "cpu";
  const primaryEP: string | { name: string; deviceId?: number } =
    requestedEP === "webgpu"
      ? { name: "webgpu" }
      : requestedEP === "cuda"
        ? { name: "cuda", deviceId: 0 }
        : requestedEP === "rocm"
          ? { name: "rocm", deviceId: 0 }
          : requestedEP;
  const providers: Array<string | { name: string; deviceId?: number }> =
    requestedEP === "cpu" ? ["cpu"] : [primaryEP, "cpu"];

  const hasGpuFallback = providers.length > 1;

  // Adaptive batch size: GPU can handle larger batches efficiently.
  // CPU batch size of 64 keeps ONNX SIMD pipelines saturated without
  // exceeding typical memory budgets (~200MB peak for 384-dim models).
  effectiveBatchSize =
    config.batchSize ??
    (requestedEP === "cpu" ? 64 : 128);

  try {
    session = await _ort!.InferenceSession.create(config.modelPath, {
      executionProviders: providers,
      graphOptimizationLevel: "all",
      logSeverityLevel: hasGpuFallback ? 3 : 2,
      intraOpNumThreads: Math.max(1, Math.floor(cpus().length / 2)),
      interOpNumThreads: 1,
    });
  } catch (epErr) {
    if (requestedEP !== "cpu") {
      // GPU EP failed — fall back to CPU
      session = await _ort!.InferenceSession.create(config.modelPath, {
        executionProviders: ["cpu"],
        graphOptimizationLevel: "all",
        logSeverityLevel: 2,
        intraOpNumThreads: Math.max(1, Math.floor(cpus().length / 2)),
        interOpNumThreads: 1,
      });
    } else {
      throw epErr;
    }
  }

  const vocabPath = join(dirname(config.modelPath), "vocab.txt");
  if (!existsSync(vocabPath)) {
    throw new Error(`Vocabulary not found: ${vocabPath}`);
  }

  // Reuse the same tokenizer detection logic as ONNXEmbedder
  const modelName = config.modelPath.toLowerCase();
  if (modelName.includes("codebert") || modelName.includes("unixcoder")) {
    tokenizer = new CodeBertTokenizer(vocabPath);
  } else {
    tokenizer = new BertTokenizer(vocabPath);
  }
}

// ---------------------------------------------------------------------------
// Inference
// ---------------------------------------------------------------------------
function meanPool(
  data: Float32Array,
  attentionMask: number[],
  seqLen: number,
  dimensions: number,
): number[] {
  const result = new Float32Array(dimensions);
  let maskSum = 0;
  for (let i = 0; i < seqLen; i++) maskSum += attentionMask[i] ?? 0;
  for (let i = 0; i < seqLen; i++) {
    if ((attentionMask[i] ?? 0) === 0) continue;
    for (let d = 0; d < dimensions; d++) result[d] += data[i * dimensions + d];
  }
  for (let d = 0; d < dimensions; d++) result[d] /= maskSum > 0 ? maskSum : 1;

  // L2 normalise
  let mag = 0;
  for (let d = 0; d < dimensions; d++) mag += result[d] * result[d];
  mag = Math.sqrt(mag);
  if (mag > 0) for (let d = 0; d < dimensions; d++) result[d] /= mag;

  return Array.from(result);
}

async function embedTexts(texts: string[]): Promise<number[][]> {
  if (!session || !tokenizer || !cfg) {
    throw new Error("Worker not initialized");
  }

  const results: number[][] = new Array(texts.length);
  const dims = cfg.dimensions;

  // Process in sub-batches of effectiveBatchSize
  for (let batchStart = 0; batchStart < texts.length; batchStart += effectiveBatchSize) {
    const batchEnd = Math.min(batchStart + effectiveBatchSize, texts.length);
    const batchTexts = texts.slice(batchStart, batchEnd);

    const allInputIds: number[][] = [];
    const allMasks: number[][] = [];
    let maxLen = 0;

    for (const text of batchTexts) {
      const ids = tokenizer.encode(text, true);
      const seqLen = Math.min(ids.length, cfg.maxTokens);
      const truncated = ids.slice(0, seqLen);
      allInputIds.push(truncated);
      allMasks.push(new Array(seqLen).fill(1));
      maxLen = Math.max(maxLen, seqLen);
    }
    maxLen = Math.min(maxLen, cfg.maxTokens);

    const padId = BigInt(tokenizer.getPadTokenId());
    const paddedInputIds: bigint[] = [];
    const paddedMask: bigint[] = [];
    const paddedTypeIds: bigint[] = [];

    for (let i = 0; i < allInputIds.length; i++) {
      const ids = allInputIds[i];
      const mask = allMasks[i];
      for (let j = 0; j < maxLen; j++) {
        if (j < ids.length) {
          paddedInputIds.push(BigInt(ids[j]));
          paddedMask.push(BigInt(mask[j] ?? 1));
        } else {
          paddedInputIds.push(padId);
          paddedMask.push(0n);
        }
        paddedTypeIds.push(0n);
      }
    }

    const shape = [BigInt(batchTexts.length), BigInt(maxLen)];
    const feeds: Record<string, any> = {
      input_ids: new _ort!.Tensor("int64", BigInt64Array.from(paddedInputIds), shape),
      attention_mask: new _ort!.Tensor("int64", BigInt64Array.from(paddedMask), shape),
      token_type_ids: new _ort!.Tensor("int64", BigInt64Array.from(paddedTypeIds), shape),
    };

    const outputs = await session.run(feeds);
    const outputName = session.outputNames[0];
    const outputData = outputs[outputName].data as Float32Array;

    for (let i = 0; i < batchTexts.length; i++) {
      const startIdx = i * maxLen * dims;
      const slice = outputData.slice(startIdx, startIdx + maxLen * dims);
      results[batchStart + i] = meanPool(slice, allMasks[i], maxLen, dims);
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Message loop
// ---------------------------------------------------------------------------
if (!parentPort) {
  throw new Error("embedder-worker must be run as a Worker thread");
}

parentPort.on("message", async (msg: any) => {
  if (msg.type === "init") {
    try {
      await initWorker(msg.config as WorkerEmbedderConfig);
      parentPort!.postMessage({ type: "ready" });
    } catch (e) {
      parentPort!.postMessage({
        type: "initError",
        error: e instanceof Error ? e.message : String(e),
      });
    }
    return;
  }

  if (msg.type === "embed") {
    const { requestId, texts } = msg as { requestId: number; texts: string[] };
    try {
      const embeddings = await embedTexts(texts);
      parentPort!.postMessage({ type: "result", requestId, embeddings });
    } catch (e) {
      parentPort!.postMessage({
        type: "error",
        requestId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
    return;
  }

  if (msg.type === "close") {
    if (session) {
      await session.release().catch(() => {});
      session = null;
    }
    process.exit(0);
  }
});
