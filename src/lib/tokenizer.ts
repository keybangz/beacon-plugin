import { simpleHash } from "./hash.js";

const IDENTIFIER_PATTERNS = [
  /\b(?:function|class|const|let|var|async|static|interface|type|enum)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g,
  /import\s+(?:\{[^}]*\}|\*\s+as\s+[a-zA-Z_$][a-zA-Z0-9_$]*|[a-zA-Z_$][a-zA-Z0-9_$]*)/g,
  /from\s+['"]([^'"]+)['"]/g,
  /(?:^|\s)([a-zA-Z_$][a-zA-Z0-9_$]*)\s*(?:=|:|\()/gm,
];

const COMMON_KEYWORDS = new Set([
  "function", "class", "const", "let", "var", "async", "await", "static",
  "return", "if", "else", "for", "while", "do", "switch", "case", "break",
  "continue", "try", "catch", "finally", "throw", "new", "this", "super",
  "extends", "implements", "interface", "type", "enum", "export", "import",
  "from", "default", "public", "private", "protected", "readonly", "abstract",
  "null", "undefined", "true", "false", "void", "never", "any", "string",
  "number", "boolean", "object", "symbol", "bigint",
]);

const CODE_SYNONYMS: Record<string, string[]> = {
  // Auth / access
  "auth": ["authentication", "login", "signin", "credential"],
  "authentication": ["auth", "login", "signin", "credential"],
  // Database
  "db": ["database", "sql", "query", "storage"],
  "database": ["db", "sql", "query", "storage"],
  // API / routing
  "api": ["endpoint", "route", "handler", "controller"],
  "handler": ["callback", "listener", "event", "api"],
  // Config
  "config": ["configuration", "settings", "options", "env"],
  "cfg": ["config", "configuration", "settings", "options"],
  "configuration": ["config", "cfg", "settings", "options"],
  "settings": ["config", "cfg", "configuration", "options"],
  // Errors
  "error": ["exception", "err", "fail", "throw"],
  "exception": ["error", "err", "fail", "throw"],
  "err": ["error", "exception", "fail"],
  // Testing
  "test": ["spec", "testing", "unittest", "vitest", "jest"],
  "spec": ["test", "testing", "unittest"],
  // Utilities
  "util": ["utility", "helper", "tool", "lib"],
  "utility": ["util", "helper", "tool"],
  "helper": ["util", "utility", "tool"],
  // Async / concurrency
  "async": ["asynchronous", "promise", "await", "callback"],
  "cb": ["callback", "handler", "listener"],
  "callback": ["cb", "handler", "listener", "async"],
  // HTTP
  "http": ["request", "response", "fetch", "api"],
  "req": ["request", "http", "fetch"],
  "res": ["response", "http", "result"],
  "request": ["req", "http", "fetch"],
  "response": ["res", "http", "result"],
  // Cache / memory
  "cache": ["cached", "memoize", "store", "memory"],
  "mem": ["memory", "cache", "buffer"],
  "memory": ["mem", "cache", "store"],
  "buf": ["buffer", "data", "bytes"],
  "buffer": ["buf", "data", "bytes"],
  // Search / index
  "vector": ["embedding", "semantic", "similarity"],
  "embedding": ["vector", "semantic", "similarity"],
  "search": ["find", "query", "lookup", "match"],
  "index": ["indexed", "indices", "catalog", "directory"],
  // Context
  "ctx": ["context", "scope", "env"],
  "context": ["ctx", "scope"],
  // Message / string
  "msg": ["message", "payload", "data"],
  "message": ["msg", "payload", "event"],
  "str": ["string", "text", "chars"],
  "string": ["str", "text", "chars"],
  // Number / count
  "num": ["number", "count", "int", "integer"],
  "number": ["num", "count", "int"],
  "len": ["length", "count", "size"],
  "length": ["len", "count", "size"],
  // Value / result
  "val": ["value", "result", "data"],
  "value": ["val", "result", "data"],
  // Index / pointer
  "idx": ["index", "position", "offset"],
  "ptr": ["pointer", "reference", "ref"],
  "ref": ["reference", "ptr", "pointer"],
  // Initialize
  "init": ["initialize", "setup", "start", "bootstrap"],
  "initialize": ["init", "setup", "start"],
  "setup": ["init", "initialize", "configure"],
  // Function
  "fn": ["function", "method", "handler"],
  "func": ["function", "method", "handler"],
  "function": ["fn", "func", "method"],
  "method": ["fn", "func", "function"],
  // Connection / pool
  "conn": ["connection", "socket", "link"],
  "connection": ["conn", "socket", "link"],
  "pool": ["connection", "conn", "resources"],
};

const identifierCache = new Map<string, Set<string>>();
const IDENTIFIER_CACHE_MAX = 500;

function generateCacheKey(code: string): string {
  if (code.length <= 1000) {
    return code;
  }
  
  const hash = simpleHash(code);
  const midPoint = Math.floor(code.length / 2);
  const midStart = Math.max(0, midPoint - 25);
  const midEnd = Math.min(code.length, midPoint + 25);
  return `${code.length}:${hash}:${code.slice(0, 30)}:${code.slice(midStart, midEnd)}:${code.slice(-30)}`;
}

