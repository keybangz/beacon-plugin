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
        try {
            // Clear existing index
            this.db.clear();
            // Get all repository files
            const allFiles = getRepoFiles(this.repoRoot);
            const filesToIndex = allFiles.filter((file) => shouldIndex(file, this.config.indexing.include, this.config.indexing.exclude));
            const filesIndexed = await this.indexFiles(filesToIndex);
            this.db.setSyncState("last_full_sync", new Date().toISOString());
            this.db.setSyncState("sync_status", "idle");
            return { success: true, filesIndexed };
        }
        catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            this.db.setSyncState("sync_error", `Full index failed: ${errorMsg}`);
            this.db.setSyncState("sync_status", "error");
            throw error;
        }
    }
    /**
     * Perform differential sync since last index
     * Only re-indexes files modified since last sync
     */
    async performDiffSync() {
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
            const filesIndexed = await this.indexFiles(filesToIndex);
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
    }
    /**
     * Index a batch of files
     * Chunks, embeds, and stores in database
     */
    async indexFiles(filePaths) {
        const { concurrency } = this.config.indexing;
        const batch = [];
        // Collect all file content
        for (const filePath of filePaths) {
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
                batch.push({ path: filePath, content, hash });
            }
            catch (err) {
                // Skip files that can't be read
            }
        }
        // Process in batches
        let filesProcessed = 0;
        const batchSize = Math.max(1, concurrency); // Use concurrency as batch size
        for (let i = 0; i < batch.length; i += batchSize) {
            const batchSlice = batch.slice(i, i + batchSize);
            // Chunk all files in batch
            const allChunks = [];
            for (const file of batchSlice) {
                const chunks = chunkCode(file.content, this.config.chunking.max_tokens, this.config.chunking.overlap_tokens);
                allChunks.push({
                    path: file.path,
                    chunks: chunks.map((c) => ({
                        text: c.text,
                        start_line: c.start_line,
                        end_line: c.end_line,
                    })),
                    hash: file.hash,
                });
            }
            // Prepare texts for embedding
            const textsToEmbed = [];
            const chunkMapping = [];
            for (let fileIdx = 0; fileIdx < allChunks.length; fileIdx++) {
                const file = allChunks[fileIdx];
                for (let chunkIdx = 0; chunkIdx < file.chunks.length; chunkIdx++) {
                    textsToEmbed.push(file.chunks[chunkIdx].text);
                    chunkMapping.push({ fileIndex: fileIdx, chunkIndex: chunkIdx });
                }
            }
            // Get embeddings
            if (textsToEmbed.length > 0) {
                const embeddings = await this.embedder.embedDocuments(textsToEmbed);
                // Group embeddings by file
                const embeddingsByFile = new Map();
                for (let j = 0; j < embeddings.length; j++) {
                    const { fileIndex, chunkIndex } = chunkMapping[j];
                    if (!embeddingsByFile.has(fileIndex)) {
                        embeddingsByFile.set(fileIndex, []);
                    }
                    embeddingsByFile.get(fileIndex).push({
                        chunkIndex,
                        embedding: embeddings[j],
                    });
                }
                // Store in database
                for (const [fileIdx, embeddingsData] of embeddingsByFile.entries()) {
                    const file = allChunks[fileIdx];
                    // Sort embeddings by chunk index
                    embeddingsData.sort((a, b) => a.chunkIndex - b.chunkIndex);
                    const embeddings_array = embeddingsData.map((e) => e.embedding);
                    this.db.insertChunks(file.path, file.chunks, embeddings_array, file.hash);
                    filesProcessed++;
                }
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
            // Chunk the file
            const chunks = chunkCode(content, this.config.chunking.max_tokens, this.config.chunking.overlap_tokens);
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
    // Create embedder
    const embedder = new Embedder(config.embedding);
    // Create coordinator
    const coordinator = new IndexCoordinator(config, db, embedder, repoRoot);
    return { coordinator, db };
}
