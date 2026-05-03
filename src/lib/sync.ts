import { existsSync, mkdirSync } from "fs";
import { stat as statAsync, readFile as readFileAsync } from "fs/promises";
import { join } from "path";
import { cpus } from "os";
import { log } from "./logger.js";
import type { BeaconConfig } from "./types.js";
import { chunkCode } from "./chunker.js";
import { Embedder } from "./embedder.js";
import { getAllFilesViaGlob } from "./fs-glob.js";
import { getRepoFiles, getModifiedFilesSince, getFileHash } from "./git.js";
import { shouldIndex } from "./ignore.js";
import { BeaconDatabase } from "./db.js";
import { simpleHash } from "./hash.js";

const YIELD_INTERVAL = 50;

export interface IndexProgress {
  phase: "discovering" | "chunking" | "embedding" | "storing" | "complete" | "error";
  filesTotal: number;
  filesProcessed: number;
  chunksTotal: number;
  chunksProcessed: number;
  percent: number;
  message: string;
}

export type ProgressCallback = (progress: IndexProgress) => void | Promise<void>;

export function terminateIndexer(db?: BeaconDatabase): boolean {
  if (db) {
    const status = db.getSyncState("sync_status");
    if (status === "in_progress") {
      db.setSyncState("sync_status", "terminating");
      return true;
    }
  }
  return false;
}

export function isIndexerRunning(db?: BeaconDatabase): boolean {
  if (db) {
    const status = db.getSyncState("sync_status");
    return status === "in_progress" || status === "terminating";
  }
  return false;
}

export function shouldTerminate(db: BeaconDatabase): boolean {
  const status = db.getSyncState("sync_status");
  return status === "terminating";
}

export class IndexCoordinator {
  private config: BeaconConfig;
  private db: BeaconDatabase;
  private embedder: Embedder;
  private repoRoot: string;
  private useEmbeddings: boolean;
  private progressCallback: ProgressCallback | null = null;
  private isSyncing: boolean = false;
  // Called when the running state changes so the connection pool can track it.
  private onRunningChange: ((running: boolean) => void) | null = null;

  constructor(
    config: BeaconConfig,
    db: BeaconDatabase,
    embedder: Embedder,
    repoRoot: string,
    onRunningChange?: (running: boolean) => void
  ) {
    this.config = config;
    this.db = db;
    this.embedder = embedder;
    this.repoRoot = repoRoot;
    this.useEmbeddings = config.embedding.enabled !== false;
    this.onRunningChange = onRunningChange ?? null;
  }

  setProgressCallback(callback: ProgressCallback | null): void {
    this.progressCallback = callback;
  }

  private async emitProgress(progress: IndexProgress): Promise<void> {
    if (this.progressCallback) {
      await this.progressCallback(progress);
    }
  }

