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
 * Count approximate tokens in text (rough estimation)
 * Uses word count * 1.3 as token estimate
 * @param text - Text to count
 * @returns Approximate token count
 */
function estimateTokens(text: string): number {
  const words = text.split(/\s+/).length;
  return Math.ceil(words * 1.3);
}

/**
 * Split code by syntax boundaries (functions, classes, imports, etc.)
 * @param code - Source code
 * @param maxTokens - Maximum tokens per chunk
 * @param overlapTokens - Overlap between chunks
 * @returns Array of code chunks
 */export function chunkCode(
  code: string,
  maxTokens: number = 512,
  overlapTokens: number = 50
): ChunkResult[] {
  const lines: string[] = code.split("\n");
  const chunks: ChunkResult[] = [];
  let currentChunk: string[] = [];
  let chunkStartLine: number = 0;
  let chunkTokens: number = 0;
  let overlapLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line: string = lines[i];
    const lineTokens: number = estimateTokens(line);

    // Check if adding this line would exceed max tokens
    if (
      currentChunk.length > 0 &&
      chunkTokens + lineTokens > maxTokens &&
      currentChunk.join("\n").length > 0
    ) {
      // Save current chunk
      const chunkText: string = currentChunk.join("\n");
      if (chunkText.trim()) {
        chunks.push({
          text: chunkText,
          start_line: chunkStartLine,
          end_line: i - 1,
        });
      }

      // Prepare overlap for next chunk
      overlapLines = currentChunk.slice(
        Math.max(0, currentChunk.length - Math.ceil(overlapTokens / 20))
      );
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
export function validateChunks(chunks: ChunkResult[]): void {
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
