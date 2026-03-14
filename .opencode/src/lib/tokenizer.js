const IDENTIFIER_PATTERNS = [
    /\b(?:function|class|const|let|var|async|static)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g,
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
const identifierCache = new Map();
const IDENTIFIER_CACHE_MAX = 500;
export function extractIdentifiers(code) {
    const cacheKey = code.length > 1000 ? `${code.length}:${code.slice(0, 100)}:${code.slice(-100)}` : code;
    const cached = identifierCache.get(cacheKey);
    if (cached)
        return cached;
    const identifiers = new Set();
    for (const pattern of IDENTIFIER_PATTERNS) {
        pattern.lastIndex = 0;
        let match;
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
        if (firstKey)
            identifierCache.delete(firstKey);
    }
    identifierCache.set(cacheKey, identifiers);
    return identifiers;
}
export function estimateTokens(text) {
    return Math.ceil(text.length / 3);
}
export function truncateToTokenLimit(text, maxTokens) {
    const maxChars = maxTokens * 3;
    if (text.length <= maxChars)
        return text;
    return text.slice(0, maxChars);
}
export function tokenizeForFTS(text) {
    return text
        .toLowerCase()
        .split(/[\s\W_]+/)
        .filter((token) => token.length > 1);
}
export function calculateBM25(docTokens, queryTokens, docLength, avgDocLength) {
    const k1 = 1.5;
    const b = 0.75;
    let score = 0;
    const docTokenSet = new Set(docTokens);
    const tokenFreqs = new Map();
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
export function normalizeBM25(score, maxPossibleScore) {
    if (maxPossibleScore === 0)
        return 0;
    return Math.min(1, score / maxPossibleScore);
}
export function rrfScore(vectorRank, bm25Rank, k = 60) {
    const vectorContrib = 1 / (k + vectorRank);
    const bm25Contrib = 1 / (k + bm25Rank);
    return vectorContrib + bm25Contrib;
}
const FILE_TYPE_MULTIPLIERS = {
    ts: 1.2, tsx: 1.2,
    js: 1.0, jsx: 1.0,
    py: 1.1,
    java: 1.0, go: 1.0, rs: 1.0, rb: 1.0,
    md: 0.8,
};
export function getFileTypeMultiplier(filePath) {
    const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
    return FILE_TYPE_MULTIPLIERS[ext] ?? 1.0;
}
export function getIdentifierBoost(identifierMatches, identifierBoost) {
    if (identifierMatches === 0)
        return 1.0;
    return 1.0 + identifierMatches * (identifierBoost - 1.0);
}
const FTS_SPECIAL_CHARS = /[:"()'*]/g;
export function prepareFTSQuery(query) {
    const prepared = query.replace(FTS_SPECIAL_CHARS, " ");
    const words = prepared.split(/\s+/).filter((w) => w.length > 0);
    if (words.length === 0)
        return "";
    if (words.length === 1) {
        return `${words[0]}*`;
    }
    return words.join(" OR ");
}
export function clearCaches() {
    identifierCache.clear();
}
//# sourceMappingURL=tokenizer.js.map