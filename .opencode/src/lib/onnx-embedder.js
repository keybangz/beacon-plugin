import { InferenceSession, Tensor } from "onnxruntime-node";
import { existsSync } from "fs";
import { dirname, join } from "path";
import { BertTokenizer } from "./bert-tokenizer.js";
import { CodeBertTokenizer } from "./code-tokenizer.js";
export class ONNXEmbedder {
    constructor(config) {
        this.session = null;
        this.tokenizer = null;
        this.initialized = false;
        this.config = config;
        this.queryCache = new Map();
    }
    async initialize() {
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
                }
                else {
                    this.tokenizer = new BertTokenizer(vocabPath);
                }
            }
            else {
                return {
                    ok: false,
                    error: `Vocabulary not found at ${vocabPath}`,
                };
            }
            this.initialized = true;
            return { ok: true };
        }
        catch (error) {
            return {
                ok: false,
                error: error instanceof Error ? error.message : "Failed to initialize ONNX embedder",
            };
        }
    }
    async embed(text) {
        if (!this.initialized || !this.session || !this.tokenizer) {
            throw new Error("ONNX embedder not initialized");
        }
        const cached = this.queryCache.get(text);
        if (cached)
            return cached;
        const inputIds = this.tokenizer.encode(text, true);
        const attentionMask = inputIds.map(() => 1);
        const seqLength = Math.min(inputIds.length, this.config.maxTokens);
        const truncatedIds = inputIds.slice(0, seqLength);
        const truncatedMask = attentionMask.slice(0, seqLength);
        while (truncatedIds.length < this.config.maxTokens) {
            truncatedIds.push(this.tokenizer.getPadTokenId());
            truncatedMask.push(0);
        }
        const inputIdsTensor = new Tensor("int64", BigInt64Array.from(truncatedIds.map(BigInt)), [1, truncatedIds.length]);
        const attentionMaskTensor = new Tensor("int64", BigInt64Array.from(truncatedMask.map(BigInt)), [1, truncatedMask.length]);
        const feeds = {
            input_ids: inputIdsTensor,
            attention_mask: attentionMaskTensor,
            token_type_ids: new Tensor("int64", BigInt64Array.from(new Array(truncatedIds.length).fill(BigInt(0))), [1, truncatedIds.length]),
        };
        const results = await this.session.run(feeds);
        const outputName = this.session.outputNames[0];
        const output = results[outputName];
        const embedding = this.meanPool(output.data, truncatedMask);
        if (this.queryCache.size >= (this.config.cacheSize ?? 256)) {
            const firstKey = this.queryCache.keys().next().value;
            if (firstKey)
                this.queryCache.delete(firstKey);
        }
        this.queryCache.set(text, embedding);
        return embedding;
    }
    async embedBatch(texts) {
        const results = [];
        for (const text of texts) {
            const embedding = await this.embed(text);
            results.push(embedding);
        }
        return results;
    }
    meanPool(data, attentionMask) {
        const dimensions = this.config.dimensions;
        const result = new Float32Array(dimensions);
        let maskSum = 0;
        for (let i = 0; i < attentionMask.length; i++) {
            maskSum += attentionMask[i];
        }
        for (let i = 0; i < attentionMask.length; i++) {
            if (attentionMask[i] === 0)
                continue;
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
    normalize(vec) {
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
    clearCache() {
        this.queryCache.clear();
    }
    async close() {
        if (this.session) {
            await this.session.release();
            this.session = null;
        }
        this.initialized = false;
    }
    isInitialized() {
        return this.initialized;
    }
}
const activeEmbedders = new Map();
export function getOrCreateONNXEmbedder(config) {
    let embedder = activeEmbedders.get(config.modelPath);
    if (!embedder) {
        embedder = new ONNXEmbedder(config);
        activeEmbedders.set(config.modelPath, embedder);
    }
    return embedder;
}
export async function closeONNXEmbedder(modelPath) {
    const embedder = activeEmbedders.get(modelPath);
    if (embedder) {
        await embedder.close();
        activeEmbedders.delete(modelPath);
    }
}
//# sourceMappingURL=onnx-embedder.js.map