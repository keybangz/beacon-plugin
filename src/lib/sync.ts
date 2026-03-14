import { existsSync, mkdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import type { BeaconConfig } from "./types.js";
import { chunkCode } from "./chunker.js";
import { Embedder } from "./embedder.js";
import { getRepoFiles, getModifiedFilesSince, getFileHash } from "./git.js";
import { shouldIndex } from "./ignore.js";
import { BeaconDatabase } from "./db.js";

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

  async performFullIndex(): Promise<{ success: boolean; filesIndexed: number }> {
    this.db.setSyncState("sync_status", "in_progress");
    this.db.setSyncState("sync_started_at", new Date().toISOString());

    try {
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
        this.db.deleteChunks(file);
      }

      const filesIndexed = await this.indexFiles(filesToIndex);

      const allTrackedFiles = getRepoFiles(this.repoRoot);
      const indexedFiles = new Set(this.db.getIndexedFiles());

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

  private async indexFiles(filePaths: string[]): Promise<number> {
    const filesToProcess: Array<{
      path: string;
      content: string;
      hash: string;
    }> = [];

    for (const filePath of filePaths) {
      if (shouldTerminate(this.db)) {
        throw Object.assign(new Error("Indexing terminated by user"), { name: "AbortError" });
      }

      try {
        const fullPath = join(this.repoRoot, filePath);

        const stat = statSync(fullPath);
        if (stat.size / 1024 > this.config.indexing.max_file_size_kb) {
          continue;
        }

        const content = readFileSync(fullPath, "utf-8");
        const hash = getFileHash(content);

        const storedHash = this.db.getFileHash(filePath);
        if (storedHash === hash) {
          continue;
        }

        filesToProcess.push({ path: filePath, content, hash });
      } catch {
      }
    }

    if (filesToProcess.length === 0) {
      return 0;
    }

    let filesProcessed = 0;
    const contextLimit = this.config.embedding.context_limit;
    const maxTokens = this.config.chunking.max_tokens;
    const overlapTokens = this.config.chunking.overlap_tokens;

    if (!this.useEmbeddings) {
      for (const file of filesToProcess) {
        if (shouldTerminate(this.db)) {
          throw Object.assign(new Error("Indexing terminated by user"), { name: "AbortError" });
        }

        const chunks = chunkCode(file.content, maxTokens, overlapTokens, contextLimit);

        if (chunks.length > 0) {
          try {
            const placeholderEmbeddings = chunks.map(() => 
              this.generatePlaceholderEmbedding(file.content)
            );
            
            this.db.insertChunks(
              file.path,
              chunks.map((c) => ({
                text: c.text,
                start_line: c.start_line,
                end_line: c.end_line,
              })),
              placeholderEmbeddings,
              file.hash
            );
            filesProcessed++;
            this.db.setSyncState("files_indexed", String(filesProcessed));
          } catch (err) {
            console.error(`Failed to index ${file.path}:`, err);
          }
        }
      }
      
      return filesProcessed;
    }

    const chunkedFiles: Array<{
      path: string;
      hash: string;
      chunks: Array<{ text: string; start_line: number; end_line: number }>;
      startChunkIndex: number;
    }> = [];

    let globalChunkIndex = 0;
    for (const file of filesToProcess) {
      const chunks = chunkCode(file.content, maxTokens, overlapTokens, contextLimit);
      if (chunks.length > 0) {
        chunkedFiles.push({
          path: file.path,
          hash: file.hash,
          chunks: chunks.map((c) => ({
            text: c.text,
            start_line: c.start_line,
            end_line: c.end_line,
          })),
          startChunkIndex: globalChunkIndex,
        });
        globalChunkIndex += chunks.length;
      }
    }

    const totalChunks = globalChunkIndex;
    if (totalChunks === 0) {
      return 0;
    }

    const embeddings: Array<number[] | null> = new Array(totalChunks).fill(null);
    const batchSize = Math.min(this.config.embedding.batch_size ?? 10, 20);
    const { concurrency } = this.config.indexing;

    const chunkToFileMap = new Map<number, { fileIndex: number; localIdx: number }>();
    for (let fileIdx = 0; fileIdx < chunkedFiles.length; fileIdx++) {
      const file = chunkedFiles[fileIdx];
      for (let localIdx = 0; localIdx < file.chunks.length; localIdx++) {
        chunkToFileMap.set(file.startChunkIndex + localIdx, { fileIndex: fileIdx, localIdx });
      }
    }

    const embeddingBatches: Array<{ startIdx: number; texts: string[] }> = [];
    for (let i = 0; i < totalChunks; i += batchSize) {
      const end = Math.min(i + batchSize, totalChunks);
      const texts: string[] = [];
      for (let j = i; j < end; j++) {
        const mapping = chunkToFileMap.get(j);
        if (mapping) {
          texts.push(chunkedFiles[mapping.fileIndex].chunks[mapping.localIdx].text);
        }
      }
      if (texts.length > 0) {
        embeddingBatches.push({ startIdx: i, texts });
      }
    }

    const processBatch = async (batch: { startIdx: number; texts: string[] }): Promise<void> => {
      if (shouldTerminate(this.db)) {
        throw Object.assign(new Error("Indexing terminated by user"), { name: "AbortError" });
      }

      const batchEmbeddings = await this.embedder.embedDocuments(batch.texts);
      for (let i = 0; i < batchEmbeddings.length; i++) {
        embeddings[batch.startIdx + i] = batchEmbeddings[i];
      }
    };

    for (let i = 0; i < embeddingBatches.length; i += concurrency) {
      const batchGroup = embeddingBatches.slice(i, i + concurrency);
      await Promise.all(batchGroup.map(processBatch));
    }

    for (const file of chunkedFiles) {
      if (shouldTerminate(this.db)) {
        throw Object.assign(new Error("Indexing terminated by user"), { name: "AbortError" });
      }

      const fileEmbeddings: number[][] = [];
      for (let i = 0; i < file.chunks.length; i++) {
        const emb = embeddings[file.startChunkIndex + i];
        if (emb) fileEmbeddings.push(emb);
      }

      if (fileEmbeddings.length === file.chunks.length) {
        try {
          this.db.insertChunks(file.path, file.chunks, fileEmbeddings, file.hash);
          filesProcessed++;
          this.db.setSyncState("files_indexed", String(filesProcessed));
        } catch (err) {
          console.error(`Failed to insert ${file.path}:`, err);
        }
      }
    }

    return filesProcessed;
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
        this.db.deleteChunks(filePath);
        return true;
      }

      const content = readFileSync(fullPath, "utf-8");
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
        this.db.deleteChunks(filePath);
        return true;
      }

      const texts = chunks.map((c) => c.text);
      let embeddings: number[][];

      if (this.useEmbeddings) {
        embeddings = await this.embedder.embedDocuments(texts);
      } else {
        embeddings = texts.map(() => this.generatePlaceholderEmbedding(content));
      }

      this.db.deleteChunks(filePath);

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

  garbageCollect(): number {
    try {
      const allTrackedFiles = new Set(getRepoFiles(this.repoRoot));
      const indexedFiles = this.db.getIndexedFiles();

      let deletedCount = 0;

      for (const indexedFile of indexedFiles) {
        if (!allTrackedFiles.has(indexedFile)) {
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
