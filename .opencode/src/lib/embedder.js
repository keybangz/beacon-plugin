import { ONNXEmbedder } from "./onnx-embedder.js";
import { join } from "path";
import { existsSync } from "fs";
import { homedir } from "os";
class QueryEmbeddingCache {
    constructor(maxSize = 256) {
        this.cache = new Map();
        this.maxSize = maxSize;
    }
    get(model, text) {
        const key = `${model}:${text}`;
        const value = this.cache.get(key);
        if (!value)
            return null;
        this.cache.delete(key);
        this.cache.set(key, value);
        return value;
    }
    set(model, text, embedding) {
        const key = `${model}:${text}`;
        if (this.cache.has(key))
            this.cache.delete(key);
        this.cache.set(key, embedding);
        if (this.cache.size > this.maxSize) {
            const firstKey = this.cache.keys().next().value;
            this.cache.delete(firstKey);
        }
    }
    clear() {
        this.cache.clear();
    }
}
function simpleHash(str) {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
    }
    return hash >>> 0;
}
export class Embedder {
    constructor(config, contextLimit, storagePath) {
        this.retryDelays = [1000, 4000, 8000];
        this.queryCache = new QueryEmbeddingCache(256);
        this.pendingRequests = new Map();
        this.onnxEmbedder = null;
        this.storagePath = null;
        this.config = config;
        this.contextLimit = contextLimit ?? config.context_limit ?? 256;
        this.enabled = config.enabled !== false;
        this.storagePath = storagePath ?? null;
        if (this.config.api_base === "local" || this.config.api_base === "onnx") {
            this.mode = "onnx";
            this.initializeONNX();
        }
        else if (!this.enabled) {
            this.mode = "disabled";
        }
        else {
            this.mode = "api";
        }
    }
    initializeONNX() {
        const globalModelsDir = join(homedir(), ".cache", "beacon", "models");
        let modelPath;
        if (this.config.model.startsWith("/")) {
            modelPath = this.config.model;
        }
        else if (this.storagePath) {
            modelPath = join(this.storagePath, "models", `${this.config.model}.onnx`);
        }
        else {
            modelPath = join(globalModelsDir, `${this.config.model}.onnx`);
        }
        const vocabPath = join(modelPath.replace(/\.onnx$/, "").replace(/\.vocab\.txt$/, ""), "..", `${this.config.model}.vocab.json`);
        if (existsSync(modelPath)) {
            const onnxConfig = {
                modelPath,
                dimensions: this.config.dimensions,
                maxTokens: this.contextLimit,
                cacheSize: 256,
            };
            this.onnxEmbedder = new ONNXEmbedder(onnxConfig);
            this.onnxEmbedder.initialize().catch(() => {
                this.mode = "disabled";
            });
        }
        else {
            const globalModelPath = join(globalModelsDir, `${this.config.model}.onnx`);
            if (existsSync(globalModelPath)) {
                const onnxConfig = {
                    modelPath: globalModelPath,
                    dimensions: this.config.dimensions,
                    maxTokens: this.contextLimit,
                    cacheSize: 256,
                };
                this.onnxEmbedder = new ONNXEmbedder(onnxConfig);
                this.onnxEmbedder.initialize().catch(() => {
                    this.mode = "disabled";
                });
            }
            else {
                this.mode = "disabled";
            }
        }
    }
    getMode() {
        return this.mode;
    }
    isEnabled() {
        return this.enabled;
    }
    async ping() {
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
            const headers = {
                "Content-Type": "application/json",
            };
            if (this.config.api_key_env) {
                const apiKey = process.env[this.config.api_key_env];
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
        }
        catch (error) {
            return {
                ok: false,
                error: error instanceof Error ? error.message : "Unknown error occurred",
            };
        }
    }
    async embedQuery(text) {
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
        if (cached)
            return cached;
        const hash = simpleHash(`${this.config.model}:${text}`);
        const pending = this.pendingRequests.get(hash);
        if (pending)
            return pending;
        const request = this.embedSingle(text);
        this.pendingRequests.set(hash, request);
        try {
            const embedding = await request;
            this.queryCache.set(this.config.model, text, embedding);
            return embedding;
        }
        finally {
            this.pendingRequests.delete(hash);
        }
    }
    truncateToContextLimit(text, maxTokens) {
        const safeMaxTokens = Math.floor(maxTokens * 0.8);
        const maxChars = safeMaxTokens * 3;
        if (text.length <= maxChars)
            return text;
        return text.slice(0, maxChars);
    }
    async embedDocuments(documents) {
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
        const results = new Array(documents.length);
        const batches = [];
        for (let i = 0; i < documents.length; i += batchSize) {
            const end = Math.min(i + batchSize, documents.length);
            batches.push({ start: i, docs: documents.slice(i, end) });
        }
        const concurrency = 4;
        for (let i = 0; i < batches.length; i += concurrency) {
            const batchGroup = batches.slice(i, i + concurrency);
            const batchResults = await Promise.all(batchGroup.map((batch) => this.embedBatchWithRetry(batch.docs)));
            for (let j = 0; j < batchResults.length; j++) {
                const batchStart = batchGroup[j].start;
                results.splice(batchStart, batchResults[j].length, ...batchResults[j]);
            }
        }
        return results;
    }
    async embedSingle(text) {
        const truncated = this.truncateToContextLimit(text, this.contextLimit);
        let lastError = null;
        for (let attempt = 0; attempt <= this.retryDelays.length; attempt++) {
            try {
                return await this.performSingleEmbedding(truncated);
            }
            catch (error) {
                lastError = error instanceof Error ? error : new Error("Unknown embedding error");
                if (attempt < this.retryDelays.length) {
                    const delay = this.retryDelays[attempt];
                    await new Promise((resolve) => setTimeout(resolve, delay));
                }
            }
        }
        throw lastError ?? new Error("Failed to embed query after all retries");
    }
    async embedBatchWithRetry(documents) {
        let lastError = null;
        for (let attempt = 0; attempt <= this.retryDelays.length; attempt++) {
            try {
                return await this.performBatchEmbedding(documents);
            }
            catch (error) {
                lastError =
                    error instanceof Error
                        ? error
                        : new Error("Unknown embedding error");
                if (attempt < this.retryDelays.length) {
                    const delay = this.retryDelays[attempt];
                    await new Promise((resolve) => setTimeout(resolve, delay));
                }
            }
        }
        try {
            const results = [];
            for (const doc of documents) {
                const embedding = await this.embedSingle(doc);
                results.push(embedding);
            }
            return results;
        }
        catch {
            throw lastError ?? new Error("Failed to embed documents after all retries");
        }
    }
    async performSingleEmbedding(text) {
        const headers = {
            "Content-Type": "application/json",
        };
        if (this.config.api_key_env) {
            const apiKey = process.env[this.config.api_key_env];
            if (apiKey) {
                headers["Authorization"] = `Bearer ${apiKey}`;
            }
        }
        const body = {
            model: this.config.model,
            input: text,
        };
        const response = await fetch(`${this.config.api_base}/embeddings`, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
        });
        if (!response.ok) {
            const errorText = await response.text().catch(() => "");
            throw new Error(`Embedding API error (${response.status}): ${errorText || response.statusText}`);
        }
        const data = (await response.json());
        if (!Array.isArray(data.data) || data.data.length === 0) {
            throw new Error("Invalid embedding response: missing data array");
        }
        const embedding = data.data[0].embedding;
        return embedding;
    }
    async performBatchEmbedding(documents) {
        const headers = {
            "Content-Type": "application/json",
        };
        if (this.config.api_key_env) {
            const apiKey = process.env[this.config.api_key_env];
            if (apiKey) {
                headers["Authorization"] = `Bearer ${apiKey}`;
            }
        }
        const body = {
            model: this.config.model,
            input: documents,
        };
        const response = await fetch(`${this.config.api_base}/embeddings`, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
        });
        if (!response.ok) {
            const errorText = await response.text().catch(() => "");
            throw new Error(`Embedding API error (${response.status}): ${errorText || response.statusText}`);
        }
        const data = (await response.json());
        if (!Array.isArray(data.data)) {
            throw new Error("Invalid embedding response: missing data array");
        }
        const embeddings = data.data.sort((a, b) => a.index - b.index).map((item) => item.embedding);
        if (embeddings.length !== documents.length) {
            throw new Error(`Embedding count mismatch: expected ${documents.length}, got ${embeddings.length}`);
        }
        return embeddings;
    }
    generatePlaceholderEmbedding(text) {
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
}
//# sourceMappingURL=embedder.js.map