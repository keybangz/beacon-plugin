import { InferenceSession, Tensor } from "onnxruntime-node";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
class SimpleTokenizer {
    constructor(vocabPath, maxTokens) {
        this.vocab = new Map();
        this.unkTokenId = 0;
        this.clsTokenId = 101;
        this.sepTokenId = 102;
        this.padTokenId = 0;
        this.maxTokens = maxTokens;
        this.loadVocab(vocabPath);
    }
    loadVocab(vocabPath) {
        if (!existsSync(vocabPath)) {
            return;
        }
        try {
            const vocabData = JSON.parse(readFileSync(vocabPath, "utf-8"));
            if (Array.isArray(vocabData)) {
                vocabData.forEach((token, idx) => {
                    this.vocab.set(token, idx);
                });
            }
            else if (typeof vocabData === "object") {
                for (const [token, idx] of Object.entries(vocabData)) {
                    this.vocab.set(token, idx);
                }
            }
        }
        catch {
            // Use basic tokenization if vocab not available
        }
    }
    tokenize(text) {
        const tokens = this.basicTokenize(text);
        const inputIds = [this.clsTokenId];
        const attentionMask = [1];
        for (const token of tokens) {
            if (inputIds.length >= this.maxTokens - 1)
                break;
            const tokenId = this.vocab.get(token.toLowerCase()) ?? this.unkTokenId;
            inputIds.push(tokenId);
            attentionMask.push(1);
        }
        inputIds.push(this.sepTokenId);
        attentionMask.push(1);
        while (inputIds.length < this.maxTokens) {
            inputIds.push(this.padTokenId);
            attentionMask.push(0);
        }
        return { inputIds, attentionMask };
    }
    basicTokenize(text) {
        return text
            .toLowerCase()
            .replace(/[^\w\s]/g, " ")
            .split(/\s+/)
            .filter((t) => t.length > 0);
    }
}
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
            const vocabPath = join(dirname(this.config.modelPath), "vocab.json");
            this.tokenizer = new SimpleTokenizer(vocabPath, this.config.maxTokens);
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
        const { inputIds, attentionMask } = this.tokenizer.tokenize(text);
        const inputIdsTensor = new Tensor("int64", BigInt64Array.from(inputIds.map(BigInt)), [1, inputIds.length]);
        const attentionMaskTensor = new Tensor("int64", BigInt64Array.from(attentionMask.map(BigInt)), [1, attentionMask.length]);
        const feeds = {
            input_ids: inputIdsTensor,
            attention_mask: attentionMaskTensor,
            token_type_ids: new Tensor("int64", BigInt64Array.from(new Array(inputIds.length).fill(BigInt(0))), [1, inputIds.length]),
        };
        const results = await this.session.run(feeds);
        const outputName = this.session.outputNames[0];
        const output = results[outputName];
        const embedding = this.meanPool(output.data, attentionMask);
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