/**
 * Code chunking strategies
 * Splits code into semantic chunks for embedding
 */
/**
 * Count approximate tokens in text (conservative estimation for code)
 * Uses ~3 characters per token instead of 4, because code is denser than
 * prose: short identifiers, operators, and punctuation each consume a token
 * even though they contain few characters. The conservative estimate prevents
 * chunks from exceeding embedding-model context limits.
 * @param text - Text to count
 * @returns Approximate token count
 */
function estimateTokens(text) {
    // 3 chars/token is a safer estimate for source code.
    // The standard BPE 4 chars/token rule applies to natural-language prose;
    // code typically sits closer to 2-3 chars/token due to dense punctuation
    // and single-character operators. Using 3 gives a ~33 % safety margin that
    // prevents Ollama "input length exceeds context length" errors.
    return Math.ceil(text.length / 3);
}
/**
 * Split code by syntax boundaries (functions, classes, imports, etc.)
 * @param code - Source code
 * @param maxTokens - Maximum tokens per chunk
 * @param overlapTokens - Overlap between chunks
 * @param contextLimit - Optional embedding model context limit (applies 80% safety margin)
 * @returns Array of code chunks
 */ export function chunkCode(code, maxTokens = 512, overlapTokens = 50, contextLimit) {
    // Apply safety margin when context limit is provided
    // Use 80% safety margin to account for tokenization differences between
    // our character estimate (3 chars/token) and the model's actual BPE tokenizer
    const effectiveMaxTokens = contextLimit !== undefined
        ? Math.min(maxTokens, Math.floor(contextLimit * 0.8))
        : maxTokens;
    const lines = code.split("\n");
    const chunks = [];
    let currentChunk = [];
    let chunkStartLine = 0;
    let chunkTokens = 0;
    let overlapLines = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineTokens = estimateTokens(line);
        // Check if adding this line would exceed effective max tokens
        if (currentChunk.length > 0 &&
            chunkTokens + lineTokens > effectiveMaxTokens &&
            currentChunk.join("\n").length > 0) {
            // Save current chunk
            const chunkText = currentChunk.join("\n");
            if (chunkText.trim()) {
                chunks.push({
                    text: chunkText,
                    start_line: chunkStartLine,
                    end_line: i - 1,
                });
            }
            // Prepare overlap for next chunk
            overlapLines = currentChunk.slice(Math.max(0, currentChunk.length - Math.ceil(overlapTokens / 20)));
            chunkStartLine = i - overlapLines.length;
            currentChunk = overlapLines;
            chunkTokens = estimateTokens(currentChunk.join("\n"));
        }
        currentChunk.push(line);
        chunkTokens += lineTokens;
    }
    // Add remaining chunk
    if (currentChunk.length > 0 && currentChunk.join("\n").trim()) {
        chunks.push({
            text: currentChunk.join("\n"),
            start_line: chunkStartLine,
            end_line: lines.length - 1,
        });
    }
    // Ensure chunks don't have start >= end
    return chunks.filter((chunk) => chunk.start_line <= chunk.end_line);
}
/**
 * Validate chunk structure
 * @param chunks - Chunks to validate
 * @throws Error if chunks are invalid
 */
export function validateChunks(chunks) {
    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        if (chunk.start_line < 0) {
            throw new Error(`Chunk ${i}: start_line must be >= 0`);
        }
        if (chunk.end_line < chunk.start_line) {
            throw new Error(`Chunk ${i}: end_line must be >= start_line`);
        }
        if (!chunk.text || !chunk.text.trim()) {
            throw new Error(`Chunk ${i}: text cannot be empty`);
        }
    }
}
//# sourceMappingURL=chunker.js.map