export function extractIdentifiers(code: string): Set<string> {
  const cacheKey = generateCacheKey(code);
  
  const cached = identifierCache.get(cacheKey);
  if (cached) return cached;

  const identifiers: Set<string> = new Set();

  for (const pattern of IDENTIFIER_PATTERNS) {
    pattern.lastIndex = 0;

    let match: RegExpExecArray | null;
    while ((match = pattern.exec(code)) !== null) {
      for (let i = 1; i < match.length; i++) {
        if (match[i]) {
          const id = match[i].toLowerCase();
          if (!COMMON_KEYWORDS.has(id) && id.length > 1) {
            identifiers.add(id);
          }
        }
      }
    }
  }

  if (identifierCache.size >= IDENTIFIER_CACHE_MAX) {
    const firstKey = identifierCache.keys().next().value;
    if (firstKey) identifierCache.delete(firstKey);
  }
  identifierCache.set(cacheKey, identifiers);

  return identifiers;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

export function truncateToTokenLimit(text: string, maxTokens: number): string {
  const maxChars = maxTokens * 3;
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars);
}

export function tokenizeForFTS(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s\W_]+/)
    .filter((token) => token.length > 1);
}

export function calculateBM25(
  docTokens: string[],
  queryTokens: string[],
  docLength: number,
  avgDocLength: number
): number {
  const k1 = 1.5;
  const b = 0.75;

  let score = 0;
  const docTokenSet = new Set(docTokens);
  const tokenFreqs = new Map<string, number>();

  for (const token of docTokens) {
    tokenFreqs.set(token, (tokenFreqs.get(token) || 0) + 1);
  }

  for (const token of queryTokens) {
    if (docTokenSet.has(token)) {
      const tokenFreq = tokenFreqs.get(token) || 0;
      const numerator = (k1 + 1) * tokenFreq;
      const denominator = k1 * (1 - b + b * (docLength / avgDocLength)) + tokenFreq;
      score += Math.log(1 + numerator / denominator);
    }
  }

  return score;
}

export function normalizeBM25(score: number, maxPossibleScore: number): number {
  if (maxPossibleScore === 0) return 0;
  return Math.min(1, score / maxPossibleScore);
}

export function rrfScore(vectorRank: number, bm25Rank: number, k = 60): number {
  const vectorContrib = 1 / (k + vectorRank);
  const bm25Contrib = 1 / (k + bm25Rank);
  return vectorContrib + bm25Contrib;
}

const FILE_TYPE_MULTIPLIERS: Record<string, number> = {
  ts: 1.2, tsx: 1.2,
  js: 1.0, jsx: 1.0,
  py: 1.1,
  java: 1.0, go: 1.0, rs: 1.0, rb: 1.0, cs: 1.0, cpp: 1.0, c: 1.0,
  json: 1.0, jsonc: 1.0, yaml: 0.9, yml: 0.9,
  md: 0.9, mdx: 0.9,
  sh: 0.9, bash: 0.9,
};

export function getFileTypeMultiplier(filePath: string): number {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  return FILE_TYPE_MULTIPLIERS[ext] ?? 1.0;
}

export function getIdentifierBoost(identifierMatches: number, identifierBoost: number): number {
  if (identifierMatches === 0) return 1.0;
  return 1.0 + identifierMatches * (identifierBoost - 1.0);
}

// FTS5 operator characters that must be stripped before building a query.
// Includes: quote, colon, parens, single-quote, asterisk, plus, minus, caret, tilde.
const FTS_SPECIAL_CHARS = /[:"()'*+\-^~]/g;

export function prepareFTSQuery(query: string): string {
  const prepared = query.replace(FTS_SPECIAL_CHARS, " ");
  // Filter out words shorter than 2 chars to avoid noise in FTS results
  const words = prepared.split(/\s+/).filter((w) => w.length >= 2);

  if (words.length === 0) return "";

  if (words.length === 1) {
    return `${words[0]}*`;
  }

  // For 2-6 words, use AND (all terms must co-occur) — much more precise than OR.
  // For >6 words (long natural-language queries), fall back to OR to avoid
  // over-constraining FTS and returning zero results.
  if (words.length <= 6) {
    return words.map((w) => `${w}*`).join(" AND ");
  }

  return words.map((w) => `${w}*`).join(" OR ");
}

export function clearCaches(): void {
  identifierCache.clear();
}

export function expandQuery(query: string): string[] {
  const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 0);
  const expanded = new Set<string>(words);
  
  for (const word of words) {
    const synonyms = CODE_SYNONYMS[word];
    if (synonyms) {
      for (const syn of synonyms) {
        expanded.add(syn);
      }
    }
    
    const parts = splitCamelCase(word);
    for (const part of parts) {
      if (part.length > 2) {
        expanded.add(part);
      }
    }
  }
  
  return Array.from(expanded);
}

export function splitCamelCase(str: string): string[] {
  return str
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_-]+/)
    .filter(s => s.length > 0);
}

export function extractCodeTerms(query: string): string[] {
  const terms: string[] = [];
  
  const quotedMatch = query.match(/"([^"]+)"/g);
  if (quotedMatch) {
    for (const m of quotedMatch) {
      terms.push(m.slice(1, -1));
    }
  }
  
  const codePattern = /\b([a-zA-Z_$][a-zA-Z0-9_$]*)\b/g;
  let match;
  while ((match = codePattern.exec(query)) !== null) {
    if (match[1].length > 2 && !COMMON_KEYWORDS.has(match[1].toLowerCase())) {
      terms.push(match[1]);
    }
  }
  
  return [...new Set(terms)];
}

export function buildExpandedQuery(query: string): { 
  original: string; 
  expanded: string[]; 
  codeTerms: string[];
  ftsQuery: string;
} {
  const expanded = expandQuery(query);
  const codeTerms = extractCodeTerms(query);
  
  const allTerms = [...new Set([...expanded, ...codeTerms])];
  const ftsQuery = allTerms.slice(0, 20).join(" OR ");
  
  return {
    original: query,
    expanded,
    codeTerms,
    ftsQuery,
  };
}
