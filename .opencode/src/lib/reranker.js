import { InferenceSession, Tensor } from "onnxruntime-node";
import { existsSync } from "fs";
import { dirname, join } from "path";
import { BertTokenizer } from "./bert-tokenizer.js";
export class CrossEncoderReranker {
    constructor(config) {
        this.session = null;
        this.tokenizer = null;
        this.initialized = false;
        this.config = config;
    }
    async initialize() {
        if (this.initialized) {
            return { ok: true };
        }
        try {
            if (!existsSync(this.config.modelPath)) {
                return {
                    ok: false,
                    error: `Reranker model not found at ${this.config.modelPath}`,
                };
            }
            this.session = await InferenceSession.create(this.config.modelPath, {
                executionProviders: ["cpu"],
                graphOptimizationLevel: "all",
            });
            const vocabPath = join(dirname(this.config.modelPath), "vocab.txt");
            if (existsSync(vocabPath)) {
                this.tokenizer = new BertTokenizer(vocabPath);
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
                error: error instanceof Error ? error.message : "Failed to initialize reranker",
            };
        }
    }
    async rerank(query, documents) {
        if (!this.initialized || !this.session || !this.tokenizer) {
            throw new Error("Reranker not initialized");
        }
        const scores = [];
        for (const doc of documents) {
            const score = await this.scorePair(query, doc);
            scores.push(score);
        }
        const results = scores
            .map((score, index) => ({ index, score }))
            .sort((a, b) => b.score - a.score);
        return results;
    }
    async scorePair(query, document) {
        if (!this.session || !this.tokenizer) {
            return 0;
        }
        const inputIds = this.tokenizer.encodePair(query, document);
        const seqLength = Math.min(inputIds.length, this.config.maxTokens);
        const truncatedIds = inputIds.slice(0, seqLength);
        while (truncatedIds.length < this.config.maxTokens) {
            truncatedIds.push(this.tokenizer.getPadTokenId());
        }
        const attentionMask = truncatedIds.map(id => id === this.tokenizer.getPadTokenId() ? 0 : 1);
        const inputIdsTensor = new Tensor("int64", BigInt64Array.from(truncatedIds.map(BigInt)), [1, truncatedIds.length]);
        const attentionMaskTensor = new Tensor("int64", BigInt64Array.from(attentionMask.map(BigInt)), [1, attentionMask.length]);
        const tokenTypeIds = [];
        const sepId = this.tokenizer.getSepTokenId();
        const firstSepIndex = truncatedIds.indexOf(sepId);
        for (let i = 0; i < truncatedIds.length; i++) {
            tokenTypeIds.push(i <= firstSepIndex ? 0 : 1);
        }
        const feeds = {
            input_ids: inputIdsTensor,
            attention_mask: attentionMaskTensor,
            token_type_ids: new Tensor("int64", BigInt64Array.from(tokenTypeIds.map(BigInt)), [1, tokenTypeIds.length]),
        };
        const results = await this.session.run(feeds);
        const outputName = this.session.outputNames[0];
        const output = results[outputName];
        const logits = output.data;
        const score = this.sigmoid(logits[0]);
        return score;
    }
    sigmoid(x) {
        return 1 / (1 + Math.exp(-x));
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
export function applyReranking(results, rerankScores, topK) {
    const limit = topK ?? results.length;
    return rerankScores
        .slice(0, limit)
        .map(r => results[r.index]);
}
export async function rerankResults(query, results, reranker, topK) {
    if (results.length === 0) {
        return [];
    }
    const documents = results.map(r => r.text);
    const rerankResults = await reranker.rerank(query, documents);
    const limit = topK ?? results.length;
    return rerankResults
        .slice(0, limit)
        .map(r => ({
        ...results[r.index],
        rerankScore: r.score,
    }));
}
const defaultReranker = null;
export function createReranker(config) {
    return new CrossEncoderReranker(config);
}
export class HeuristicReranker {
    rerank(query, results) {
        const queryTerms = this.extractTerms(query.toLowerCase());
        const queryIdentifiers = this.extractIdentifiers(query);
        const scored = results.map((result, index) => {
            const docText = result.chunkText.toLowerCase();
            const docTerms = this.extractTerms(docText);
            let score = 0;
            score += this.termOverlap(queryTerms, docTerms) * 0.3;
            score += this.identifierMatch(queryIdentifiers, docText) * 0.3;
            score += this.exactMatchBonus(query, docText) * 0.2;
            score += (result.similarity ?? 0) * 0.1;
            score += this.positionBonus(index, results.length) * 0.1;
            return {
                ...result,
                rerankScore: score,
            };
        });
        return scored.sort((a, b) => b.rerankScore - a.rerankScore);
    }
    extractTerms(text) {
        return new Set(text
            .replace(/[^\w\s]/g, " ")
            .split(/\s+/)
            .filter(t => t.length > 2));
    }
    extractIdentifiers(text) {
        const identifiers = [];
        const pattern = /\b([a-zA-Z_$][a-zA-Z0-9_$]*)\b/g;
        let match;
        while ((match = pattern.exec(text)) !== null) {
            if (match[1].length > 2) {
                identifiers.push(match[1].toLowerCase());
            }
        }
        return identifiers;
    }
    termOverlap(queryTerms, docTerms) {
        let overlap = 0;
        for (const term of queryTerms) {
            if (docTerms.has(term)) {
                overlap++;
            }
        }
        return queryTerms.size > 0 ? overlap / queryTerms.size : 0;
    }
    identifierMatch(queryIdentifiers, docText) {
        if (queryIdentifiers.length === 0)
            return 0;
        let matches = 0;
        for (const id of queryIdentifiers) {
            if (docText.includes(id)) {
                matches++;
            }
        }
        return matches / queryIdentifiers.length;
    }
    exactMatchBonus(query, docText) {
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
    positionBonus(index, total) {
        if (total <= 1)
            return 1;
        return 1 - (index / total) * 0.5;
    }
}
export function createHeuristicReranker() {
    return new HeuristicReranker();
}
//# sourceMappingURL=reranker.js.map