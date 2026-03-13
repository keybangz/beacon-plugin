/**
 * Tokenization and ranking algorithms
 * Implements BM25, identifier extraction, and RRF (Reciprocal Rank Fusion)
 */
/**
 * Estimate token count for a text string
 * Uses ~3 chars/token which is conservative for code (dense with punctuation/operators)
 * @param text - Text to estimate
 * @returns Approximate token count
 */
export declare function estimateTokens(text: string): number;
/**
 * Truncate text to fit within a token limit
 * Uses character estimation (3 chars/token) for quick truncation
 * @param text - Text to truncate
 * @param maxTokens - Maximum tokens allowed
 * @returns Truncated text
 */
export declare function truncateToTokenLimit(text: string, maxTokens: number): string;
/**
 * Extract programming identifiers from code (variables, functions, classes)
 * @param code - Source code
 * @returns Set of extracted identifiers
 */
export declare function extractIdentifiers(code: string): Set<string>;
/**
 * Prepare text for FTS by tokenizing
 * @param text - Text to tokenize
 * @returns Array of tokens
 */
export declare function tokenizeForFTS(text: string): string[];
/**
 * Calculate BM25 score for a document
 * Simplified BM25 implementation
 * @param docTokens - Tokens in document
 * @param queryTokens - Query tokens to match
 * @param docLength - Number of tokens in document
 * @param avgDocLength - Average document length
 * @returns BM25 score
 */
export declare function calculateBM25(docTokens: string[], queryTokens: string[], docLength: number, avgDocLength: number): number;
/**
 * Normalize BM25 score to 0-1 range
 * @param score - Raw BM25 score
 * @param maxPossibleScore - Maximum possible score for this query
 * @returns Normalized score
 */
export declare function normalizeBM25(score: number, maxPossibleScore: number): number;
/**
 * Calculate Reciprocal Rank Fusion score
 * Combines multiple ranking systems
 * @param vectorRank - Rank from vector search (1-based)
 * @param bm25Rank - Rank from BM25 (1-based)
 * @param k - RRF constant (default 60)
 * @returns Combined score
 */
export declare function rrfScore(vectorRank: number, bm25Rank: number, k?: number): number;
/**
 * Get file type multiplier for boost
 * Some file types are more important for search
 * @param filePath - File path
 * @returns Multiplier (1.0 = default)
 */
export declare function getFileTypeMultiplier(filePath: string): number;
/**
 * Get identifier boost score
 * @param identifierMatches - Number of identifiers that matched
 * @param identifierBoost - Boost factor from config
 * @returns Boost score
 */
export declare function getIdentifierBoost(identifierMatches: number, identifierBoost: number): number;
/**
 * Prepare query for FTS search
 * Escapes special characters and expands query
 * @param query - User query
 * @returns Prepared FTS query
 */
export declare function prepareFTSQuery(query: string): string;
//# sourceMappingURL=tokenizer.d.ts.map