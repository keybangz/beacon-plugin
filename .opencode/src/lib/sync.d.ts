/**
 * Indexing and synchronization
 * Handles full index, diff-based catch-up, and incremental updates
 */
import type { BeaconConfig } from "./types.js";
import { Embedder } from "./embedder.js";
import { BeaconDatabase } from "./db.js";
/**
 * Terminate any running indexing operation
 * Uses database flag for cross-module communication
 * @param db - Database instance for state management
 * @returns true if an operation was aborted, false if nothing was running
 */
export declare function terminateIndexer(db?: BeaconDatabase): boolean;
/**
 * Returns true if an index operation is currently running
 * @param db - Database instance for state checking
 * @returns true if indexing is in progress
 */
export declare function isIndexerRunning(db?: BeaconDatabase): boolean;
/**
 * Check if termination was requested
 * @param db - Database instance for state checking
 * @returns true if termination was requested
 */
export declare function shouldTerminate(db: BeaconDatabase): boolean;
/**
 * Index coordinator - orchestrates full and incremental indexing
 */
export declare class IndexCoordinator {
    private config;
    private db;
    private embedder;
    private repoRoot;
    constructor(config: BeaconConfig, db: BeaconDatabase, embedder: Embedder, repoRoot: string);
    /**
     * Perform full index from scratch
     * Deletes existing database and re-indexes everything
     */
    performFullIndex(): Promise<{
        success: boolean;
        filesIndexed: number;
    }>;
    /**
     * Perform differential sync since last index
     * Only re-indexes files modified since last sync
     */
    performDiffSync(): Promise<{
        success: boolean;
        filesIndexed: number;
    }>;
    /**
     * Index a batch of files with parallel embedding requests
     * Chunks, embeds, and stores in database
     */
    private indexFiles;
    /**
     * Re-embed a single file after edit
     */
    reembedFile(filePath: string): Promise<boolean>;
    /**
     * Garbage collect deleted files
     */
    garbageCollect(): number;
}
/**
 * Initialize indexing (create database, set up coordinator)
 */
export declare function initializeIndexing(config: BeaconConfig, repoRoot: string): {
    coordinator: IndexCoordinator;
    db: BeaconDatabase;
};
//# sourceMappingURL=sync.d.ts.map