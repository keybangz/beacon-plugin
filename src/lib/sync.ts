import { existsSync, mkdirSync } from "fs";
import { stat as statAsync, readFile as readFileAsync } from "fs/promises";
import { join } from "path";
import type { BeaconConfig } from "./types.js";
import { chunkCode } from "./chunker.js";
import { Embedder } from "./embedder.js";
import { getRepoFiles, getModifiedFilesSince, getFileHash } from "./git.js";
import { shouldIndex } from "./ignore.js";
import { BeaconDatabase } from "./db.js";

const YIELD_INTERVAL = 50;
const FILE_BATCH_SIZE = 100;
const EMBEDDING_BATCH_MEMORY_LIMIT = 5000;

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

function simpleHash(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
  }
  return hash >>> 0;
}

export class IndexCoordinator {
  private config: BeaconConfig;
  private db: BeaconDatabase;
  private embedder: Embedder;
  private repoRoot: string;
  private useEmbeddings: boolean;
  private progressCallback: ProgressCallback | null = null;

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
    this.useEmbeddings = config.embedding.enabled !== false;
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

      this.db.clear();

      const allFiles = getRepoFiles(this.repoRoot);
      const filesToIndex = allFiles.filter((file) =>
        shouldIndex(
          file,
          this.config.indexing.include,
          this.config.indexing.exclude
        )
      );

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

      const filesIndexed = await this.indexFiles(filesToIndex, onProgress);

