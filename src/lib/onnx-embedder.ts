import { InferenceSession, Tensor } from "onnxruntime-node";
import { existsSync } from "fs";
import { dirname, join } from "path";
import type { EmbedderResult } from "./types.js";
import { BertTokenizer } from "./bert-tokenizer.js";
import { CodeBertTokenizer } from "./code-tokenizer.js";

export type ModelType = "bert" | "codebert" | "unixcoder" | "sentence-transformer";

export interface ONNXEmbedderConfig {
  modelPath: string;
  dimensions: number;
  maxTokens: number;
  cacheSize?: number;
  modelType?: ModelType;
}

interface Tokenizer {
  encode(text: string, addSpecialTokens?: boolean): number[];
  getPadTokenId(): number;
}

export class ONNXEmbedder {
  private session: InferenceSession | null = null;
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

    try {
      if (!existsSync(this.config.modelPath)) {
        return {
          ok: false,
          error: `Model not found at ${this.config.modelPath}`,
        };
      }

      this.session = await InferenceSession.create(this.config.modelPath, {
        executionProviders: ["cpu"],
        graphOptimizationLevel: "all",
      });

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
        error: error instanceof Error ? error.message : "Failed to initialize ONNX embedder",
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

    const batchSize = Math.min(uncachedTexts.length, 32);
    
    for (let batchStart = 0; batchStart < uncachedTexts.length; batchStart += batchSize) {
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

      const inputIdsTensor = new Tensor(
        "int64",
        BigInt64Array.from(paddedInputIds),
        [batchTexts.length, maxLen]
      );

      const attentionMaskTensor = new Tensor(
        "int64",
        BigInt64Array.from(paddedAttentionMask),
        [batchTexts.length, maxLen]
      );

      const tokenTypeIdsTensor = new Tensor(
        "int64",
        BigInt64Array.from(paddedTokenTypeIds),
        [batchTexts.length, maxLen]
      );

      const feeds: Record<string, Tensor> = {
        input_ids: inputIdsTensor,
        attention_mask: attentionMaskTensor,
        token_type_ids: tokenTypeIdsTensor,
      };

      const outputs = await this.session!.run(feeds);
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

  private meanPool(data: Float32Array, attentionMask: number[], seqLen: number): number[] {
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
      result[d] /= maskSum;
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

const activeEmbedders = new Map<string, { embedder: ONNXEmbedder; refCount: number }>();

export function getOrCreateONNXEmbedder(config: ONNXEmbedderConfig): ONNXEmbedder {
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
