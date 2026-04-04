/**
 * Code chunking strategies
 * Splits code into semantic chunks for embedding
 */

export interface ChunkResult {
  text: string;
  start_line: number;
  end_line: number;
}

interface SemanticBoundary {
  line: number;
  type: "function" | "class" | "interface" | "import" | "export" | "comment";
  name?: string;
}

const FUNCTION_PATTERNS = [
  /^\s*(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/,
  /^\s*(?:export\s+)?(?:public|private|protected)?\s*(?:async\s+)?([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\([^)]*\)\s*(?::\s*[^{]+)?\s*\{/,
  /^\s*(?:export\s+)?const\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[a-zA-Z_$][a-zA-Z0-9_$]*)\s*(?::\s*[^{]+)?\s*=>\s*/,
  /^\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:\s*(?:async\s+)?(?:function\s+)?\([^)]*\)\s*(?::\s*[^{]+)?\s*\{/,
];

const CLASS_PATTERNS = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/,
  /^\s*(?:export\s+)?interface\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/,
  /^\s*(?:export\s+)?type\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=/,
  /^\s*(?:export\s+)?enum\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/,
];

const IMPORT_PATTERN = /^\s*(?:import|export)\s+/;
const COMMENT_PATTERN = /^\s*(?:\/\/|\/\*|\*|<!--)/;

function detectSemanticBoundaries(lines: string[]): SemanticBoundary[] {
  const boundaries: SemanticBoundary[] = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    for (const pattern of FUNCTION_PATTERNS) {
      const match = line.match(pattern);
      if (match) {
        boundaries.push({ line: i, type: "function", name: match[1] });
        break;
      }
    }
    
    for (const pattern of CLASS_PATTERNS) {
      const match = line.match(pattern);
      if (match) {
        const type = line.includes("interface") ? "interface" : 
                     line.includes("class") ? "class" : 
                     line.includes("enum") ? "export" : "export";
        boundaries.push({ line: i, type: type as any, name: match[1] });
        break;
      }
    }
    
    if (IMPORT_PATTERN.test(line)) {
      boundaries.push({ line: i, type: "import" });
    }
    
    if (COMMENT_PATTERN.test(line)) {
      boundaries.push({ line: i, type: "comment" });
    }
  }
  
  return boundaries;
}

/**
 * Count approximate tokens in text (conservative estimation for code)
 * Uses ~3 characters per token instead of 4, because code is denser than
 * prose: short identifiers, operators, and punctuation each consume a token
 * even though they contain few characters. The conservative estimate prevents
 * chunks from exceeding embedding-model context limits.
 * @param text - Text to count
 * @returns Approximate token count
 */
function estimateTokens(text: string): number {
  // 3 chars/token is a safer estimate for source code.
  // The standard BPE 4 chars/token rule applies to natural-language prose;
  // code typically sits closer to 2-3 chars/token due to dense punctuation
  // and single-character operators. Using 3 gives a ~33 % safety margin that
  // prevents embedding input-length-over-context errors.
  return Math.ceil(text.length / 3);
}

/**
 * Split code by syntax boundaries (functions, classes, imports, etc.)
 * @param code - Source code
 * @param maxTokens - Maximum tokens per chunk
 * @param overlapTokens - Overlap between chunks
 * @param contextLimit - Optional embedding model context limit (applies 80% safety margin)
 * @returns Array of code chunks
 */export function chunkCode(
  code: string,
  maxTokens: number = 512,
  overlapTokens: number = 50,
  contextLimit?: number
): ChunkResult[] {
  const effectiveMaxTokens = contextLimit !== undefined
    ? Math.min(maxTokens, Math.floor(contextLimit * 0.8))
    : maxTokens;
  
  const maxChars = effectiveMaxTokens * 3;
  const lines: string[] = code.split("\n");
  
  const boundaries = detectSemanticBoundaries(lines);
  
  if (boundaries.length === 0) {
    return chunkByTokenLimit(lines, effectiveMaxTokens, overlapTokens, maxChars);
  }
  
  return chunkBySemanticBoundaries(lines, boundaries, effectiveMaxTokens, maxChars);
}

function chunkBySemanticBoundaries(
  lines: string[],
  boundaries: SemanticBoundary[],
  maxTokens: number,
  maxChars: number
): ChunkResult[] {
  const chunks: ChunkResult[] = [];
  
  const significantBoundaries = boundaries.filter(
    b => b.type === "function" || b.type === "class" || b.type === "interface"
  );
  
  if (significantBoundaries.length === 0) {
    return chunkByTokenLimit(lines, maxTokens, 50, maxChars);
  }
  
  let currentStart = 0;
  
  for (let i = 0; i < significantBoundaries.length; i++) {
    const boundary = significantBoundaries[i];
    const nextBoundary = significantBoundaries[i + 1];
    
    const endLine = nextBoundary ? nextBoundary.line - 1 : lines.length - 1;
    const chunkLines = lines.slice(currentStart, endLine + 1);
    const chunkText = chunkLines.join("\n");
    
    if (chunkText.trim().length === 0) {
      currentStart = endLine + 1;
      continue;
    }
    
    const chunkTokens = estimateTokens(chunkText);
    
    if (chunkTokens > maxTokens) {
      const subChunks = chunkByTokenLimit(chunkLines, maxTokens, 50, maxChars);
      for (const sub of subChunks) {
        chunks.push({
          text: sub.text,
          start_line: currentStart + sub.start_line,
          end_line: currentStart + sub.end_line,
        });
      }
    } else {
      let finalText = chunkText;
      if (finalText.length > maxChars) {
        finalText = truncateToMaxChars(finalText, maxChars, currentStart);
      }
      const actualLines = finalText.split("\n").length;
      chunks.push({
        text: finalText,
        start_line: currentStart,
        end_line: Math.min(currentStart + actualLines - 1, endLine),
      });
    }
    
    currentStart = endLine + 1;
  }
  
  if (currentStart < lines.length) {
    const remainingLines = lines.slice(currentStart);
    const remainingText = remainingLines.join("\n");
    if (remainingText.trim()) {
      const remainingTokens = estimateTokens(remainingText);
      if (remainingTokens > maxTokens) {
        const subChunks = chunkByTokenLimit(remainingLines, maxTokens, 50, maxChars);
        for (const sub of subChunks) {
          chunks.push({
            text: sub.text,
            start_line: currentStart + sub.start_line,
            end_line: currentStart + sub.end_line,
          });
        }
      } else {
        chunks.push({
          text: remainingText.length > maxChars 
            ? truncateToMaxChars(remainingText, maxChars, currentStart)
            : remainingText,
          start_line: currentStart,
          end_line: lines.length - 1,
        });
      }
    }
  }
  
  return chunks.filter(c => c.start_line <= c.end_line && c.text.trim());
}

function chunkByTokenLimit(
  lines: string[],
  maxTokens: number,
  overlapTokens: number,
  maxChars: number
): ChunkResult[] {
  const chunks: ChunkResult[] = [];
  let currentChunk: string[] = [];
  let chunkStartLine: number = 0;
  let chunkTokens: number = 0;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineTokens = estimateTokens(line);
    
    if (
      currentChunk.length > 0 &&
      chunkTokens + lineTokens > maxTokens &&
      currentChunk.join("\n").length > 0
    ) {
      let chunkText = currentChunk.join("\n");
      if (chunkText.trim()) {
        if (chunkText.length > maxChars) {
          chunkText = truncateToMaxChars(chunkText, maxChars, chunkStartLine);
        }
        const actualLines = chunkText.split("\n");
        chunks.push({
          text: chunkText,
          start_line: chunkStartLine,
          end_line: chunkStartLine + actualLines.length - 1,
        });
      }
      
      const overlapLineCount = Math.max(0, Math.ceil(overlapTokens / 20));
      const overlapLines = currentChunk.slice(-overlapLineCount);
      chunkStartLine = i - overlapLines.length;
      currentChunk = overlapLines;
      chunkTokens = estimateTokens(currentChunk.join("\n"));
    }
    
    currentChunk.push(line);
    chunkTokens += lineTokens;
  }
  
  if (currentChunk.length > 0 && currentChunk.join("\n").trim()) {
    let chunkText = currentChunk.join("\n");
    if (chunkText.length > maxChars) {
      chunkText = truncateToMaxChars(chunkText, maxChars, chunkStartLine);
    }
    const actualLines = chunkText.split("\n");
    chunks.push({
      text: chunkText,
      start_line: chunkStartLine,
      end_line: chunkStartLine + actualLines.length - 1,
    });
  }
  
  return chunks.filter(c => c.start_line <= c.end_line && c.text.trim());
}

/**
 * Truncate chunk text to maximum character limit at line or token boundary
 * Prefers to break at line boundaries, then token boundaries, then hard truncation
 */
function truncateToMaxChars(text: string, maxChars: number, startLine: number): string {
  if (text.length <= maxChars) return text;
  
  // Try truncating at line boundaries first
  const lines = text.split("\n");
  let result = "";
  for (const line of lines) {
    if ((result + line).length > maxChars) {
      break;
    }
    result += (result ? "\n" : "") + line;
  }
  
  // If still too long, truncate at character boundary
  if (result.length > maxChars) {
    result = result.slice(0, maxChars);
  }
  
  return result || text.slice(0, maxChars);
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
