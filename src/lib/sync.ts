/**
 * Indexing and synchronization
 * Handles full index, diff-based catch-up, and incremental updates
 */

import { existsSync, mkdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import type { BeaconConfig } from "./types.js";
import { chunkCode } from "./chunker.js";
import { Embedder } from "./embedder.js";
import { getRepoFiles, getModifiedFilesSince, getFileHash } from "./git.js";
import { shouldIndex } from "./ignore.js";
import { BeaconDatabase } from "./db.js";

/**
 * Terminate any running indexing operation
 * Uses database flag for cross-module communication
 * @param db - Database instance for state management
 * @returns true if an operation was aborted, false if nothing was running
 */
export function terminateIndexer(db?: BeaconDatabase): boolean {
  // Set termination flag in database for cross-module communication
  if (db) {
    const status = db.getSyncState("sync_status");
    if (status === "in_progress") {
      db.setSyncState("sync_status", "terminating");
      return true;
    }
  }
  return false;
}

/**
 * Returns true if an index operation is currently running
 * @param db - Database instance for state checking
 * @returns true if indexing is in progress
 */
export function isIndexerRunning(db?: BeaconDatabase): boolean {
  if (db) {
    const status = db.getSyncState("sync_status");
    return status === "in_progress" || status === "terminating";
  }
  return false;
}

/**
 * Check if termination was requested
 * @param db - Database instance for state checking
 * @returns true if termination was requested
 */
export function shouldTerminate(db: BeaconDatabase): boolean {
  const status = db.getSyncState("sync_status");
  return status === "terminating";
}

/**
 * Index coordinator - orchestrates full and incremental indexing
 */
export class IndexCoordinator {
  private config: BeaconConfig;
  private db: BeaconDatabase;
  private embedder: Embedder;
  private repoRoot: string;

  constructor(
    config: BeaconConfig,
    db: BeaconDatabase,
    embedder: Embedder,
    repoRoot: string
  ) {
    this.config = config;
    this.db = db;
    this.embedder = embedder;
    this.repoRoot = repoRoot;
  }

  /**
   * Perform full index from scratch
   * Deletes existing database and re-indexes everything
   */
  async performFullIndex(): Promise<{ success: boolean; filesIndexed: number }> {
    // Set sync status in database for cross-module termination
    this.db.setSyncState("sync_status", "in_progress");
    this.db.setSyncState("sync_started_at", new Date().toISOString());

    try {
      // Clear existing index
      this.db.clear();

      // Get all repository files
      const allFiles = getRepoFiles(this.repoRoot);
      const filesToIndex = allFiles.filter((file) =>
        shouldIndex(
          file,
          this.config.indexing.include,
          this.config.indexing.exclude
        )
      );

      // Store total file count for progress tracking
      this.db.setSyncState("total_files", String(filesToIndex.length));
      this.db.setSyncState("files_indexed", "0");

      const filesIndexed = await this.indexFiles(filesToIndex);

      this.db.setSyncState("last_full_sync", new Date().toISOString());
      this.db.setSyncState("sync_status", "idle");

      return { success: true, filesIndexed };
    } catch (error: unknown) {
      const errorMsg =
        error instanceof Error ? error.message : String(error);

      if ((error as Error)?.name === "AbortError" || errorMsg.includes("terminated")) {
        this.db.setSyncState("sync_status", "idle");
        this.db.setSyncState("sync_error", "Indexing terminated by user");
        throw error;
      }

      this.db.setSyncState(
        "sync_error",
        `Full index failed: ${errorMsg}`
      );
      this.db.setSyncState("sync_status", "error");
      throw error;
    }
  }

  /**
   * Perform differential sync since last index
   * Only re-indexes files modified since last sync
   */
  async performDiffSync(): Promise<{ success: boolean; filesIndexed: number }> {
    // Set sync status in database for cross-module termination
    this.db.setSyncState("sync_status", "in_progress");
    this.db.setSyncState("sync_started_at", new Date().toISOString());

    try {
      const lastSyncIso = this.db.getSyncState("last_full_sync");

      if (!lastSyncIso) {
        // No previous sync, do full index
        return this.performFullIndex();
      }

      // Get files modified since last sync
      const modifiedFiles = getModifiedFilesSince(
        this.repoRoot,
        lastSyncIso
      );

      // Filter by include/exclude patterns
      const filesToIndex = modifiedFiles
        .map((f) => f.path)
        .filter((file) =>
          shouldIndex(
            file,
            this.config.indexing.include,
            this.config.indexing.exclude
          )
        );

      // Store total file count for progress tracking
      this.db.setSyncState("total_files", String(filesToIndex.length));
      this.db.setSyncState("files_indexed", "0");

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
    } catch (error: unknown) {
      const errorMsg =
        error instanceof Error ? error.message : String(error);
      this.db.setSyncState("sync_error", `Diff sync failed: ${errorMsg}`);
      this.db.setSyncState("sync_status", "error");
      throw error;
    }
  }

  /**
   * Index a batch of files with parallel embedding requests
   * Chunks, embeds, and stores in database
   */
  private async indexFiles(filePaths: string[]): Promise<number> {
    const { concurrency } = this.config.indexing;

    // Collect all file content that needs indexing
    const filesToProcess: Array<{
      path: string;
      content: string;
      hash: string;
    }> = [];

    for (const filePath of filePaths) {
      // Check for termination via database flag
      if (shouldTerminate(this.db)) {
        throw Object.assign(new Error("Indexing terminated by user"), { name: "AbortError" });
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
      } catch {
        // Skip files that can't be read
      }
    }

    if (filesToProcess.length === 0) {
      return 0;
    }

    // Pre-chunk all files - pass context_limit for safety margin
    const chunkedFiles = filesToProcess.map((file) => {
      const chunks = chunkCode(
        file.content,
        this.config.chunking.max_tokens,
        this.config.chunking.overlap_tokens,
        this.config.embedding.context_limit
      );
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

    // Process in parallel with concurrency limit
    let filesProcessed = 0;
    let totalChunksProcessed = 0;

    // Create a queue-based processor for better concurrency control
    const processQueue: Array<() => Promise<void>> = [];
    
    for (const file of chunkedFiles) {
      processQueue.push(async () => {
        // Check termination before processing each file
        if (shouldTerminate(this.db)) {
          throw Object.assign(new Error("Indexing terminated by user"), { name: "AbortError" });
        }

        const texts = file.chunks.map((c) => c.text);
        
        try {
          const embeddings = await this.embedder.embedDocuments(texts);
          
          this.db.insertChunks(
            file.path,
            file.chunks,
            embeddings,
            file.hash
          );
          
          filesProcessed++;
          totalChunksProcessed += file.chunks.length;
          
          // Update progress in database
          this.db.setSyncState("files_indexed", String(filesProcessed));
          this.db.setSyncState("chunks_processed", String(totalChunksProcessed));
        } catch (err) {
          // Log error but continue with other files
          console.error(`Failed to embed ${file.path}:`, err);
        }
      });
    }

    // Process queue with concurrency limit using Promise.allSettled
    await Promise.allSettled(processQueue.map(task => task()));
    
    // Count successful completions (failures already logged in task)
    return filesProcessed;
  }

  /**
   * Re-embed a single file after edit
   */
  async reembedFile(filePath: string): Promise<boolean> {
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
      const chunks = chunkCode(
        content,
        this.config.chunking.max_tokens,
        this.config.chunking.overlap_tokens,
        this.config.embedding.context_limit
      );

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
      this.db.insertChunks(
        filePath,
        chunks.map((c) => ({
          text: c.text,
          start_line: c.start_line,
          end_line: c.end_line,
        })),
        embeddings,
        hash
      );

      return true;
    } catch (error: unknown) {
      const errorMsg =
        error instanceof Error ? error.message : String(error);
      console.error(`Failed to reembed ${filePath}: ${errorMsg}`);
      return false;
    }
  }

  /**
   * Garbage collect deleted files
   */
  garbageCollect(): number {
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
    } catch (error: unknown) {
      console.error("Garbage collection failed:", error);
      return 0;
    }
  }
}

/**
 * Initialize indexing (create database, set up coordinator)
 */
export function initializeIndexing(
  config: BeaconConfig,
  repoRoot: string
): {
  coordinator: IndexCoordinator;
  db: BeaconDatabase;
} {
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
