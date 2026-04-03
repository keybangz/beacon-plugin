import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import { join } from "path";
import { existsSync } from "fs";
import { openDatabase } from "../lib/db.js";
import { Embedder } from "../lib/embedder.js";
import { loadConfig } from "../lib/config.js";
import { getBeaconRoot } from "../lib/repo-root.js";
import { formatBenchmarkResults, generatePerformanceReport } from "../lib/benchmark.js";
import { PerformanceTimer } from "../lib/cache.js";

const _export: ToolDefinition = tool({
  description: "Measure and analyze Beacon search and indexing performance",
  args: {
    action: tool.schema
      .enum(["cache", "metrics", "benchmark", "report"])
      .optional()
      .describe("Performance metric to measure"),
    verbose: tool.schema
      .boolean()
      .optional()
      .describe("Show detailed output"),
  },
  async execute(args: any, context: any): Promise<string> {
    try {
      const repoRoot = getBeaconRoot(context?.worktree);
      const config = loadConfig(repoRoot);

      const dbPath = join(config.storage.path, "embeddings.db");
      const storagePath = config.storage.path;

      if (!existsSync(dbPath)) {
        return JSON.stringify({
          error: "Index not found. Run 'reindex' tool to create the index.",
        });
      }

      // Open the DB with HNSW disabled — this tool only reads metrics/stats,
      // so we must NOT attempt to load the HNSW index file that the pool's live
      // instance already holds open (which causes a lock-contention hang).
      const db = openDatabase(dbPath, config.embedding.dimensions, false);

      // Embedder is only needed for the benchmark action.
      // Instantiating it unconditionally boots an ONNX worker thread and then
      // tears it down — ~1-3s of pure overhead for cache/metrics/report actions.
      const action = args?.action;
      const needsEmbedder = action === "benchmark";
      const effectiveContextLimit = config.embedding.context_limit ?? config.chunking.max_tokens;
      const embedder = needsEmbedder
        ? new Embedder(config.embedding, effectiveContextLimit, storagePath)
        : null;

      let output = "";

      try {
        switch (action) {
          case "cache": {
            const stats = db.getCacheStats();

            output += "\n📦 CACHE STATISTICS\n";
            output += `├─ Size: ${stats.size} entries\n`;
            output += `├─ Hits: ${stats.hits}\n`;
            output += `├─ Misses: ${stats.misses}\n`;
            output += `├─ Hit Rate: ${(stats.hitRate * 100).toFixed(2)}%\n`;
            output += `├─ Uptime: ${Math.round(stats.uptime / 1000)}s\n`;
            output += `└─ Total Queries: ${stats.hits + stats.misses}\n`;

            if (args?.verbose) {
              output += "\n💡 CACHE ANALYSIS\n";
              if (stats.hitRate > 0.8) {
                output += "✅ Excellent cache hit rate - searches are well-optimized\n";
              } else if (stats.hitRate > 0.5) {
                output += "⚠️  Good cache hit rate - consider repeated searches\n";
              } else {
                output += "📌 Low cache hit rate - cache may not be effective for current usage\n";
              }
            }
            break;
          }

          case "metrics": {
            const dbMetrics = db.getMetrics();

            output += "\n📊 SEARCH METRICS\n";

            if (Object.keys(dbMetrics).length === 0) {
              output += "No metrics collected yet. Run some searches first.\n";
            } else {
              for (const [name, stats] of Object.entries(dbMetrics)) {
                output += `├─ ${name}\n`;
                output += `│  ├─ Samples: ${stats.count}\n`;
                output += `│  ├─ Avg: ${stats.avg.toFixed(2)}ms\n`;
                output += `│  ├─ Min: ${stats.min.toFixed(2)}ms\n`;
                output += `│  └─ Max: ${stats.max.toFixed(2)}ms\n`;
              }
            }

            if (args?.verbose) {
              const cacheStats = db.getCacheStats();
              output += "\n💾 CACHE STATUS\n";
              output += `├─ Hit Rate: ${(cacheStats.hitRate * 100).toFixed(2)}%\n`;
              output += `├─ Entries: ${cacheStats.size}\n`;
              output += `└─ Total Operations: ${cacheStats.hits + cacheStats.misses}\n`;
            }
            break;
          }

          case "benchmark": {
            output += "\n⏱️  RUNNING PERFORMANCE BENCHMARK...\n\n";

            const queries = ["function", "class", "export", "interface"];
            const timer = new PerformanceTimer("full_benchmark");

            for (const query of queries) {
              const queryTimer = new PerformanceTimer(`query: ${query}`);

              // Use embedQuery (not embedDocuments) for single query embedding.
              const embedding = await embedder!.embedQuery(query);
              queryTimer.mark("embed");

              const results = db.search(
                embedding,
                5,
                config.search?.similarity_threshold ?? 0.01,
                query,
                config
              );
              queryTimer.mark("search");

              const elapsed = queryTimer.elapsed();
              const hitRate = db.getCacheStats().hitRate;

              output += `🔍 "${query}"\n`;
              output += `   ⏱️  ${elapsed.toFixed(2)}ms (${results.length} results)\n`;
              output += `   💾 Cache: ${(hitRate * 100).toFixed(1)}%\n`;
            }

            const totalTime = timer.elapsed();
            output += `\n✅ Benchmark completed in ${totalTime.toFixed(2)}ms\n`;
            break;
          }

          case "report": {
            const stats = db.getStats();
            const cacheStats = db.getCacheStats();
            const metrics = db.getMetrics();

            // Build a real BenchmarkResult array from collected DB metrics so the
            // report section shows actual data rather than "No operations recorded yet".
            const benchmarkResults = Object.entries(metrics).map(([name, m]) => ({
              operation: name,
              duration: m.avg,
              metadata: {
                iterations: m.count,
                opsPerSecond: m.avg > 0 ? 1000 / m.avg : 0,
              },
            }));
            output += generatePerformanceReport(benchmarkResults, "Beacon Performance Report");

            output += "\n🗂️  DATABASE STATUS\n";
            output += `├─ Total Chunks: ${stats.total_chunks}\n`;
            output += `├─ Indexed Files: ${stats.files_indexed}\n`;
            output += `└─ Database Size: ${stats.database_size_mb.toFixed(2)}MB\n`;

            output += "\n💾 CACHE STATUS\n";
            output += `├─ Size: ${cacheStats.size}/200 entries\n`;
            output += `├─ Hit Rate: ${(cacheStats.hitRate * 100).toFixed(2)}%\n`;
            output += `├─ Total Hits: ${cacheStats.hits}\n`;
            output += `└─ Total Misses: ${cacheStats.misses}\n`;

            if (Object.keys(metrics).length > 0) {
              output += "\n📊 OPERATION METRICS\n";
              for (const [name, m] of Object.entries(metrics)) {
                output += `├─ ${name}: ${m.avg.toFixed(2)}ms avg (${m.count} samples)\n`;
              }
            }

            output += "\n✅ Report generated at " + new Date().toISOString() + "\n";
            break;
          }

          default: {
            // No action specified — show a summary of all available stats.
            const stats = db.getStats();
            const cacheStats = db.getCacheStats();
            output = JSON.stringify({
              message: "Specify action: cache | metrics | benchmark | report",
              quick_summary: {
                files_indexed: stats.files_indexed,
                total_chunks: stats.total_chunks,
                database_size_mb: stats.database_size_mb.toFixed(2),
                cache_hit_rate: `${(cacheStats.hitRate * 100).toFixed(1)}%`,
                cache_entries: cacheStats.size,
              },
            }, null, 2);
          }
        }
      } finally {
        if (embedder) await embedder.close();
        await db.close();
      }

      return output;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return JSON.stringify({ error: `Performance tool failed: ${errorMessage}` });
    }
  },
});
export default _export;
