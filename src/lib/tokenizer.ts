/**
 * Tokenization and ranking algorithms
 * Implements BM25, identifier extraction, and RRF (Reciprocal Rank Fusion)
 */

/**
 * Extract programming identifiers from code (variables, functions, classes)
 * @param code - Source code
 * @returns Set of extracted identifiers
 */
export function extractIdentifiers(code: string): Set<string> {
  const identifiers: Set<string> = new Set();

  // Match identifiers in various contexts:
  // - function declarations: function name | const name = function
  // - class declarations: class ClassName
  // - variable declarations: const/let/var name
  // - property access: obj.property
  // - imports: import { Name } from
  const patterns: RegExp[] = [
    /\b(?:function|class|const|let|var|async|static)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g,
    /import\s+(?:\{[^}]*\}|\*\s+as\s+[a-zA-Z_$][a-zA-Z0-9_$]*|[a-zA-Z_$][a-zA-Z0-9_$]*)/g,
    /from\s+['"]([^'"]+)['"]/g,
    /(?:^|\s)([a-zA-Z_$][a-zA-Z0-9_$]*)\s*(?:=|:|\()/gm,
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    // Reset lastIndex for global patterns
    pattern.lastIndex = 0;

    while ((match = pattern.exec(code)) !== null) {
      // Extract identifier from capturing groups
      for (let i = 1; i < match.length; i++) {
        if (match[i]) {
          const id = match[i].toLowerCase();
          // Filter out common keywords
          if (!isCommonKeyword(id)) {
            identifiers.add(id);
          }
        }
      }
    }
  }

  return identifiers;
}

/**
 * Common programming keywords to ignore
 * @param word - Word to check
 * @returns True if word is a common keyword
 */
function isCommonKeyword(word: string): boolean {
  const keywords: Set<string> = new Set([
    "function",
    "class",
    "const",
    "let",
    "var",
    "async",
    "await",
    "static",
    "return",
    "if",
    "else",
    "for",
    "while",
    "do",
    "switch",
    "case",
    "break",
    "continue",
    "try",
    "catch",
    "finally",
    "throw",
    "new",
    "this",
    "super",
    "extends",
    "implements",
    "interface",
    "type",
    "enum",
    "export",
    "import",
    "from",
    "default",
    "public",
    "private",
    "protected",
    "readonly",
    "abstract",
  ]);

  return keywords.has(word);
}

/**
 * Prepare text for FTS by tokenizing
 * @param text - Text to tokenize
 * @returns Array of tokens
 */
export function tokenizeForFTS(text: string): string[] {
  // Convert to lowercase and split on whitespace and punctuation
  return text
    .toLowerCase()
    .split(/[\s\W_]+/)
    .filter((token) => token.length > 1); // Filter out single chars
}

/**
 * Calculate BM25 score for a document
 * Simplified BM25 implementation
 * @param docTokens - Tokens in document
 * @param queryTokens - Query tokens to match
 * @param docLength - Number of tokens in document
 * @param avgDocLength - Average document length
 * @returns BM25 score
 */
export function calculateBM25(
  docTokens: string[],
  queryTokens: string[],
  docLength: number,
  avgDocLength: number
): number {
  const k1: number = 1.5; // Term frequency saturation parameter
  const b: number = 0.75; // Length normalization parameter

  let score: number = 0;
  const docTokenSet: Set<string> = new Set(docTokens);

  for (const token of queryTokens) {
    if (docTokenSet.has(token)) {
      const tokenFreq: number = docTokens.filter((t) => t === token).length;

      // BM25 formula: log(1 + ((k1 + 1) * f(qi, D)) / (k1 * (1 - b + b * (|D| / avgdl)) + f(qi, D)))
      const numerator: number = (k1 + 1) * tokenFreq;
      const denominator: number =
        k1 * (1 - b + b * (docLength / avgDocLength)) + tokenFreq;

      score += Math.log(1 + numerator / denominator);
    }
  }

  return score;
}

/**
 * Normalize BM25 score to 0-1 range
 * @param score - Raw BM25 score
 * @param maxPossibleScore - Maximum possible score for this query
 * @returns Normalized score
 */
export function normalizeBM25(
  score: number,
  maxPossibleScore: number
): number {
  if (maxPossibleScore === 0) return 0;
  return Math.min(1, score / maxPossibleScore);
}

/**
 * Calculate Reciprocal Rank Fusion score
 * Combines multiple ranking systems
 * @param vectorRank - Rank from vector search (1-based)
 * @param bm25Rank - Rank from BM25 (1-based)
 * @param k - RRF constant (default 60)
 * @returns Combined score
 */
export function rrfScore(
  vectorRank: number,
  bm25Rank: number,
  k: number = 60
): number {
  const vectorContrib: number = 1 / (k + vectorRank);
  const bm25Contrib: number = 1 / (k + bm25Rank);
  return vectorContrib + bm25Contrib;
}

/**
 * Get file type multiplier for boost
 * Some file types are more important for search
 * @param filePath - File path
 * @returns Multiplier (1.0 = default)
 */
export function getFileTypeMultiplier(filePath: string): number {
  const ext: string = filePath.split(".").pop()?.toLowerCase() ?? "";

  const multipliers: Record<string, number> = {
    ts: 1.2, // TypeScript
    tsx: 1.2,
    js: 1.0,
    jsx: 1.0,
    py: 1.1, // Python
    java: 1.0,
    go: 1.0,
    rs: 1.0,
    rb: 1.0,
    md: 0.8, // Markdown lower weight
  };

  return multipliers[ext] ?? 1.0;
}

/**
 * Get identifier boost score
 * @param identifierMatches - Number of identifiers that matched
 * @param identifierBoost - Boost factor from config
 * @returns Boost score
 */
export function getIdentifierBoost(
  identifierMatches: number,
  identifierBoost: number
): number {
  if (identifierMatches === 0) return 1.0;
  return 1.0 + identifierMatches * (identifierBoost - 1.0);
}

/**
 * Prepare query for FTS search
 * Escapes special characters and expands query
 * @param query - User query
 * @returns Prepared FTS query
 */
export function prepareFTSQuery(query: string): string {
  // Escape special FTS characters
  let prepared: string = query.replace(/[:"()]/g, " ");

  // Split into words and add phrase search operators
  const words: string[] = prepared
    .split(/\s+/)
    .filter((w) => w.length > 0);

  // Create a query with OR operators for flexibility
  return words.join(" OR ");
}
