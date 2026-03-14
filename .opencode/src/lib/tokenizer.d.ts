export declare function extractIdentifiers(code: string): Set<string>;
export declare function estimateTokens(text: string): number;
export declare function truncateToTokenLimit(text: string, maxTokens: number): string;
export declare function tokenizeForFTS(text: string): string[];
export declare function calculateBM25(docTokens: string[], queryTokens: string[], docLength: number, avgDocLength: number): number;
export declare function normalizeBM25(score: number, maxPossibleScore: number): number;
export declare function rrfScore(vectorRank: number, bm25Rank: number, k?: number): number;
export declare function getFileTypeMultiplier(filePath: string): number;
export declare function getIdentifierBoost(identifierMatches: number, identifierBoost: number): number;
export declare function prepareFTSQuery(query: string): string;
export declare function clearCaches(): void;
//# sourceMappingURL=tokenizer.d.ts.map