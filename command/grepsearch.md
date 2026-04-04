Use the `grepsearch` tool to perform hybrid semantic + BM25 keyword search. This is an alias for the `search` tool and accepts identical parameters.

## Parameters
- `query` (required): Natural language or keyword search query
- `topK` (optional): Number of results to return (default: 10, max: 50)
- `threshold` (optional): Minimum similarity score 0.0–1.0 (default: 0.35)
- `pathPrefix` (optional): Restrict results to files under this path prefix
- `noHybrid` (optional): Set `true` for pure vector search (disables BM25 component)

## Examples
- Find function definition: `query="function parseConfig"`
- Find error handling: `query="try catch error handler", pathPrefix="src"`
- Exact identifier: `query="BeaconPlugin", noHybrid=true`

## Notes
- Identical to `/search` — use either interchangeably
- Results include file path, line range, score, and code snippet
