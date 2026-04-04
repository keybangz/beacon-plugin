Use the `performance` tool to view Beacon's indexing and search performance metrics.

## Parameters
- `action` (required): One of:
  - `"cache"` — show embedding cache hit/miss statistics
  - `"metrics"` — show indexing throughput and timing breakdown
  - `"benchmark"` — run a quick search benchmark and return latency stats
  - `"report"` — full performance report combining all of the above
- `verbose` (optional): Set `true` for detailed per-operation timing

## Examples
- Quick overview: `action="metrics"`
- Cache efficiency: `action="cache"`
- Full report: `action="report"`
- Benchmark search latency: `action="benchmark"`
- Detailed timing: `action="report", verbose=true`

## Output Includes
- Embedding throughput (chunks/second)
- Average search latency (ms)
- Cache hit rate (%)
- Index build time (seconds)
- Memory usage estimate

## Notes
- Use this to diagnose slow indexing or search
- High cache miss rates suggest the embedding cache needs warming (run a few searches)
- If benchmark latency is >500ms, consider reducing `indexing.concurrency` or switching to a smaller model
