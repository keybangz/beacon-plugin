export interface RerankerConfig {
    modelPath: string;
    maxTokens: number;
    topK: number;
}
export interface RerankResult {
    index: number;
    score: number;
}
export declare class CrossEncoderReranker {
    private session;
    private tokenizer;
    private config;
    private initialized;
    constructor(config: RerankerConfig);
    initialize(): Promise<{
        ok: boolean;
        error?: string;
    }>;
    rerank(query: string, documents: string[]): Promise<RerankResult[]>;
    private scorePair;
    private sigmoid;
    close(): Promise<void>;
    isInitialized(): boolean;
}
export declare function applyReranking<T>(results: T[], rerankScores: RerankResult[], topK?: number): T[];
export declare function rerankResults<T extends {
    text: string;
}>(query: string, results: T[], reranker: CrossEncoderReranker, topK?: number): Promise<(T & {
    rerankScore: number;
})[]>;
export declare function createReranker(config: RerankerConfig): CrossEncoderReranker;
export declare class HeuristicReranker {
    rerank(query: string, results: (SearchResult & {
        bm25Score?: number;
    })[]): (SearchResult & {
        rerankScore: number;
    })[];
    private extractTerms;
    private extractIdentifiers;
    private termOverlap;
    private identifierMatch;
    private exactMatchBonus;
    private positionBonus;
}
import type { SearchResult } from "./types.js";
export declare function createHeuristicReranker(): HeuristicReranker;
//# sourceMappingURL=reranker.d.ts.map