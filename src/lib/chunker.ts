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

// Python: def and class at any indentation level
const PYTHON_FUNCTION_PATTERN = /^\s*(?:async\s+)?def\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/;
const PYTHON_CLASS_PATTERN = /^\s*class\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*[:(]/;

// Go: func declarations (including methods)
const GO_FUNCTION_PATTERN = /^\s*func\s+(?:\([^)]+\)\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/;

// Rust: fn, impl, trait, struct, enum
const RUST_FUNCTION_PATTERN = /^\s*(?:pub(?:\([^)]+\))?\s+)?(?:async\s+)?fn\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*[<(]/;
const RUST_ITEM_PATTERN = /^\s*(?:pub(?:\([^)]+\))?\s+)?(?:impl|trait|struct|enum|mod)\s+([a-zA-Z_][a-zA-Z0-9_]*)/;

// C# / Java: class/interface/struct/enum declarations
const CSHARP_CLASS_PATTERN = /^\s*(?:(?:public|private|protected|internal|static|abstract|sealed|partial)\s+)*(?:class|interface|struct|enum|record)\s+([a-zA-Z_][a-zA-Z0-9_]*)/;

// C# / Java: method declarations (return type + name + open paren)
// Matches: [modifiers] ReturnType MethodName(
const CSHARP_METHOD_PATTERN = /^\s*(?:(?:public|private|protected|internal|static|virtual|override|abstract|async|new|sealed|partial|extern)\s+)+(?:[\w<>\[\]?]+\s+)+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/;

