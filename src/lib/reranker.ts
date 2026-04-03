import { existsSync } from "fs";
import { dirname, join } from "path";
import { BertTokenizer } from "./bert-tokenizer.js";
import { log } from "./logger.js";
import type { SearchResult } from "./types.js";

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
    })
    .catch((e) => {
      log.warn("beacon", "onnxruntime-node unavailable, reranker disabled", { error: e instanceof Error ? e.message : String(e) });
    });
  await _onnxLoadPromise;
  return _onnxRuntime !== null;
}

export interface RerankerConfig {
  modelPath: string;
  maxTokens: number;
  topK: number;
}

export interface RerankResult {
  index: number;
  score: number;
}

export class CrossEncoderReranker {
  private session: any | null = null;
  private tokenizer: BertTokenizer | null = null;
  private config: RerankerConfig;
  private initialized: boolean = false;

  constructor(config: RerankerConfig) {
    this.config = config;
  }

  async initialize(): Promise<{ ok: boolean; error?: string }> {
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
          error: `Reranker model not found at ${this.config.modelPath}`,
        };
      }

      this.session = await _onnxRuntime!.InferenceSession.create(
        this.config.modelPath,
        {
          executionProviders: ["cpu"],
          graphOptimizationLevel: "all",
        },
      );

      const vocabPath = join(dirname(this.config.modelPath), "vocab.txt");
      if (existsSync(vocabPath)) {
        this.tokenizer = new BertTokenizer(vocabPath);
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
            : "Failed to initialize reranker",
      };
    }
  }

  async rerank(query: string, documents: string[]): Promise<RerankResult[]> {
    if (!this.initialized || !this.session || !this.tokenizer) {
      throw new Error("Reranker not initialized");
    }

    const scores: number[] = [];

    for (const doc of documents) {
      const score = await this.scorePair(query, doc);
      scores.push(score);
    }

    const results = scores
      .map((score, index) => ({ index, score }))
      .sort((a, b) => b.score - a.score);

    return results;
  }

  private async scorePair(query: string, document: string): Promise<number> {
    if (!this.session || !this.tokenizer) {
      return 0;
    }

    const inputIds = this.tokenizer.encodePair(query, document);
    const seqLength = Math.min(inputIds.length, this.config.maxTokens);
    const truncatedIds = inputIds.slice(0, seqLength);

    while (truncatedIds.length < this.config.maxTokens) {
      truncatedIds.push(this.tokenizer.getPadTokenId());
    }

    // Attention mask: 1 for real tokens (first seqLength positions), 0 for padding
    const attentionMask = truncatedIds.map((_id, idx) =>
      idx < seqLength ? 1 : 0,
    );

    const inputIdsTensor = new _onnxRuntime!.Tensor(
      "int64",
      BigInt64Array.from(truncatedIds.map(BigInt)),
      [1, truncatedIds.length],
    );

    const attentionMaskTensor = new _onnxRuntime!.Tensor(
      "int64",
      BigInt64Array.from(attentionMask.map(BigInt)),
      [1, attentionMask.length],
    );

    const tokenTypeIds: number[] = [];
    const sepId = this.tokenizer.getSepTokenId();
    const firstSepIndex = truncatedIds.indexOf(sepId);

    for (let i = 0; i < truncatedIds.length; i++) {
      // If no SEP token was found (truncated away), all tokens belong to segment A (0).
      // Otherwise tokens up to and including first SEP are segment A (0), rest are B (1).
      tokenTypeIds.push(firstSepIndex === -1 ? 0 : i <= firstSepIndex ? 0 : 1);
    }

    const feeds: Record<string, any> = {
      input_ids: inputIdsTensor,
      attention_mask: attentionMaskTensor,
      token_type_ids: new _onnxRuntime!.Tensor(
        "int64",
        BigInt64Array.from(tokenTypeIds.map(BigInt)),
        [1, tokenTypeIds.length],
      ),
    };

    const results = await this.session.run(feeds);
    const outputName = this.session.outputNames[0];
    const output = results[outputName];

    const logits = output.data as Float32Array;
    const score = this.sigmoid(logits[0]);

    return score;
  }

  private sigmoid(x: number): number {
    return 1 / (1 + Math.exp(-x));
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

export function applyReranking<T>(
  results: T[],
  rerankScores: RerankResult[],
  topK?: number,
): T[] {
  const limit = topK ?? results.length;

  return rerankScores.slice(0, limit).map((r) => results[r.index]);
}

export async function rerankResults<T extends { text: string }>(
  query: string,
  results: T[],
  reranker: CrossEncoderReranker,
  topK?: number,
): Promise<(T & { rerankScore: number })[]> {
  if (results.length === 0) {
    return [];
  }

  const documents = results.map((r) => r.text);
  const rerankResults = await reranker.rerank(query, documents);
  const limit = topK ?? results.length;

  return rerankResults.slice(0, limit).map((r) => ({
    ...results[r.index],
    rerankScore: r.score,
  }));
}

const defaultReranker: CrossEncoderReranker | null = null;

export function createReranker(config: RerankerConfig): CrossEncoderReranker {
  return new CrossEncoderReranker(config);
}

export class HeuristicReranker {
  rerank(
    query: string,
    results: (SearchResult & { bm25Score?: number })[],
  ): (SearchResult & { rerankScore: number })[] {
    const queryTerms = this.extractTerms(query.toLowerCase());
    const queryIdentifiers = this.extractIdentifiers(query);

    const scored = results.map((result, index) => {
      const docText = result.chunkText.toLowerCase();
      const docTerms = this.extractTerms(docText);

      let score = 0;

      // Normalize bm25Score: BM25 from SQLite FTS5 returns negative values (closer to 0 = better).
      // We convert: bm25Norm = 1 / (1 + abs(bm25Score)) so 0→1.0, -1→0.5, -10→0.09
      const rawBm25 = result.bm25Score ?? 0;
      const bm25Norm = rawBm25 !== 0 ? 1 / (1 + Math.abs(rawBm25)) : 0;

      score += this.termOverlap(queryTerms, docTerms) * 0.25;
      score += this.identifierMatch(queryIdentifiers, docText) * 0.25;
      score += this.exactMatchBonus(query, docText) * 0.2;
      score += (result.similarity ?? 0) * 0.15;
      score += bm25Norm * 0.1;
      score += this.positionBonus(index, results.length) * 0.05;

      return {
        ...result,
        rerankScore: score,
      };
    });

    return scored.sort((a, b) => b.rerankScore - a.rerankScore);
  }

  private extractTerms(text: string): Set<string> {
    return new Set(
      text
        .replace(/[^\w\s]/g, " ")
        .split(/\s+/)
        .filter((t) => t.length > 2),
    );
  }

  private extractIdentifiers(text: string): string[] {
    const identifiers: string[] = [];
    const pattern = /\b([a-zA-Z_$][a-zA-Z0-9_$]*)\b/g;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      if (match[1].length > 2) {
        identifiers.push(match[1].toLowerCase());
      }
    }
    return identifiers;
  }

  private termOverlap(queryTerms: Set<string>, docTerms: Set<string>): number {
    let overlap = 0;
    for (const term of queryTerms) {
      if (docTerms.has(term)) {
        overlap++;
      }
    }
    return queryTerms.size > 0 ? overlap / queryTerms.size : 0;
  }

  private identifierMatch(queryIdentifiers: string[], docText: string): number {
    if (queryIdentifiers.length === 0) return 0;

    let matches = 0;
    for (const id of queryIdentifiers) {
      if (docText.includes(id)) {
        matches++;
      }
    }
    return matches / queryIdentifiers.length;
  }

  private exactMatchBonus(query: string, docText: string): number {
    const queryLower = query.toLowerCase();
    if (docText.includes(queryLower)) {
      return 1.0;
    }

    const words = queryLower.split(/\s+/);
    let matchCount = 0;
    for (const word of words) {
      if (word.length > 3 && docText.includes(word)) {
        matchCount++;
      }
    }
    return words.length > 0 ? matchCount / words.length : 0;
  }

  private positionBonus(index: number, total: number): number {
    if (total <= 1) return 1;
    return 1 - (index / total) * 0.5;
  }
}

export function createHeuristicReranker(): HeuristicReranker {
  return new HeuristicReranker();
}
