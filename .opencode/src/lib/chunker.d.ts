/**
 * Code chunking strategies
 * Splits code into semantic chunks for embedding
 */
export interface ChunkResult {
    text: string;
    start_line: number;
    end_line: number;
}
/**
 * Split code by syntax boundaries (functions, classes, imports, etc.)
 * @param code - Source code
 * @param maxTokens - Maximum tokens per chunk
 * @param overlapTokens - Overlap between chunks
 * @param contextLimit - Optional embedding model context limit (applies 80% safety margin)
 * @returns Array of code chunks
 */ export declare function chunkCode(code: string, maxTokens?: number, overlapTokens?: number, contextLimit?: number): ChunkResult[];
/**
 * Validate chunk structure
 * @param chunks - Chunks to validate
 * @throws Error if chunks are invalid
 */
export declare function validateChunks(chunks: ChunkResult[]): void;
//# sourceMappingURL=chunker.d.ts.map