// C / C++: function definitions (return type + name + parens + brace)
const C_FUNCTION_PATTERN = /^\s*(?:static\s+|inline\s+|extern\s+)?(?:const\s+)?\w[\w\s*]+\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\([^;]*\)\s*(?:const\s*)?\{?\s*$/;

// Ruby: def and class
const RUBY_FUNCTION_PATTERN = /^\s*def\s+(?:self\.)?([a-zA-Z_][a-zA-Z0-9_?!]*)/;
const RUBY_CLASS_PATTERN = /^\s*(?:class|module)\s+([A-Z][a-zA-Z0-9_]*)/;

// PHP: function and class
const PHP_FUNCTION_PATTERN = /^\s*(?:public|private|protected|static|abstract|\s)*function\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/;
const PHP_CLASS_PATTERN = /^\s*(?:abstract\s+|final\s+)?(?:class|interface|trait|enum)\s+([a-zA-Z_][a-zA-Z0-9_]*)/;

// Swift: func, class, struct, protocol, extension
const SWIFT_FUNCTION_PATTERN = /^\s*(?:public|private|internal|fileprivate|open|\s)*(?:override\s+)?(?:static\s+|class\s+)?func\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*[<(]/;
const SWIFT_TYPE_PATTERN = /^\s*(?:public|private|internal|fileprivate|open|\s)*(?:class|struct|enum|protocol|extension|actor)\s+([a-zA-Z_][a-zA-Z0-9_]*)/;

// Kotlin: fun, class, object, interface
const KOTLIN_FUNCTION_PATTERN = /^\s*(?:public|private|protected|internal|override|suspend|\s)*fun\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*[<(]/;
const KOTLIN_CLASS_PATTERN = /^\s*(?:public|private|protected|internal|abstract|sealed|data|open|\s)*(?:class|interface|object|enum\s+class)\s+([a-zA-Z_][a-zA-Z0-9_]*)/;

function detectSemanticBoundaries(lines: string[], filePath?: string): SemanticBoundary[] {
  const boundaries: SemanticBoundary[] = [];
  const ext = filePath ? (filePath.split(".").pop()?.toLowerCase() ?? "") : "";

  // Determine which pattern sets to use based on file extension
  const isJsTs = ext === "ts" || ext === "tsx" || ext === "js" || ext === "jsx" || ext === "mjs" || ext === "cjs" || ext === "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let matched = false;

    if (ext === "py") {
      let m = line.match(PYTHON_FUNCTION_PATTERN);
      if (m) { boundaries.push({ line: i, type: "function", name: m[1] }); matched = true; }
      else { m = line.match(PYTHON_CLASS_PATTERN); if (m) { boundaries.push({ line: i, type: "class", name: m[1] }); matched = true; } }
    } else if (ext === "go") {
      const m = line.match(GO_FUNCTION_PATTERN);
      if (m) { boundaries.push({ line: i, type: "function", name: m[1] }); matched = true; }
    } else if (ext === "rs") {
      let m = line.match(RUST_FUNCTION_PATTERN);
      if (m) { boundaries.push({ line: i, type: "function", name: m[1] }); matched = true; }
      else { m = line.match(RUST_ITEM_PATTERN); if (m) { boundaries.push({ line: i, type: "class", name: m[1] }); matched = true; } }
    } else if (ext === "cs" || ext === "java") {
      let m = line.match(CSHARP_CLASS_PATTERN);
      if (m) { boundaries.push({ line: i, type: "class", name: m[1] }); matched = true; }
      else { m = line.match(CSHARP_METHOD_PATTERN); if (m) { boundaries.push({ line: i, type: "function", name: m[1] }); matched = true; } }
    } else if (ext === "c" || ext === "cpp" || ext === "cc" || ext === "cxx") {
      const m = line.match(C_FUNCTION_PATTERN);
      if (m) { boundaries.push({ line: i, type: "function", name: m[1] }); matched = true; }
    } else if (ext === "rb") {
      let m = line.match(RUBY_FUNCTION_PATTERN);
      if (m) { boundaries.push({ line: i, type: "function", name: m[1] }); matched = true; }
      else { m = line.match(RUBY_CLASS_PATTERN); if (m) { boundaries.push({ line: i, type: "class", name: m[1] }); matched = true; } }
    } else if (ext === "php") {
      let m = line.match(PHP_FUNCTION_PATTERN);
      if (m) { boundaries.push({ line: i, type: "function", name: m[1] }); matched = true; }
      else { m = line.match(PHP_CLASS_PATTERN); if (m) { boundaries.push({ line: i, type: "class", name: m[1] }); matched = true; } }
    } else if (ext === "swift") {
      let m = line.match(SWIFT_FUNCTION_PATTERN);
      if (m) { boundaries.push({ line: i, type: "function", name: m[1] }); matched = true; }
      else { m = line.match(SWIFT_TYPE_PATTERN); if (m) { boundaries.push({ line: i, type: "class", name: m[1] }); matched = true; } }
    } else if (ext === "kt" || ext === "kts") {
      let m = line.match(KOTLIN_FUNCTION_PATTERN);
      if (m) { boundaries.push({ line: i, type: "function", name: m[1] }); matched = true; }
      else { m = line.match(KOTLIN_CLASS_PATTERN); if (m) { boundaries.push({ line: i, type: "class", name: m[1] }); matched = true; } }
    } else if (isJsTs) {
      // JS/TS patterns as default for recognized JS/TS extensions and unknown extensions
      for (const pattern of FUNCTION_PATTERNS) {
        const m = line.match(pattern);
        if (m) { boundaries.push({ line: i, type: "function", name: m[1] }); matched = true; break; }
      }
      if (!matched) {
        for (const pattern of CLASS_PATTERNS) {
          const m = line.match(pattern);
          if (m) {
            const type = line.includes("interface") ? "interface" :
                         line.includes("class") ? "class" :
                         line.includes("enum") ? "export" : "export";
            boundaries.push({ line: i, type: type as any, name: m[1] });
            matched = true;
            break;
          }
        }
      }
    }

    // Import and comment patterns apply to all languages
    if (!matched && IMPORT_PATTERN.test(line)) {
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
  contextLimit?: number,
  filePath?: string
): ChunkResult[] {
  const effectiveMaxTokens = contextLimit !== undefined
    ? Math.min(maxTokens, Math.floor(contextLimit * 0.8))
    : maxTokens;
  
  const maxChars = effectiveMaxTokens * 3;
  const lines: string[] = code.split("\n");
  
  const boundaries = detectSemanticBoundaries(lines, filePath);
  
  if (boundaries.length === 0) {
    return chunkByTokenLimit(lines, effectiveMaxTokens, overlapTokens, maxChars);
  }
  
  return chunkBySemanticBoundaries(lines, boundaries, effectiveMaxTokens, overlapTokens, maxChars);
}

function chunkBySemanticBoundaries(
  lines: string[],
  boundaries: SemanticBoundary[],
  maxTokens: number,
  overlapTokens: number,
  maxChars: number
): ChunkResult[] {
  const chunks: ChunkResult[] = [];
  
  const significantBoundaries = boundaries.filter(
    b => b.type === "function" || b.type === "class" || b.type === "interface"
  );
  
  if (significantBoundaries.length === 0) {
    return chunkByTokenLimit(lines, maxTokens, overlapTokens, maxChars);
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
      const subChunks = chunkByTokenLimit(chunkLines, maxTokens, overlapTokens, maxChars);
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
        const subChunks = chunkByTokenLimit(remainingLines, maxTokens, overlapTokens, maxChars);
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
