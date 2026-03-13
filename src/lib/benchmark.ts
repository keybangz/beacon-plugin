/**
 * Performance benchmarking tool for Beacon operations
 * Measures and reports search, indexing, and database performance metrics
 *
 * This tool helps identify bottlenecks and track performance improvements over time
 */

import { openDatabase } from "../lib/db.js";
import { BeaconConfig } from "../lib/types.js";
import type { SearchResult } from "../lib/types.js";
import { Embedder } from "../lib/embedder.js";
import { PerformanceTimer } from "../lib/cache.js";
import { readFileSync } from "fs";

interface BenchmarkResult {
  operation: string;
  duration: number;
  throughput?: number;
  cacheHit?: boolean;
  metadata?: Record<string, unknown>;
}

/**
 * Benchmark search performance
 */
export async function benchmarkSearch(
  db: ReturnType<typeof openDatabase>,
  embedder: Embedder,
  config: BeaconConfig,
  queries: string[],
  iterations: number = 3
): Promise<BenchmarkResult[]> {
  const results: BenchmarkResult[] = [];

  for (const query of queries) {
    const durations: number[] = [];

    for (let i = 0; i < iterations; i++) {
      const timer = new PerformanceTimer(`search: ${query}`);

      // Get query embedding
      const embeddings = await embedder.embedDocuments([query]);
      const embedding = embeddings[0];
      timer.mark("embedding");

      // Execute search
      const searchResults = db.search(
        embedding,
        10,
        0.5,
        query,
        config
      );
      timer.mark("search_execution");

      durations.push(timer.elapsed());
    }

    const avgDuration = durations.reduce((a, b) => a + b, 0) / durations.length;
    const cacheStats = db.getCacheStats();

    results.push({
      operation: `search: "${query}"`,
      duration: avgDuration,
      metadata: {
        iterations,
        minDuration: Math.min(...durations),
        maxDuration: Math.max(...durations),
        resultsReturned: db.getStats().total_chunks, // Placeholder
        cacheHitRate: cacheStats.hitRate,
      },
    });
  }

  return results;
}

/**
 * Benchmark database operations
 */
export async function benchmarkDatabase(
  db: ReturnType<typeof openDatabase>,
  config: BeaconConfig
): Promise<BenchmarkResult[]> {
  const results: BenchmarkResult[] = [];

  // Benchmark stats retrieval
  const timer1 = new PerformanceTimer("stats");
  const stats = db.getStats();
  results.push({
    operation: "getStats",
    duration: timer1.elapsed(),
    metadata: stats,
  });

  // Benchmark cache stats retrieval
  const timer2 = new PerformanceTimer("cache_stats");
  const cacheStats = db.getCacheStats();
  results.push({
    operation: "getCacheStats",
    duration: timer2.elapsed(),
    metadata: {
      size: cacheStats.size,
      hits: cacheStats.hits,
      misses: cacheStats.misses,
      evictions: cacheStats.evictions,
      hitRate: cacheStats.hitRate,
      uptime: cacheStats.uptime,
    },
  });

  // Benchmark metrics retrieval
  const timer3 = new PerformanceTimer("metrics");
  const metrics = db.getMetrics();
  results.push({
    operation: "getMetrics",
    duration: timer3.elapsed(),
    metadata: metrics,
  });

  return results;
}

/**
 * Format benchmark results for display
 */
export function formatBenchmarkResults(results: BenchmarkResult[]): string {
  let output = "\n┌─ PERFORMANCE BENCHMARK RESULTS ─┐\n\n";

  for (const result of results) {
    output += `📊 ${result.operation}\n`;
    output += `   ⏱️  Duration: ${result.duration.toFixed(2)}ms\n`;

    if (result.throughput !== undefined) {
      output += `   ⚡ Throughput: ${result.throughput.toFixed(2)} ops/sec\n`;
    }

    if (result.metadata) {
      for (const [key, value] of Object.entries(result.metadata)) {
        if (typeof value === "number") {
          output += `   📈 ${key}: ${value.toFixed(2)}\n`;
        } else if (typeof value === "object") {
          output += `   📈 ${key}: ${JSON.stringify(value, null, 2)}\n`;
        } else {
          output += `   📈 ${key}: ${value}\n`;
        }
      }
    }

    output += "\n";
  }

  output += "└─────────────────────────────────┘\n";

  return output;
}

/**
 * Generate performance report
 */
export function generatePerformanceReport(
  results: BenchmarkResult[],
  title: string = "Beacon Performance Report"
): string {
  let report = `\n${"=".repeat(50)}\n`;
  report += `${title}\n`;
  report += `Generated: ${new Date().toISOString()}\n`;
  report += `${"=".repeat(50)}\n\n`;

  // Summary statistics
  const avgDuration =
    results.reduce((sum, r) => sum + r.duration, 0) / results.length;
  const maxDuration = Math.max(...results.map((r) => r.duration));
  const minDuration = Math.min(...results.map((r) => r.duration));

  report += "📊 SUMMARY\n";
  report += `  Operations: ${results.length}\n`;
  report += `  Avg Duration: ${avgDuration.toFixed(2)}ms\n`;
  report += `  Min Duration: ${minDuration.toFixed(2)}ms\n`;
  report += `  Max Duration: ${maxDuration.toFixed(2)}ms\n\n`;

  // Detailed results
  report += "📈 DETAILED RESULTS\n";
  report += formatBenchmarkResults(results);

  return report;
}
