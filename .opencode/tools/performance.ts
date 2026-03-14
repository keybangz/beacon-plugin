/**
 * OpenCode Tool: Beacon Performance Monitor
 *
 * Provides real-time performance metrics for search, caching, and indexing operations.
 * Use this tool to measure and optimize Beacon plugin performance.
 */

import { tool } from "@opencode-ai/plugin";
import { join } from "path";
import { readFileSync } from "fs";
import { openDatabase } from "../src/lib/db.js";
import { Embedder } from "../src/lib/embedder.js";
import { loadConfig } from "../src/lib/config.js";
import { getRepoRoot } from "../src/lib/repo-root.js";
import { formatBenchmarkResults, generatePerformanceReport } from "../src/lib/benchmark.js";
import { PerformanceTimer } from "../src/lib/cache.js";

export default tool({
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
  async execute(options: any, context: any): Promise<string> {
    const repoRoot = getRepoRoot(context?.worktree);
    const config = loadConfig(repoRoot);

    const dbPath = join(repoRoot, (config as any).storage?.path || "", "embeddings.db");
    const storagePath = join(repoRoot, (config as any).storage?.path || "");
    const db = openDatabase(dbPath, (config as any).embedding?.dimensions || 1024);
    const embedder = new Embedder(config.embedding, undefined, storagePath);

    let output = "";

    try {
      switch (options.action) {
        case "cache": {
          // Show cache statistics
          const stats = db.getCacheStats();

          output += "\n📦 CACHE STATISTICS\n";
          output += `├─ Size: ${stats.size} entries\n`;
          output += `├─ Hits: ${stats.hits}\n`;
          output += `├─ Misses: ${stats.misses}\n`;
          output += `├─ Evictions: ${stats.evictions}\n`;
          output += `├─ Hit Rate: ${(stats.hitRate * 100).toFixed(2)}%\n`;
          output += `└─ Uptime: ${(stats.uptime / 1000 / 60).toFixed(2)} minutes\n`;

          if (options.verbose) {
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
          // Show search and database metrics
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

          if (options.verbose) {
            // Also show cache stats
            const cacheStats = db.getCacheStats();
            output += "\n💾 CACHE STATUS\n";
            output += `├─ Hit Rate: ${(cacheStats.hitRate * 100).toFixed(2)}%\n`;
            output += `├─ Entries: ${cacheStats.size}\n`;
            output += `└─ Total Operations: ${cacheStats.hits + cacheStats.misses}\n`;
          }
          break;
        }

        case "benchmark": {
          // Run a quick benchmark
          output += "\n⏱️  RUNNING PERFORMANCE BENCHMARK...\n\n";

          const queries = ["function", "class", "export", "interface"];
          const timer = new PerformanceTimer("full_benchmark");

          for (const query of queries) {
            const queryTimer = new PerformanceTimer(`query: ${query}`);

            const embedding = await embedder.embedDocuments([query]);
            queryTimer.mark("embed");

            const results = db.search(
              embedding[0],
              5,
              0.5,
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
          // Generate comprehensive performance report
          const stats = db.getStats();
          const cacheStats = db.getCacheStats();
          const metrics = db.getMetrics();

          output += generatePerformanceReport([], "Beacon Performance Report");

          output += "\n🗂️  DATABASE STATUS\n";
          output += `├─ Total Chunks: ${stats.total_chunks}\n`;
          output += `├─ Indexed Files: ${stats.files_indexed}\n`;
          output += `└─ Database Size: ${stats.database_size_mb.toFixed(2)}MB\n`;

          output += "\n💾 CACHE STATUS\n";
          output += `├─ Size: ${cacheStats.size}/${1000} entries\n`;
          output += `├─ Hit Rate: ${(cacheStats.hitRate * 100).toFixed(2)}%\n`;
          output += `├─ Total Hits: ${cacheStats.hits}\n`;
          output += `├─ Total Misses: ${cacheStats.misses}\n`;
          output += `└─ Evictions: ${cacheStats.evictions}\n`;

          if (Object.keys(metrics).length > 0) {
            output += "\n📊 OPERATION METRICS\n";
            for (const [name, stats] of Object.entries(metrics)) {
              output += `├─ ${name}: ${stats.avg.toFixed(2)}ms avg (${stats.count} samples)\n`;
            }
          }

          output += "\n✅ Report generated at " + new Date().toISOString() + "\n";
          break;
        }
      }
    } finally {
      db.close();
    }

    return output;
  },
});