  async performFullIndex(onProgress?: ProgressCallback): Promise<{ success: boolean; filesIndexed: number }> {
    if (this.isSyncing) {
      log.warn("beacon", "Sync already in progress, skipping concurrent request");
      return { success: false, filesIndexed: 0 };
    }
    this.isSyncing = true;
    this.onRunningChange?.(true);

    if (onProgress) {
      this.setProgressCallback(onProgress);
    }

    this.db.setSyncState("sync_status", "in_progress");
    this.db.setSyncState("sync_started_at", new Date().toISOString());

    try {
      await this.emitProgress({
        phase: "discovering",
        filesTotal: 0,
        filesProcessed: 0,
        chunksTotal: 0,
        chunksProcessed: 0,
        percent: 0,
        message: "Discovering files...",
      });

      let allFiles = getAllFilesViaGlob(
        this.repoRoot,
        this.config.indexing.include,
        this.config.indexing.exclude
      );
      log.info("beacon", `File discovery: ${allFiles?.length || 0} files found in ${this.repoRoot}`);
      if ((!allFiles || allFiles.length === 0) && (this.config.indexing as any).use_git_backup !== false) {
        try {
          allFiles = getRepoFiles(this.repoRoot);
          if (!allFiles || allFiles.length === 0) {
            throw new Error('[Beacon] No files found via git backup.');
          }
        } catch (e) {
          throw new Error('[Beacon] No files found via glob or git backup.');
        }
      }
      if (!allFiles || allFiles.length === 0) {
        // Emit a warning and proceed — watcher will index files as they are created.
        // Do NOT clear the existing index when no files are found; the prior index
        // remains valid and the watcher will update it as files appear.
        log.warn("beacon", "No files found for indexing", { repoRoot: this.repoRoot, includePatterns: this.config.indexing.include?.length || 0, excludePatterns: this.config.indexing.exclude?.length || 0 });
        await this.emitProgress({
          phase: "discovering",
          filesTotal: 0,
          filesProcessed: 0,
          chunksTotal: 0,
          chunksProcessed: 0,
          percent: 0,
          message: "No files found. Watcher is active — files will be indexed as they appear."
        });
        // Set sync state to idle and return success (zero files indexed)
        this.db.setSyncState("sync_status", "idle");
        this.db.setSyncState("last_full_sync", new Date().toISOString());
        return { success: true, filesIndexed: 0 };
      }

      // Retry any pending vectors from previous failed HNSW writes
      await this.retryPendingVectors();

      // File discovery succeeded — safe to clear the existing index now.
      await this.db.clear();
      // Optimize DB for bulk writes during full reindex
      this.db.beginFullReindex();

      const filesToIndex = allFiles;

      this.db.setSyncState("total_files", String(filesToIndex.length));
      this.db.setSyncState("files_indexed", "0");

      await this.emitProgress({
        phase: "discovering",
        filesTotal: filesToIndex.length,
        filesProcessed: 0,
        chunksTotal: 0,
        chunksProcessed: 0,
        percent: 0,
        message: `Found ${filesToIndex.length} files to index`,
      });

      const filesIndexed = await this.indexFiles(filesToIndex, onProgress, true /* skipHnswRemove — index was just cleared */);

      this.db.setSyncState("last_full_sync", new Date().toISOString());
      // Record which model was used to build this index
      this.db.setSyncState("indexed_model", this.config.embedding.model);
      this.db.setSyncState("indexed_dimensions", String(this.config.embedding.dimensions));
      this.db.setSyncState("sync_status", "idle");

      await this.emitProgress({
        phase: "complete",
        filesTotal: filesToIndex.length,
        filesProcessed: filesIndexed,
        chunksTotal: 0,
        chunksProcessed: 0,
        percent: 100,
        message: `Indexing complete: ${filesIndexed} files indexed`,
      });

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

      await this.emitProgress({
        phase: "error",
        filesTotal: 0,
        filesProcessed: 0,
        chunksTotal: 0,
        chunksProcessed: 0,
        percent: 0,
        message: `Indexing failed: ${errorMsg}`,
      });

      throw error;
    } finally {
      this.db.endFullReindex();
      this.isSyncing = false;
      this.onRunningChange?.(false);
    }
  }

  async performDiffSync(): Promise<{ success: boolean; filesIndexed: number }> {
    if (this.isSyncing) {
      log.warn("beacon", "Sync already in progress, skipping concurrent request");
      return { success: false, filesIndexed: 0 };
    }
    this.isSyncing = true;
    this.onRunningChange?.(true);

    this.db.setSyncState("sync_status", "in_progress");
    this.db.setSyncState("sync_started_at", new Date().toISOString());

    try {
      const lastSyncIso = this.db.getSyncState("last_full_sync");

      if (!lastSyncIso) {
        return this.performFullIndex();
      }

      const modifiedFiles = getModifiedFilesSince(
        this.repoRoot,
        lastSyncIso
      );

      const filesToIndex = modifiedFiles
        .map((f) => f.path)
        .filter((file) =>
          shouldIndex(
            file,
            this.config.indexing.include,
            this.config.indexing.exclude
          )
        );

      this.db.setSyncState("total_files", String(filesToIndex.length));
      this.db.setSyncState("files_indexed", "0");

      // Batch delete old chunks for all modified files in a single transaction
      this.db.deleteChunksBatch(filesToIndex);

      const filesIndexed = await this.indexFiles(filesToIndex);

      let allTrackedFilesArr = getAllFilesViaGlob(
        this.repoRoot,
        this.config.indexing.include,
        this.config.indexing.exclude
      );
      if ((!allTrackedFilesArr || allTrackedFilesArr.length === 0) && (this.config.indexing as any).use_git_backup !== false) {
        try {
          allTrackedFilesArr = getRepoFiles(this.repoRoot);
        } catch (e) {
          throw new Error('[Beacon] DiffSync: No files found via glob or git backup.');
        }
      }
      if (!allTrackedFilesArr || allTrackedFilesArr.length === 0) {
        throw new Error('[Beacon] DiffSync: No files found via glob or git.');
      }
      const allTrackedFiles = new Set(allTrackedFilesArr);
      const indexedFiles = new Set(this.db.getIndexedFiles());

      // Batch delete orphaned files in a single transaction
      const orphans = Array.from(indexedFiles).filter((f) => !allTrackedFiles.has(f));
      this.db.deleteChunksBatch(orphans);

      this.db.setSyncState("last_full_sync", new Date().toISOString());
      // Record which model was used to build this index
      this.db.setSyncState("indexed_model", this.config.embedding.model);
      this.db.setSyncState("indexed_dimensions", String(this.config.embedding.dimensions));
      this.db.setSyncState("sync_status", "idle");

      return { success: true, filesIndexed };
    } catch (error: unknown) {
      const errorMsg =
        error instanceof Error ? error.message : String(error);
      this.db.setSyncState("sync_error", `Diff sync failed: ${errorMsg}`);
      this.db.setSyncState("sync_status", "error");
      throw error;
    } finally {
      this.isSyncing = false;
      this.onRunningChange?.(false);
    }
  }