      this.db.setSyncState("last_full_sync", new Date().toISOString());
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
    }
  }

  async performDiffSync(): Promise<{ success: boolean; filesIndexed: number }> {
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

      for (const file of filesToIndex) {
        await this.db.deleteChunks(file);
      }

      const filesIndexed = await this.indexFiles(filesToIndex);

      const allTrackedFiles = getRepoFiles(this.repoRoot);
      const indexedFiles = new Set(this.db.getIndexedFiles());

      for (const indexedFile of indexedFiles) {
        if (!allTrackedFiles.includes(indexedFile)) {
          await this.db.deleteChunks(indexedFile);
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

  private async indexFiles(filePaths: string[], onProgress?: ProgressCallback): Promise<number> {
    if (onProgress) {
      this.setProgressCallback(onProgress);
    }

    const contextLimit = this.config.embedding.context_limit;
    const maxTokens = this.config.chunking.max_tokens;
    const overlapTokens = this.config.chunking.overlap_tokens;
    const maxFileSizeKb = this.config.indexing.max_file_size_kb;

    const totalFilePaths = filePaths.length;
    let filesProcessed = 0;
    let globalChunksProcessed = 0;

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

          const placeholderEmbeddings = chunks.map(() => 
            this.generatePlaceholderEmbedding(content)
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
          this.db.setSyncState("files_indexed", String(filesProcessed));

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
        } catch {
        }
      }
      
      return filesProcessed;
    }

    const chunkedFiles: Array<{
      path: string;
      hash: string;
      chunks: Array<{ text: string; start_line: number; end_line: number }>;
    }> = [];

    await this.emitProgress({
      phase: "chunking",
      filesTotal: totalFilePaths,
      filesProcessed: 0,
      chunksTotal: 0,
      chunksProcessed: 0,
      percent: 0,
      message: `Reading and chunking ${totalFilePaths} files...`,
    });

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
        if (chunks.length > 0) {
          chunkedFiles.push({
            path: filePath,
            hash,
            chunks: chunks.map((c) => ({
              text: c.text,
              start_line: c.start_line,
              end_line: c.end_line,
            })),
          });
        }

        if (i % 20 === 0) {
          const percent = Math.round((i / totalFilePaths) * 30);
          await this.emitProgress({
            phase: "chunking",
            filesTotal: totalFilePaths,
            filesProcessed: i,
            chunksTotal: chunkedFiles.reduce((sum, f) => sum + f.chunks.length, 0),
            chunksProcessed: 0,
            percent,
            message: `[${this.generateProgressBar(percent)}] Chunking... (${i}/${totalFilePaths} files)`,
          });
        }
      } catch {
      }
    }

    if (chunkedFiles.length === 0) {
      return 0;
    }

    const totalChunks = chunkedFiles.reduce((sum, f) => sum + f.chunks.length, 0);
    
    await this.emitProgress({
      phase: "embedding",
      filesTotal: chunkedFiles.length,
      filesProcessed: 0,
      chunksTotal: totalChunks,
      chunksProcessed: 0,
      percent: 30,
      message: `Embedding ${totalChunks} chunks from ${chunkedFiles.length} files...`,
    });

    const batchSize = Math.min(this.config.embedding.batch_size ?? 10, 20);
    const { concurrency } = this.config.indexing;

    const fileChunkEmbeddings = new Map<string, number[][]>();

    for (let fileIdx = 0; fileIdx < chunkedFiles.length; fileIdx++) {
      const file = chunkedFiles[fileIdx];
      fileChunkEmbeddings.set(file.path, new Array(file.chunks.length).fill(null as unknown as number[]));
    }

    const processFileBatch = async (
      files: typeof chunkedFiles,
      startFileIdx: number
    ): Promise<void> => {
      if (shouldTerminate(this.db)) {
        throw Object.assign(new Error("Indexing terminated by user"), { name: "AbortError" });
      }

      const allTexts: string[] = [];
      const textToFileInfo: Array<{ fileIdx: number; chunkIdx: number }> = [];

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        for (let chunkIdx = 0; chunkIdx < file.chunks.length; chunkIdx++) {
          allTexts.push(file.chunks[chunkIdx].text);
          textToFileInfo.push({ fileIdx: startFileIdx + i, chunkIdx });
        }
      }

      if (allTexts.length === 0) return;

      const embeddings = await this.embedder.embedDocuments(allTexts);

      for (let i = 0; i < textToFileInfo.length; i++) {
        const { fileIdx, chunkIdx } = textToFileInfo[i];
        const file = chunkedFiles[fileIdx];
        fileChunkEmbeddings.get(file.path)![chunkIdx] = embeddings[i];
      }

      globalChunksProcessed += allTexts.length;
    };

    for (let i = 0; i < chunkedFiles.length; i += batchSize * concurrency) {
      if (shouldTerminate(this.db)) {
        throw Object.assign(new Error("Indexing terminated by user"), { name: "AbortError" });
      }

      const batchGroup: Array<{ files: typeof chunkedFiles; startFileIdx: number }> = [];
      
      for (let j = 0; j < concurrency; j++) {
        const startIdx = i + j * batchSize;
        if (startIdx >= chunkedFiles.length) break;
        
        const endIdx = Math.min(startIdx + batchSize, chunkedFiles.length);
        batchGroup.push({
          files: chunkedFiles.slice(startIdx, endIdx),
          startFileIdx: startIdx,
        });
      }

      await Promise.all(
        batchGroup.map((batch) => processFileBatch(batch.files, batch.startFileIdx))
      );

      const percent = 30 + Math.round((globalChunksProcessed / totalChunks) * 50);
      await this.emitProgress({
        phase: "embedding",
        filesTotal: chunkedFiles.length,
        filesProcessed: 0,
        chunksTotal: totalChunks,
        chunksProcessed: globalChunksProcessed,
        percent,
        message: `[${this.generateProgressBar(percent)}] ${percent}% (${globalChunksProcessed}/${totalChunks} chunks embedded)`,
      });
    }

    await this.emitProgress({
      phase: "storing",
      filesTotal: chunkedFiles.length,
      filesProcessed: 0,
      chunksTotal: totalChunks,
      chunksProcessed: globalChunksProcessed,
      percent: 80,
      message: `Storing embeddings in database...`,
    });

    for (let i = 0; i < chunkedFiles.length; i++) {
      if (shouldTerminate(this.db)) {
        throw Object.assign(new Error("Indexing terminated by user"), { name: "AbortError" });
      }

      if (i % YIELD_INTERVAL === 0) {
        await new Promise((resolve) => setImmediate(resolve));
      }

      const file = chunkedFiles[i];
      const embeddings = fileChunkEmbeddings.get(file.path);

      if (embeddings && embeddings.every((e) => e !== null)) {
        try {
          await this.db.insertChunks(file.path, file.chunks, embeddings as number[][], file.hash);
          filesProcessed++;
          this.db.setSyncState("files_indexed", String(filesProcessed));

          const percent = 80 + Math.round((filesProcessed / chunkedFiles.length) * 20);
          await this.emitProgress({
            phase: "storing",
            filesTotal: chunkedFiles.length,
            filesProcessed,
            chunksTotal: totalChunks,
            chunksProcessed: globalChunksProcessed,
            percent,
            message: `[${this.generateProgressBar(percent)}] ${percent}% (${filesProcessed}/${chunkedFiles.length} files stored)`,
          });
        } catch (err) {
          console.error(`Failed to insert ${file.path}:`, err);
        }
      }

      fileChunkEmbeddings.delete(file.path);
    }

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
    const seed = hash % 2147483647;
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
        embeddings = texts.map(() => this.generatePlaceholderEmbedding(content));
      }

      await this.db.deleteChunks(filePath);

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
      console.error(`Failed to reembed ${filePath}: ${errorMsg}`);
      return false;
    }
  }

  async garbageCollect(): Promise<number> {
    try {
      const allTrackedFiles = new Set(getRepoFiles(this.repoRoot));
      const indexedFiles = this.db.getIndexedFiles();

      let deletedCount = 0;

      for (const indexedFile of indexedFiles) {
        if (!allTrackedFiles.has(indexedFile)) {
          await this.db.deleteChunks(indexedFile);
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

export function initializeIndexing(
  config: BeaconConfig,
  repoRoot: string
): {
  coordinator: IndexCoordinator;
  db: BeaconDatabase;
} {
  const storageDir = join(repoRoot, config.storage.path);
  if (!existsSync(storageDir)) {
    mkdirSync(storageDir, { recursive: true });
  }

  const dbPath = join(storageDir, "embeddings.db");
  const db = new BeaconDatabase(dbPath, config.embedding.dimensions);

  const effectiveContextLimit = config.embedding.context_limit ?? config.chunking.max_tokens;
  const embedder = new Embedder(config.embedding, effectiveContextLimit, storageDir);

  const coordinator = new IndexCoordinator(config, db, embedder, repoRoot);

  return { coordinator, db };
}
