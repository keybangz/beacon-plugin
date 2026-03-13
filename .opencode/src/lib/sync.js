/**
 * Indexing and synchronization
 * Handles full index, diff-based catch-up, and incremental updates
 */
import { existsSync, mkdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { chunkCode } from "./chunker.js";
import { Embedder } from "./embedder.js";
import { getRepoFiles, getModifiedFilesSince, getFileHash } from "./git.js";
import { shouldIndex } from "./ignore.js";
import { BeaconDatabase } from "./db.js";
/** Shared abort controller for terminating a running sync */
let activeAbortController = null;
/**
 * Terminate any running indexing operation
 * @returns true if an operation was aborted, false if nothing was running
 */
export function terminateIndexer() {
    if (activeAbortController) {
        activeAbortController.abort();
        activeAbortController = null;
        return true;
    }
    return false;
}
/**
 * Returns true if an index operation is currently running
 */
export function isIndexerRunning() {
    return activeAbortController !== null;
}
/**
 * Index coordinator - orchestrates full and incremental indexing
 */
export class IndexCoordinator {
    constructor(config, db, embedder, repoRoot) {
        this.config = config;
        this.db = db;
        this.embedder = embedder;
        this.repoRoot = repoRoot;
    }
    /**
     * Perform full index from scratch
     * Deletes existing database and re-indexes everything
     */
    async performFullIndex() {
        // Register abort controller so terminate-indexer can cancel this
        const abortController = new AbortController();
        activeAbortController = abortController;
        try {
            // Clear existing index
            this.db.clear();
            // Get all repository files
            const allFiles = getRepoFiles(this.repoRoot);
            const filesToIndex = allFiles.filter((file) => shouldIndex(file, this.config.indexing.include, this.config.indexing.exclude));
            const filesIndexed = await this.indexFiles(filesToIndex, abortController.signal);
            this.db.setSyncState("last_full_sync", new Date().toISOString());
            this.db.setSyncState("sync_status", "idle");
            return { success: true, filesIndexed };
        }
        catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            if (error?.name === "AbortError") {
                this.db.setSyncState("sync_status", "idle");
                this.db.setSyncState("sync_error", "Indexing terminated by user");
                throw error;
            }
            this.db.setSyncState("sync_error", `Full index failed: ${errorMsg}`);
            this.db.setSyncState("sync_status", "error");
            throw error;
        }
        finally {
            if (activeAbortController === abortController) {
                activeAbortController = null;
            }
        }
    }
    /**
     * Perform differential sync since last index
     * Only re-indexes files modified since last sync
     */
    async performDiffSync() {
        const abortController = new AbortController();
        activeAbortController = abortController;
        try {
            const lastSyncIso = this.db.getSyncState("last_full_sync");
            if (!lastSyncIso) {
                // No previous sync, do full index
                return this.performFullIndex();
            }
            // Get files modified since last sync
            const modifiedFiles = getModifiedFilesSince(this.repoRoot, lastSyncIso);
            // Filter by include/exclude patterns
            const filesToIndex = modifiedFiles
                .map((f) => f.path)
                .filter((file) => shouldIndex(file, this.config.indexing.include, this.config.indexing.exclude));
            // Delete old entries for modified files
            for (const file of filesToIndex) {
                this.db.deleteChunks(file);
            }
            // Re-index modified files
            const filesIndexed = await this.indexFiles(filesToIndex, abortController.signal);
            // Also garbage collect deleted files
            const allTrackedFiles = getRepoFiles(this.repoRoot);
            const indexedFiles = this.db.getIndexedFiles();
            for (const indexedFile of indexedFiles) {
                if (!allTrackedFiles.includes(indexedFile)) {
                    this.db.deleteChunks(indexedFile);
                }
            }
            this.db.setSyncState("last_full_sync", new Date().toISOString());
            this.db.setSyncState("sync_status", "idle");
            return { success: true, filesIndexed };
        }
        catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            this.db.setSyncState("sync_error", `Diff sync failed: ${errorMsg}`);
            this.db.setSyncState("sync_status", "error");
            throw error;
        }
        finally {
            if (activeAbortController === abortController) {
                activeAbortController = null;
            }
        }
    }
    /**
     * Index a batch of files with parallel embedding requests
     * Chunks, embeds, and stores in database
     */
    async indexFiles(filePaths, signal) {
        const { concurrency } = this.config.indexing;
        // Collect all file content that needs indexing
        const filesToProcess = [];
        for (const filePath of filePaths) {
            // Check for cancellation
            if (signal?.aborted) {
                throw Object.assign(new Error("Indexing aborted"), { name: "AbortError" });
            }
            try {
                const fullPath = join(this.repoRoot, filePath);
                // Check file size
                const stat = statSync(fullPath);
                if (stat.size / 1024 > this.config.indexing.max_file_size_kb) {
                    continue;
                }
                const content = readFileSync(fullPath, "utf-8");
                const hash = getFileHash(content);
                // Check if file has changed
                const storedHash = this.db.getFileHash(filePath);
                if (storedHash === hash) {
                    continue; // File hasn't changed
                }
                filesToProcess.push({ path: filePath, content, hash });
            }
            catch {
                // Skip files that can't be read
            }
        }
        if (filesToProcess.length === 0) {
            return 0;
        }
        // Pre-chunk all files - pass context_limit for safety margin
        const chunkedFiles = filesToProcess.map((file) => {
            const chunks = chunkCode(file.content, this.config.chunking.max_tokens, this.config.chunking.overlap_tokens, this.config.embedding.context_limit);
            return {
                path: file.path,
                hash: file.hash,
                chunks: chunks.map((c) => ({
                    text: c.text,
                    start_line: c.start_line,
                    end_line: c.end_line,
                })),
            };
        }).filter((f) => f.chunks.length > 0);
        // Process in parallel batches (concurrency = number of parallel embed requests)
        let filesProcessed = 0;
        for (let i = 0; i < chunkedFiles.length; i += concurrency) {
            // Check for cancellation at each batch boundary
            if (signal?.aborted) {
                throw Object.assign(new Error("Indexing aborted"), { name: "AbortError" });
            }
            const batch = chunkedFiles.slice(i, i + concurrency);
            // Fire parallel embedding requests — one per file in the batch
            const embeddingResults = await Promise.all(batch.map(async (file) => {
                const texts = file.chunks.map((c) => c.text);
                try {
                    const embeddings = await this.embedder.embedDocuments(texts);
                    return { file, embeddings, error: null };
                }
                catch (err) {
                    return { file, embeddings: null, error: err };
                }
            }));
            // Store results in database
            for (const { file, embeddings, error } of embeddingResults) {
                if (error || !embeddings) {
                    // Skip files that failed to embed
                    continue;
                }
                this.db.insertChunks(file.path, file.chunks, embeddings, file.hash);
                filesProcessed++;
            }
        }
        return filesProcessed;
    }
    /**
     * Re-embed a single file after edit
     */
    async reembedFile(filePath) {
        try {
            const fullPath = join(this.repoRoot, filePath);
            if (!existsSync(fullPath)) {
                this.db.deleteChunks(filePath);
                return true;
            }
            const content = readFileSync(fullPath, "utf-8");
            const hash = getFileHash(content);
            // Check if file has actually changed
            const storedHash = this.db.getFileHash(filePath);
            if (storedHash === hash) {
                return false; // No change
            }
            // Chunk the file - pass context_limit for safety margin
            const chunks = chunkCode(content, this.config.chunking.max_tokens, this.config.chunking.overlap_tokens, this.config.embedding.context_limit);
            if (chunks.length === 0) {
                this.db.deleteChunks(filePath);
                return true;
            }
            // Get embeddings
            const texts = chunks.map((c) => c.text);
            const embeddings = await this.embedder.embedDocuments(texts);
            // Delete old chunks
            this.db.deleteChunks(filePath);
            // Insert new chunks
            this.db.insertChunks(filePath, chunks.map((c) => ({
                text: c.text,
                start_line: c.start_line,
                end_line: c.end_line,
            })), embeddings, hash);
            return true;
        }
        catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            console.error(`Failed to reembed ${filePath}: ${errorMsg}`);
            return false;
        }
    }
    /**
     * Garbage collect deleted files
     */
    garbageCollect() {
        try {
            const allTrackedFiles = getRepoFiles(this.repoRoot);
            const indexedFiles = this.db.getIndexedFiles();
            let deletedCount = 0;
            for (const indexedFile of indexedFiles) {
                if (!allTrackedFiles.includes(indexedFile)) {
                    this.db.deleteChunks(indexedFile);
                    deletedCount++;
                }
            }
            return deletedCount;
        }
        catch (error) {
            console.error("Garbage collection failed:", error);
            return 0;
        }
    }
}
/**
 * Initialize indexing (create database, set up coordinator)
 */
export function initializeIndexing(config, repoRoot) {
    // Ensure storage directory exists
    const storageDir = join(repoRoot, config.storage.path);
    if (!existsSync(storageDir)) {
        mkdirSync(storageDir, { recursive: true });
    }
    // Open database
    const dbPath = join(storageDir, "embeddings.db");
    const db = new BeaconDatabase(dbPath, config.embedding.dimensions);
    // Create embedder — use model's context_limit if set, otherwise chunking.max_tokens.
    // This provides a safety net to hard-truncate any chunk that exceeds the model's context.
    const effectiveContextLimit = config.embedding.context_limit ?? config.chunking.max_tokens;
    const embedder = new Embedder(config.embedding, effectiveContextLimit);
    // Create coordinator
    const coordinator = new IndexCoordinator(config, db, embedder, repoRoot);
    return { coordinator, db };
}
//# sourceMappingURL=sync.js.map