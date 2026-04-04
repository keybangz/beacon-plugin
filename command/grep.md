Use the `grep` tool (alias: `grepsearch`) to perform hybrid semantic + BM25 keyword search — a direct intelligent replacement for `grep`.

## Parameters
- `query` (required): Pattern, keyword, or natural language description to search for
- `topK` (optional): Number of results (default: 10, max: 50)
- `threshold` (optional): Minimum similarity score 0.0–1.0 (default: 0.35)
- `pathPrefix` (optional): Limit search to files under this path
- `noHybrid` (optional): `true` for pure vector search, `false` for BM25-only

## Examples
- Find usage of a function: `query="parseConfig function"`
- Find all error handlers: `query="catch error throw"`
- Search in specific dir: `query="database query", pathPrefix="src/lib"`
- Exact string match boost: `query="MY_CONSTANT_NAME", noHybrid=false`

## How it replaces grep
Beacon automatically intercepts shell commands like:
- `grep -r "pattern" .`
- `grep -rn "text" src/`
And routes them through hybrid search instead, returning semantically relevant results with proper context.

## Notes
- Combines vector similarity with BM25 keyword scoring via Reciprocal Rank Fusion (RRF)
- Results include file path, line number, relevance score, and code context
- For exact string matching, use `/search` with `noHybrid=true`
