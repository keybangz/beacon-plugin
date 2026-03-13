/**
 * Performance benchmarking tool for Beacon operations
 * Measures and reports search, indexing, and database performance metrics
 *
 * This tool helps identify bottlenecks and track performance improvements over time
 */
import { openDatabase } from "./db.js";
import { BeaconConfig } from "./types.js";
import { Embedder } from "./embedder.js";
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
export declare function benchmarkSearch(db: ReturnType<typeof openDatabase>, embedder: Embedder, config: BeaconConfig, queries: string[], iterations?: number): Promise<BenchmarkResult[]>;
/**
 * Benchmark database operations
 */
export declare function benchmarkDatabase(db: ReturnType<typeof openDatabase>, config: BeaconConfig): Promise<BenchmarkResult[]>;
/**
 * Format benchmark results for display
 */
export declare function formatBenchmarkResults(results: BenchmarkResult[]): string;
/**
 * Generate performance report
 */
export declare function generatePerformanceReport(results: BenchmarkResult[], title?: string): string;
export {};
//# sourceMappingURL=benchmark.d.ts.map