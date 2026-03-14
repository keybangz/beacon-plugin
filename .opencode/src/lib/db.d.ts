/**
 * Beacon Database Layer
 * SQLite with FTS5 for keyword matching
 * Ported to Bun:SQLite for OpenCode compatibility
 *
 * Schema:
 * - chunks: source code chunks with embeddings and metadata
 * - chunks_fts: FTS5 for full-text search
 * - sync_state: key-value store for indexing state
 */
import type { SearchResult, DimensionCheck, SyncProgress, BeaconConfig } from "./types.js";
/**
 * Beacon database class
 * Handles all database operations: schema creation, chunking, searching, state management
 */
export declare class BeaconDatabase {
    private db;
    private dbPath;
    private dimensions;
    private searchCache;
    private performanceMetrics;
    private hnswIndex;
    private useHNSW;
    constructor(dbPath: string, dimensions: number, useHNSW?: boolean);
    /**
     * Initialize database schema and load extensions
     */
    private init;
    /**
     * Migrate to schema version 2 (add identifiers + FTS5)
     */
    private migrateToV2;
    /**
     * Check if database dimensions match config
     * Note: With BM25-only search, dimensions are not stored in database
     * This method returns ok:true since embeddings are stored in chunks table
     */
    checkDimensions(): DimensionCheck;
    /**
     * Insert or update chunks for a file
     */
    insertChunks(filePath: string, chunks: Array<{
        text: string;
        start_line: number;
        end_line: number;
    }>, embeddings: number[][], fileHash: string): void;
    /**
     * Delete chunks for a file
     */
    deleteChunks(filePath: string): void;
    /**
     * Hybrid search: combines vector, BM25, and identifier matching
     * When noHybrid=true, returns pure vector search results without BM25 combination
     */
    search(queryEmbedding: number[], topK: number, threshold: number, query: string, config: BeaconConfig, pathPrefix?: string, noHybrid?: boolean): SearchResult[];
    /**
     * Vector similarity search
     * Uses HNSW index for O(log n) search when available, falls back to brute-force.
     */
    private vectorSearch;
    /**
     * Brute-force vector similarity search (fallback when HNSW unavailable)
     */
    private vectorSearchBruteForce;
    /**
     * BM25 keyword search using FTS5
     */
    private bm25Search;
    /**
     * FTS-only search (fallback when embeddings unavailable)
     */
    ftsOnlySearch(query: string, limit: number, pathPrefix?: string): SearchResult[];
    /**
     * Combine vector + BM25 results with RRF and hybrid weights
     */
    private combineResults;
    /**
     * Get all files in index
     */
    getIndexedFiles(): string[];
    /**
     * Get file hash from database
     */
    getFileHash(filePath: string): string | null;
    /**
     * Get index statistics
     */
    getStats(): {
        files_indexed: number;
        total_chunks: number;
        database_size_mb: number;
    };
    /**
     * Get sync progress
     */
    getSyncProgress(): SyncProgress;
    /**
     * Set sync progress
     */
    setSyncProgress(progress: Partial<SyncProgress>): void;
    /**
     * Clear sync progress
     */
    clearSyncProgress(): void;
    /**
     * Get sync state value
     */
    getSyncState(key: string): string | null;
    /**
     * Set sync state value
     */
    setSyncState(key: string, value: string): void;
    /**
     * Delete all data from database
     */
    clear(): void;
    /**
     * Record performance metric
     */
    private recordMetric;
    /**
     * Get performance metrics summary
     */
    getMetrics(): Record<string, {
        count: number;
        min: number;
        max: number;
        avg: number;
    }>;
    /**
     * Get cache statistics
     */
    getCacheStats(): ReturnType<typeof this.searchCache.getStats>;
    /**
     * Clear performance metrics
     */
    clearMetrics(): void;
    /**
     * Close database connection
     */
    close(): void;
}
/**
 * Open or create database
 */
export declare function openDatabase(dbPath: string, dimensions: number, useHNSW?: boolean): BeaconDatabase;
//# sourceMappingURL=db.d.ts.map