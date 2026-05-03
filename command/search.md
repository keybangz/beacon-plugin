Use the `search` tool to perform hybrid semantic + keyword code search across the indexed codebase.

## Parameters
- `query` (required): Natural language or keyword search query
- `topK` (optional): Number of results to return (default: 10, max: 50)
- `threshold` (optional): Minimum similarity score 0.0–1.0 (default: 0.35)
- `pathPrefix` (optional): Restrict results to files under this path prefix (e.g. `src/lib`)
- `noHybrid` (optional): Set `true` to disable BM25 keyword component and use pure vector search
- `literal` (optional): Exact substring match (grep-like). Skips embeddings. Best for finding specific strings, variable names, error messages.

## Examples
- Basic semantic search: `query="authentication middleware"`
- Scoped to directory: `query="error handling", pathPrefix="src/lib"`
- High-precision search: `query="database connection pool", threshold=0.6`
- Keyword-only boost: `query="TODO fixme", noHybrid=false`
- Find all TODOs: `query="TODO" literal=true`
- Find exact string in directory: `query="useEffect" literal=true pathPrefix="src/components/"`

## Output
Returns ranked results with file path, line number, score, and matching code snippet. Results are sorted by hybrid RRF score combining semantic similarity and BM25 keyword match.

## Notes
- Requires the index to be built first (use `/reindex` if no results appear)
- Automatically triggered on grep-like shell commands as a replacement
- Use `/grepsearch` as an alias for the same functionality
- **Search modes:**
  - `hybrid` (default): Combines semantic embeddings + BM25 keyword search
  - `vector-only`: Pure semantic search when `noHybrid=true`
  - `bm25-only`: Keyword-only search when embeddings are disabled
  - `bm25-fallback`: Keyword fallback when embedding server is unavailable
  - `literal`: Exact substring match (grep-like) when `literal=true` — bypasses embeddings entirely