  private async indexFiles(filePaths: string[], onProgress?: ProgressCallback, skipHnswRemove: boolean = false): Promise<number> {
    if (onProgress) {
      this.setProgressCallback(onProgress);
    }

    const contextLimit = this.config.embedding.context_limit;
    const maxTokens = this.config.chunking.max_tokens;
    const overlapTokens = this.config.chunking.overlap_tokens;
    const maxFileSizeKb = this.config.indexing.max_file_size_kb;

    const totalFilePaths = filePaths.length;
    let filesProcessed = 0;

    if (!this.useEmbeddings) {
      for (let i = 0; i < filePaths.length; i++) {
        if (shouldTerminate(this.db)) {
          throw Object.assign(new Error("Indexing terminated by user"), { name: "AbortError" });
        }

        if (i % YIELD_INTERVAL === 0) {
          await new Promise((resolve) => setImmediate(resolve));
        }

        const filePath = filePaths[i];
        try {
          const fullPath = join(this.repoRoot, filePath);
          const stat = await statAsync(fullPath);
          
          if (stat.size / 1024 > maxFileSizeKb) {
            continue;
          }

          const content = await readFileAsync(fullPath, "utf-8");
          const hash = getFileHash(content);
          const storedHash = this.db.getFileHash(filePath);
          
          if (storedHash === hash) {
            continue;
          }

          const chunks = chunkCode(content, maxTokens, overlapTokens, contextLimit);
          if (chunks.length === 0) {
            continue;
          }

          const placeholderEmbeddings = chunks.map((c) =>
            this.generatePlaceholderEmbedding(c.text)
          );
          
          await this.db.insertChunks(
            filePath,
            chunks.map((c) => ({
              text: c.text,
              start_line: c.start_line,
              end_line: c.end_line,
            })),
            placeholderEmbeddings,
            hash
          );
          
          filesProcessed++;
          // Update DB progress counter every 100 files or 5% of total (whichever is larger)
          // to reduce SQLite write overhead.
          const updateInterval = Math.max(100, Math.floor(totalFilePaths * 0.05));
          if (filesProcessed % updateInterval === 0 || filesProcessed === totalFilePaths) {
            this.db.setSyncState("files_indexed", String(filesProcessed));
          }

          const percent = Math.round((filesProcessed / totalFilePaths) * 100);
          await this.emitProgress({
            phase: "storing",
            filesTotal: totalFilePaths,
            filesProcessed,
            chunksTotal: 0,
            chunksProcessed: 0,
            percent,
            message: `[${this.generateProgressBar(percent)}] ${percent}% (${filesProcessed}/${totalFilePaths} files)`,
          });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          log.error("beacon", `Failed to index ${filePath}`, { error: msg });
          this.db.recordMetric("chunking_error", 1);
        }
      }
      
      return filesProcessed;
    }

    // ── Streaming micro-batch pipeline ──────────────────────────────────
    // Process files in micro-batches through the full chunk → embed → store
    // pipeline. Each micro-batch's data is GC-eligible before the next starts,
    // keeping peak memory at O(MICRO_BATCH_SIZE) instead of O(total_files).
    //
    // Batch size of 50 keeps ONNX worker utilisation high (~200-500 chunks per
    // inference pass) while remaining within comfortable memory bounds.
    // Chunking concurrency of 8 saturates the I/O subsystem (stat + readFile)
    // without excessive open-fd pressure.
    const MICRO_BATCH_SIZE = this.config.indexing.micro_batch_size ?? 100;
    const chunkingConcurrency = this.config.indexing.chunking_concurrency ?? Math.max(8, cpus().length);

    // Profiling accumulators
    let totalChunksProcessed = 0;
    let totalChunkingMs = 0;
    let totalEmbeddingMs = 0;
    let totalUpsertMs = 0;
    let totalChunksCreated = 0;

    for (let batchStart = 0; batchStart < filePaths.length; batchStart += MICRO_BATCH_SIZE) {
      if (shouldTerminate(this.db)) {
        throw Object.assign(new Error("Indexing terminated by user"), { name: "AbortError" });
      }

      const batchEnd = Math.min(batchStart + MICRO_BATCH_SIZE, filePaths.length);
      const batchFilePaths = filePaths.slice(batchStart, batchEnd);

      // ── Phase 1: Chunk this micro-batch ────────────────────────────
      const chunkingStart = Date.now();
      const chunkedFiles: Array<{
        path: string;
        hash: string;
        chunks: Array<{ text: string; start_line: number; end_line: number }>;
      }> = [];

      for (let ci = 0; ci < batchFilePaths.length; ci += chunkingConcurrency) {
        const concurrentSlice = batchFilePaths.slice(ci, Math.min(ci + chunkingConcurrency, batchFilePaths.length));
        const results = await Promise.all(
          concurrentSlice.map(async (filePath): Promise<{path: string, hash: string, chunks: Array<{text: string, start_line: number, end_line: number}>} | null> => {
            try {
              const fullPath = join(this.repoRoot, filePath);
              const stat = await statAsync(fullPath);
              if (stat.size / 1024 > maxFileSizeKb) return null;

              const content = await readFileAsync(fullPath, "utf-8");
              const hash = getFileHash(content);
              const storedHash = this.db.getFileHash(filePath);
              if (storedHash === hash) return null;

              const chunks = chunkCode(content, maxTokens, overlapTokens, contextLimit);
              if (chunks.length === 0) return null;

              return {
                path: filePath,
                hash,
                chunks: chunks.map((c) => ({
                  text: c.text,
                  start_line: c.start_line,
                  end_line: c.end_line,
                })),
              };
            } catch (err: unknown) {
              log.error("beacon", `Failed to chunk ${filePath}`, { error: err instanceof Error ? err.message : String(err) });
              this.db.recordMetric("chunking_error", 1);
              return null;
            }
          })
        );
        for (const r of results) {
          if (r) chunkedFiles.push(r);
        }
      }
      totalChunkingMs += Date.now() - chunkingStart;

      if (chunkedFiles.length === 0) {
        // Emit progress even for empty micro-batches
        const percent = Math.round((batchEnd / totalFilePaths) * 100);
        await this.emitProgress({
          phase: "chunking",
          filesTotal: totalFilePaths,
          filesProcessed: batchEnd,
          chunksTotal: 0,
          chunksProcessed: totalChunksProcessed,
          percent,
          message: `[${this.generateProgressBar(percent)}] ${percent}% (${batchEnd}/${totalFilePaths} files scanned)`,
        });
        continue;
      }

      const batchChunkCount = chunkedFiles.reduce((sum, f) => sum + f.chunks.length, 0);
      totalChunksCreated += batchChunkCount;

      // ── Phase 2: Embed this micro-batch ────────────────────────────
      // Collect ALL texts from ALL files in the micro-batch into one flat array,
      // then send to embedDocuments() in a single call.  This gives the ONNX
      // session a much larger batch tensor (e.g. 300–600 texts at once instead
      // of ~15 per file), which is far more efficient for both CPU and GPU.
      // After the call, slice the flat results back per-file using the offsets.
      const embeddingStart = Date.now();
      const fileEmbeddings = new Map<string, number[][]>();
      let batchChunksEmbedded = 0;

      // Build flat text array and track per-file slice offsets
      const allTexts: string[] = [];
      const fileOffsets: Array<{ path: string; start: number; count: number }> = [];
      for (const file of chunkedFiles) {
        const start = allTexts.length;
        for (const c of file.chunks) allTexts.push(c.text);
        fileOffsets.push({ path: file.path, start, count: file.chunks.length });
      }

      let flatEmbeddings: number[][];
      try {
        flatEmbeddings = await this.embedder.embedDocuments(allTexts);
      } catch (embedErr: unknown) {
        log.error("beacon", "Failed to embed micro-batch, falling back to per-file", { error: embedErr instanceof Error ? embedErr.message : String(embedErr) });
        // Fall back to per-file embedding so we don't lose the entire batch
        flatEmbeddings = [];
        let offset = 0;
        for (const file of chunkedFiles) {
          const texts = file.chunks.map((c) => c.text);
          let embeddings: number[][];
          try {
            embeddings = await this.embedder.embedDocuments(texts);
          } catch {
            embeddings = texts.map((t) => this.generatePlaceholderEmbedding(t));
          }
          fileEmbeddings.set(file.path, embeddings);
          batchChunksEmbedded += texts.length;
          offset += texts.length;
        }
      }

      // Slice flat results back per-file (only when the flat embed succeeded)
      if (flatEmbeddings.length > 0) {
        for (const { path, start, count } of fileOffsets) {
          fileEmbeddings.set(path, flatEmbeddings.slice(start, start + count));
          batchChunksEmbedded += count;
        }
      }

      // Yield to event loop after the (potentially long) inference call
      await new Promise<void>((resolve) => setImmediate(resolve));

      totalEmbeddingMs += Date.now() - embeddingStart;
      totalChunksProcessed += batchChunksEmbedded;

      // ── Phase 3: Store this micro-batch ────────────────────────────
      // P5: Single transaction + single HNSW addVectorBatch for all files in
      // the micro-batch, eliminating N separate WAL writes and N HNSW graph
      // traversals per batch.  Falls back to per-file insertChunks() on error.
      if (shouldTerminate(this.db)) {
        throw Object.assign(new Error("Indexing terminated by user"), { name: "AbortError" });
      }

      const upsertStart = Date.now();
      const batchInput = chunkedFiles
        .map((file) => {
          const embeddings = fileEmbeddings.get(file.path);
          if (!embeddings || !embeddings.every((e) => e != null)) return null;
          return { filePath: file.path, chunks: file.chunks, embeddings, fileHash: file.hash };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);

      if (batchInput.length > 0) {
        try {
          await this.db.insertChunksBatch(batchInput, skipHnswRemove);
          filesProcessed += batchInput.length;
          this.db.setSyncState("files_indexed", String(filesProcessed));
        } catch (err) {
          log.error("beacon", "insertChunksBatch failed for micro-batch", { error: err instanceof Error ? err.message : String(err) });
          this.db.recordMetric("upsert_error", 1);
        }
      }
      totalUpsertMs += Date.now() - upsertStart;

      // Micro-batch complete — chunkedFiles, fileEmbeddings, allTexts, textMapping
      // are now all GC-eligible as we loop to the next micro-batch.

      // Emit cumulative progress
      const percent = Math.round((batchEnd / totalFilePaths) * 100);
      await this.emitProgress({
        phase: "embedding",
        filesTotal: totalFilePaths,
        filesProcessed: batchEnd,
        chunksTotal: totalChunksCreated,
        chunksProcessed: totalChunksProcessed,
        percent,
        message: `[${this.generateProgressBar(percent)}] ${percent}% (${filesProcessed} files indexed, ${totalChunksProcessed} chunks embedded)`,
      });

      // Update DB progress counter
      this.db.setSyncState("files_indexed", String(filesProcessed));

      // Yield to event loop between micro-batches
      await new Promise((resolve) => setImmediate(resolve));
    }

    // Record aggregate profiling metrics
    const totalElapsedSec = Math.max((totalChunkingMs + totalEmbeddingMs + totalUpsertMs) / 1000, 0.001);
    this.db.recordMetric("chunking_latency_ms", totalChunkingMs);
    this.db.recordMetric("embedding_latency_ms", totalEmbeddingMs);
    this.db.recordMetric("upsert_latency_ms", totalUpsertMs);
    this.db.recordMetric("chunking_throughput_files", filesProcessed / Math.max(totalChunkingMs / 1000, 0.001));
    this.db.recordMetric("chunking_throughput_chunks", totalChunksCreated / Math.max(totalChunkingMs / 1000, 0.001));
    this.db.recordMetric("embedding_throughput_chunks", totalChunksProcessed / Math.max(totalEmbeddingMs / 1000, 0.001));
    this.db.recordMetric("upsert_throughput_files", filesProcessed / Math.max(totalUpsertMs / 1000, 0.001));
    this.db.recordMetric("upsert_throughput_chunks", totalChunksProcessed / Math.max(totalUpsertMs / 1000, 0.001));

    return filesProcessed;
  }

  private generateProgressBar(percent: number, width: number = 10): string {
    const filled = Math.round((percent / 100) * width);
    const empty = width - filled;
    return "=".repeat(filled) + (filled < width ? ">" : "") + " ".repeat(Math.max(0, empty - (filled < width ? 1 : 0)));
  }

  private generatePlaceholderEmbedding(text: string): number[] {
    const dims = this.config.embedding.dimensions;
    const embedding = new Float32Array(dims);
    
    const hash = simpleHash(text);
    const seed = (hash % 2147483647) || 1; // Avoid degenerate zero seed
    let rng = seed;
    
    for (let i = 0; i < dims; i++) {
      rng = (rng * 16807) % 2147483647;
      embedding[i] = (rng / 2147483647) * 2 - 1;
    }
    
    let magnitude = 0;
    for (let i = 0; i < dims; i++) {
      magnitude += embedding[i] * embedding[i];
    }
    magnitude = Math.sqrt(magnitude);
    
    if (magnitude > 0) {
      for (let i = 0; i < dims; i++) {
        embedding[i] /= magnitude;
      }
    }
    
    return Array.from(embedding);
  }

  async reembedFile(filePath: string): Promise<boolean> {
    try {
      const fullPath = join(this.repoRoot, filePath);

      if (!existsSync(fullPath)) {
        await this.db.deleteChunks(filePath);
        return true;
      }

      const stat = await statAsync(fullPath);
      if (stat.size / 1024 > this.config.indexing.max_file_size_kb) {
        return false;
      }

      const content = await readFileAsync(fullPath, "utf-8");
      const hash = getFileHash(content);

      const storedHash = this.db.getFileHash(filePath);
      if (storedHash === hash) {
        return false;
      }

      const chunks = chunkCode(
        content,
        this.config.chunking.max_tokens,
        this.config.chunking.overlap_tokens,
        this.config.embedding.context_limit
      );

      if (chunks.length === 0) {
        await this.db.deleteChunks(filePath);
        return true;
      }

      const texts = chunks.map((c) => c.text);
      let embeddings: number[][];

      if (this.useEmbeddings) {
        embeddings = await this.embedder.embedDocuments(texts);
      } else {
        embeddings = texts.map((text) => this.generatePlaceholderEmbedding(text));
      }

      // Insert new chunks before deleting old ones so the file is never absent
      // from the index during the update window (atomicity via upsert semantics).
      await this.db.insertChunks(
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
      log.error("beacon", `Failed to reembed ${filePath}`, { error: errorMsg });
      return false;
    }
  }

  async garbageCollect(): Promise<void> {
    // Retry any pending vector insertions first
    await this.retryPendingVectors();

    // Remove orphaned HNSW entries not present in SQLite chunks table
    try {
      const indexedChunkIds = new Set(this.db.getAllChunkIds());
      await this.db.hnswGarbageCollect(indexedChunkIds);
    } catch (err) {
      log.warn("beacon", "garbageCollect failed", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * Retry pending vector insertions that failed during initial indexing.
   * Implements the outbox pattern for HNSW+SQLite dual-write consistency.
   */
  async retryPendingVectors(): Promise<void> {
    try {
      const retried = await this.db.retryPendingVectors();
      if (retried > 0) {
        log.info("beacon", `Retried ${retried} pending vector insertions`);
      }
    } catch (err) {
      log.warn("beacon", "retryPendingVectors failed", { error: err instanceof Error ? err.message : String(err) });
    }
  }
}

export function initializeIndexing(
  config: BeaconConfig,
  repoRoot: string
): {
  coordinator: IndexCoordinator;
  db: BeaconDatabase;
} {
  // config.storage.path is already the full absolute path (set lazily by loadConfig)
  const storageDir = config.storage.path;
  if (!existsSync(storageDir)) {
    mkdirSync(storageDir, { recursive: true });
  }

  const dbPath = join(storageDir, "embeddings.db");
  const db = new BeaconDatabase(dbPath, config.embedding.dimensions, true, config.storage.hnsw_max_elements);

  const effectiveContextLimit = config.embedding.context_limit ?? config.chunking.max_tokens;
  const embedder = new Embedder(config.embedding, effectiveContextLimit, storageDir);

  const coordinator = new IndexCoordinator(config, db, embedder, repoRoot);

  return { coordinator, db };
}
