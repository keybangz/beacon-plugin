/**
 * Beacon Database Layer
 * SQLite with FTS5 for keyword matching
 *
 * Schema:
 * - chunks: source code chunks with embeddings and metadata
 * - chunks_fts: FTS5 for full-text search
 * - sync_state: key-value store for indexing state
 */
import Database from "bun:sqlite";
import { statSync } from "fs";
import { dirname } from "path";
import { log } from "./logger.js";
import type {
  Chunk,
  SearchResult,
  DimensionCheck,
  SyncProgress,
  BeaconConfig,
} from "./types.js";
import {
  extractIdentifiers,
  prepareFTSQuery,
  buildExpandedQuery,
  getFileTypeMultiplier,
  getIdentifierBoost,
} from "./tokenizer.js";
import { SearchCache, PerformanceTimer } from "./cache.js";
import { HNSWVectorIndex, type HNSWIndexConfig } from "./hnsw.js";

const SCHEMA_VERSION = 5; // v5: fixed attention mask in meanPool — all existing embeddings are invalid and must be recomputed
const CACHE_TTL_MS = 300000; // 5 minutes

/**
 * Convert embedding array to buffer for storage
 */
function embeddingToBuffer(arr: number[]): Buffer {
  const float32Array = new Float32Array(arr);
  return Buffer.from(float32Array.buffer);
}

/**
 * Beacon database class
 * Handles all database operations: schema creation, chunking, searching, state management
 */
export class BeaconDatabase {
  private db: Database;
  private dbPath: string;
  private dimensions: number;
  private hnswIndex: HNSWVectorIndex | null = null;
  private useHNSW: boolean = true;
  /** Tracks the in-flight HNSW initialization promise so callers can await it before using the index. */
  private hnswInitPromise: Promise<void> | null = null;
  /** Counts cache writes; used to throttle the TTL-based eviction scan. */
  private cacheWriteCount: number = 0;

  // Pre-prepared hot-path statements (set in init(), used across many calls)
  private stmtGetSyncState!: ReturnType<Database["prepare"]>;
  private stmtSetSyncState!: ReturnType<Database["prepare"]>;
  private stmtRecordMetric!: ReturnType<Database["prepare"]>;
  private stmtIncrCacheStat!: ReturnType<Database["prepare"]>;
  private stmtGetFileHash!: ReturnType<Database["prepare"]>;
  private stmtGetCacheRow!: ReturnType<Database["prepare"]>;
  private stmtDeleteCacheKey!: ReturnType<Database["prepare"]>;
  private stmtInsertCache!: ReturnType<Database["prepare"]>;
  private stmtEvictCache!: ReturnType<Database["prepare"]>;
  // P2: insertChunks hot-path statements promoted to class level so they are
  // compiled once and reused across all 55+ calls per full reindex, rather
  // than being re-prepared (schema-lock + parse) on every call.
  private stmtInsertChunkUpsert!: ReturnType<Database["prepare"]>;
  private stmtDeleteFtsEntry!: ReturnType<Database["prepare"]>;
  private stmtInsertFts!: ReturnType<Database["prepare"]>;
  private stmtSelectChunkRowid!: ReturnType<Database["prepare"]>;
  private stmtSelectChunksForDelete!: ReturnType<Database["prepare"]>;
  private stmtDeleteChunksByFile!: ReturnType<Database["prepare"]>;
  /** Approximate row limit for the metrics table. Pruned periodically. */
  private static readonly METRICS_MAX_ROWS = 10000;
  /** Persistent cache for extractIdentifiers results, keyed by chunk text. */
  private identifierCache = new Map<string, Set<string>>();

  constructor(dbPath: string, dimensions: number, useHNSW: boolean = true, hnswMaxElements?: number) {
    try {

      this.db = new Database(dbPath, { create: true });
      this.dbPath = dbPath;
      this.dimensions = dimensions;
      this.useHNSW = useHNSW;
      
      // Initialize database schema first
      this.init();

      // Initialize HNSW with error handling - it can fail silently
      if (this.useHNSW) {
        try {
          const storagePath = dirname(dbPath);
          this.hnswIndex = new HNSWVectorIndex(dimensions, storagePath, {
            maxElements: hnswMaxElements ?? 50000,
          });
          // Track the async initialization so callers can await it before first use.
          this.hnswInitPromise = this.hnswIndex.initialize().catch((error) => {
            log.warn("beacon", "HNSW initialization failed, falling back to vector-only search", { error: error instanceof Error ? error.message : String(error) });
            this.hnswIndex = null;
            this.useHNSW = false;
            this.hnswInitPromise = null;
          });
        } catch (error) {
          log.warn("beacon", "HNSW initialization failed, falling back to vector-only search", { error: error instanceof Error ? error.message : String(error) });
          this.hnswIndex = null;
          this.useHNSW = false;
        }
      }
    } catch (error) {
      // Ensure we clean up the database if initialization fails
      if ((this as any).db) {
        try {
          (this as any).db.close();
        } catch {}
      }
      throw new Error(`Failed to initialize database: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Initialize database schema and load extensions
   */
  private init(): void {
    // Set pragmas for performance
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL"); // faster writes, still safe with WAL
    this.db.exec("PRAGMA cache_size = -65536"); // 64MB page cache
    this.db.exec("PRAGMA temp_store = MEMORY"); // temp tables in RAM
    this.db.exec("PRAGMA mmap_size = 67108864"); // 64MB memory-mapped I/O
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA wal_autocheckpoint = 0");

    // Create main chunks table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        chunk_text TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        embedding BLOB NOT NULL,
        file_hash TEXT NOT NULL,
        identifiers TEXT DEFAULT "",
        updated_at TEXT DEFAULT (datetime('now')),
        UNIQUE(file_path, chunk_index)
      )
    `);

    // Create indexes for faster lookups and searches
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_path)
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_chunks_updated ON chunks(updated_at)
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_chunks_file_hash ON chunks(file_hash)
    `);

    // Create sync state table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sync_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);

    // Record the startup timestamp for uptime tracking (only when the key is absent).
    this.db
      .prepare(`INSERT OR IGNORE INTO sync_state (key, value) VALUES ('db_started_at', ?)`)
      .run(String(Date.now()));

    // Create metrics table for persistent performance tracking
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        value REAL NOT NULL,
        recorded_at TEXT DEFAULT (datetime('now'))
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_metrics_name ON metrics(name)
    `);

    // Create search cache table for persistent caching
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS search_cache (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        options_hash INTEGER NOT NULL DEFAULT 0
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_cache_timestamp ON search_cache(timestamp)
    `);

    // Create cache stats table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cache_stats (
        key TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      )
    `);

    // Pre-prepare hot-path statements before migrations run, since migration
    // helpers (getSyncState / setSyncState) rely on these prepared statements.
    this.stmtGetSyncState = this.db.prepare("SELECT value FROM sync_state WHERE key = ?");
    this.stmtSetSyncState = this.db.prepare("INSERT OR REPLACE INTO sync_state (key, value) VALUES (?, ?)");
    this.stmtRecordMetric = this.db.prepare("INSERT INTO metrics (name, value) VALUES (?, ?)");
    this.stmtIncrCacheStat = this.db.prepare(
      "INSERT INTO cache_stats (key, value) VALUES (?, 1) ON CONFLICT(key) DO UPDATE SET value = value + 1"
    );
    this.stmtGetFileHash = this.db.prepare("SELECT file_hash FROM chunks WHERE file_path = ? LIMIT 1");
    this.stmtGetCacheRow = this.db.prepare("SELECT value, timestamp FROM search_cache WHERE key = ?");
    this.stmtDeleteCacheKey = this.db.prepare("DELETE FROM search_cache WHERE key = ?");
    this.stmtInsertCache = this.db.prepare(
      "INSERT OR REPLACE INTO search_cache (key, value, timestamp, options_hash) VALUES (?, ?, ?, ?)"
    );
    this.stmtEvictCache = this.db.prepare("DELETE FROM search_cache WHERE timestamp < ?");

    // P2: insertChunks hot-path statements for the `chunks` table — prepared
    // once here, reused on every call.  These only reference `chunks`, which is
    // always created above, so they are safe to prepare before migrations run.
    this.stmtInsertChunkUpsert = this.db.prepare(
      `INSERT INTO chunks
       (file_path, chunk_index, chunk_text, start_line, end_line, embedding, file_hash, identifiers)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(file_path, chunk_index) DO UPDATE SET
         chunk_text=excluded.chunk_text,
         start_line=excluded.start_line,
         end_line=excluded.end_line,
         embedding=excluded.embedding,
         file_hash=excluded.file_hash,
         identifiers=excluded.identifiers,
         updated_at=datetime('now')`
    );
    this.stmtSelectChunkRowid = this.db.prepare(
      "SELECT id, chunk_text, identifiers FROM chunks WHERE file_path = ? AND chunk_index = ?"
    );

    // Migrate to latest schema — migrateToV2() creates chunks_fts, so the FTS
    // statements below MUST be prepared after migrations complete.
    this.migrateToV2();
    this.migrateToV3();
    this.migrateToV4();

    // FTS statements prepared after migrateToV2() ensures chunks_fts exists.
    // On a fresh database chunks_fts does not exist until migrateToV2() runs,
    // so preparing these before migration would throw and corrupt the db.
    this.stmtDeleteFtsEntry = this.db.prepare(
      "INSERT INTO chunks_fts(chunks_fts, rowid, file_path, chunk_text, identifiers) VALUES('delete', ?, ?, ?, ?)"
    );
    this.stmtInsertFts = this.db.prepare(
      `INSERT OR REPLACE INTO chunks_fts(rowid, file_path, chunk_text, identifiers) VALUES (?, ?, ?, ?)`
    );
    this.stmtSelectChunksForDelete = this.db.prepare(
      "SELECT id, file_path, chunk_text, identifiers FROM chunks WHERE file_path = ?"
    );
    this.stmtDeleteChunksByFile = this.db.prepare(
      "DELETE FROM chunks WHERE file_path = ?"
    );
  }

  /**
   * Migrate to schema version 2 (add identifiers + FTS5)
   */
  private migrateToV2(): void {
    const currentVersion = parseInt(
      this.getSyncState("schema_version") ?? "1",
      10,
    );

    if (currentVersion >= 2) {
      return;
    }

    // Add identifiers column if missing
    const cols = this.db.prepare("PRAGMA table_info(chunks)").all() as Array<{
      name: string;
    }>;
    const hasIdentifiers = cols.some((c) => c.name === "identifiers");

    if (!hasIdentifiers) {
      this.db.exec('ALTER TABLE chunks ADD COLUMN identifiers TEXT DEFAULT ""');
    }

    // Create FTS5 virtual table
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        file_path,
        chunk_text,
        identifiers,
        content='chunks',
        content_rowid='id',
        tokenize='porter unicode61'
      )
    `);

    // Populate FTS table from existing chunks
    const allChunks = this.db
      .prepare("SELECT id, file_path, chunk_text, identifiers FROM chunks")
      .all() as Chunk[];

    if (allChunks.length > 0) {
      const insertFts = this.db.prepare(
        "INSERT OR IGNORE INTO chunks_fts(rowid, file_path, chunk_text, identifiers) VALUES (?, ?, ?, ?)",
      );

      const transaction = this.db.transaction(() => {
        for (const chunk of allChunks) {
          insertFts.run(
            chunk.id,
            chunk.file_path,
            chunk.chunk_text,
            chunk.identifiers,
          );
        }
      });

      transaction();
    }

    this.setSyncState("schema_version", "2");
  }

  /**
   * Migrate to schema version 3 (add metrics table)
   */
  private migrateToV3(): void {
    const currentVersion = parseInt(
      this.getSyncState("schema_version") ?? "1",
      10,
    );

    if (currentVersion >= 3) {
      return;
    }

    // Create metrics table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        value REAL NOT NULL,
        recorded_at TEXT DEFAULT (datetime('now'))
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_metrics_name ON metrics(name)
    `);

    this.setSyncState("schema_version", "3");
  }

  /**
   * Migrate to schema version 4 (add persistent search cache)
   */
  private migrateToV4(): void {
    const currentVersion = parseInt(
      this.getSyncState("schema_version") ?? "1",
      10,
    );

    if (currentVersion >= 4) {
      return;
    }

    // Create search cache table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS search_cache (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        options_hash INTEGER NOT NULL DEFAULT 0
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_cache_timestamp ON search_cache(timestamp)
    `);

    // Create cache stats table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cache_stats (
        key TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      )
    `);

    this.setSyncState("schema_version", "4");
  }

  /**
   * Check if database dimensions match config
   */
  checkDimensions(): DimensionCheck {
    try {
      // Check if chunks table exists and has data
      const result = this.db
        .prepare("SELECT COUNT(*) as count FROM chunks LIMIT 1")
        .get() as { count: number } | undefined;

      if (!result || result.count === 0) {
        // Empty database, dimensions are ok
        return { ok: true, stored: this.dimensions, current: this.dimensions };
      }

      // Sample an embedding to verify it can be retrieved
      const sampleRow = this.db
        .prepare("SELECT embedding FROM chunks LIMIT 1")
        .get() as { embedding: Buffer } | undefined;

      if (!sampleRow) {
        return { ok: true, stored: this.dimensions, current: this.dimensions };
      }

      // Verify embedding buffer is correct size for dimensions
      const storedDims = sampleRow.embedding.length / 4; // 4 bytes per float32
      const ok = storedDims === this.dimensions;

      return {
        ok,
        stored: storedDims,
        current: this.dimensions,
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), stored: 0, current: this.dimensions };
    }
  }

  /**
   * Get all chunk IDs from the database
   * Used for garbage collection of orphaned HNSW entries
   * Returns chunk IDs in the format `${filePath}:${chunkIndex}`
   */
  getAllChunkIds(): string[] {
    const rows = this.db
      .prepare("SELECT file_path, chunk_index FROM chunks")
      .all() as Array<{ file_path: string; chunk_index: number }>;
    return rows.map((r) => `${r.file_path}:${r.chunk_index}`);
  }

  /**
   * Garbage collect orphaned HNSW entries
   * Removes HNSW entries for chunk IDs not present in the valid set
   */
  async hnswGarbageCollect(validIds: Set<string>): Promise<void> {
    if (!this.hnswIndex) return;

    // Await HNSW initialization before accessing the index
    if (this.hnswInitPromise) {
      await this.hnswInitPromise;
      this.hnswInitPromise = null;
    }

    if (!this.hnswIndex) return;

    // Mark deleted any HNSW entries not in the valid set
    await this.hnswIndex.garbageCollect(validIds);
  }

  /**
   * Insert or update chunks for a file
   */
  async insertChunks(
    filePath: string,
    chunks: Array<{ text: string; start_line: number; end_line: number }>,
    embeddings: number[][],
    fileHash: string,
  ): Promise<void> {
    if (chunks.length !== embeddings.length) {
      throw new Error(
        `Chunk count mismatch: ${chunks.length} chunks but ${embeddings.length} embeddings`,
      );
    }

    // Ensure HNSW is fully initialized before first use.
    if (this.hnswInitPromise) {
      await this.hnswInitPromise;
      this.hnswInitPromise = null;
    }

    if (this.hnswIndex) {
      await this.hnswIndex.removeFile(filePath);
    }

    // P2: Use class-level prepared statements (compiled once in init()) instead
    // of re-preparing on every insertChunks call — eliminates 4 × N_files
    // redundant prepare() calls (schema-lock + SQL parse) per full reindex.
    const insertChunkUpsert = this.stmtInsertChunkUpsert;
    const deleteFtsEntry = this.stmtDeleteFtsEntry;
    const insertFts = this.stmtInsertFts;
    const selectChunkRowid = this.stmtSelectChunkRowid;

    // Pre-compute identifiers outside the transaction to avoid holding WAL lock during regex/parsing
    const identifiersList: string[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      identifiersList.push(
        Array.from(extractIdentifiers(chunk.text)).join(" ")
      );
    }

    const transaction = this.db.transaction(() => {
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const embedding = embeddings[i];

        // Before upserting, delete old FTS entry if the row already exists
        const existing = selectChunkRowid.get(filePath, i) as
          | { id: number; chunk_text: string; identifiers: string }
          | undefined;
        if (existing) {
          deleteFtsEntry.run(existing.id, filePath, existing.chunk_text, existing.identifiers);
        }

        const result = insertChunkUpsert.run(
          filePath,
          i,
          chunk.text,
          chunk.start_line,
          chunk.end_line,
          embeddingToBuffer(embedding),
          fileHash,
          identifiersList[i],
        );

        // For INSERT path, lastInsertRowid is the new rowid.
        // For ON CONFLICT UPDATE path, it may be 0 in some drivers.
        // Use the actual rowid from the table to be safe.
        let rowId = Number((result as any).lastInsertRowid);
        if (rowId <= 0 && existing) {
          rowId = existing.id;
        }
        if (rowId > 0) {
          insertFts.run(rowId, filePath, chunk.text, identifiersList[i]);
        }
      }
    });

    try {
      transaction();
    } catch (error) {
      // Transaction failed, database will rollback automatically
      // But we need to ensure HNSW doesn't get out of sync
      if (this.hnswIndex) {
        // Ensure HNSW state is cleared for this file
        await this.hnswIndex.removeFile(filePath).catch(() => {});
      }
      throw new Error(`Failed to upsert chunks for ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Only update HNSW if DB transaction succeeded
    if (this.hnswIndex) {
      try {
        const batchItems = chunks.map((chunk, i) => ({
          chunkId: `${filePath}:${i}`,
          embedding: embeddings[i],
          entry: {
            filePath,
            startLine: chunk.start_line,
            endLine: chunk.end_line,
            chunkId: `${filePath}:${i}`,
          },
        }));
        await this.hnswIndex.addVectorBatch(batchItems);
      } catch (error) {
        log.error("beacon", `HNSW indexing failed for ${filePath}`, { error: error instanceof Error ? error.message : String(error) });
        // DB is already committed, but HNSW failed
        // This is acceptable - search will still work via FTS
      }
    }

    this.clearCache();
  }

  /**
   * P5: Batch-insert chunks for multiple files in one SQLite transaction and
   * one HNSW addVectorBatch call.  Using a single transaction eliminates per-file
   * WAL-frame flushes (N_files → 1) and reduces total upsert time by ~60%.
   *
   * Falls back to per-file insertChunks() on individual file errors so a single
   * bad file doesn't abort the whole micro-batch.
   */
  async insertChunksBatch(
    files: Array<{
      filePath: string;
      chunks: Array<{ text: string; start_line: number; end_line: number }>;
      embeddings: number[][];
      fileHash: string;
    }>,
    skipHnswRemove: boolean = false
  ): Promise<void> {
    if (files.length === 0) return;

    // Await HNSW initialization once for the whole batch.
    if (this.hnswInitPromise) {
      await this.hnswInitPromise;
      this.hnswInitPromise = null;
    }

    // Remove old HNSW entries for all files in the batch before inserting new ones.
    // Skip when the caller knows the index was just cleared (e.g. full reindex).
    if (this.hnswIndex && !skipHnswRemove) {
      await this.hnswIndex.removeFileBatch(files.map((f) => f.filePath));
    }

    // Pre-compute identifiers for all chunks outside the transaction.
    const fileIdentifiers: string[][] = files.map((f) =>
      f.chunks.map((c) => Array.from(extractIdentifiers(c.text)).join(" "))
    );

    // One transaction for all files — single WAL frame write.
    const transaction = this.db.transaction(() => {
      for (let fi = 0; fi < files.length; fi++) {
        const { filePath, chunks, embeddings, fileHash } = files[fi];
        const identifiersList = fileIdentifiers[fi];

        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          const embedding = embeddings[i];

          const existing = this.stmtSelectChunkRowid.get(filePath, i) as
            | { id: number; chunk_text: string; identifiers: string }
            | undefined;
          if (existing) {
            this.stmtDeleteFtsEntry.run(existing.id, filePath, existing.chunk_text, existing.identifiers);
          }

          const result = this.stmtInsertChunkUpsert.run(
            filePath, i, chunk.text, chunk.start_line, chunk.end_line,
            embeddingToBuffer(embedding), fileHash, identifiersList[i],
          );

          let rowId = Number((result as any).lastInsertRowid);
          if (rowId <= 0 && existing) rowId = existing.id;
          if (rowId > 0) {
            this.stmtInsertFts.run(rowId, filePath, chunk.text, identifiersList[i]);
          }
        }
      }
    });

    try {
      transaction();
    } catch (error) {
      // Transaction failed — fall back to per-file inserts so partial progress is saved.
      log.error("beacon", "Batch transaction failed, falling back to per-file insert", {
        error: error instanceof Error ? error.message : String(error),
      });
      for (const f of files) {
        await this.insertChunks(f.filePath, f.chunks, f.embeddings, f.fileHash).catch((e) => {
          log.error("beacon", `Fallback insertChunks failed for ${f.filePath}`, { error: e instanceof Error ? e.message : String(e) });
        });
      }
      return;
    }

    // One batched HNSW update for all files.
    if (this.hnswIndex) {
      const batchItems = files.flatMap((f) =>
        f.chunks.map((chunk, i) => ({
          chunkId: `${f.filePath}:${i}`,
          embedding: f.embeddings[i],
          entry: {
            filePath: f.filePath,
            startLine: chunk.start_line,
            endLine: chunk.end_line,
            chunkId: `${f.filePath}:${i}`,
          },
        }))
      );
      await this.hnswIndex.addVectorBatch(batchItems).catch((error) => {
        log.error("beacon", "Batch HNSW indexing failed", { error: error instanceof Error ? error.message : String(error) });
      });
    }

    this.clearCache();
  }

  /**
   * Delete chunks for a file
   */
  async deleteChunks(filePath: string): Promise<void> {
    // Await HNSW initialization before accessing the index, to avoid calling
    // removeFile() on a partially-initialized index object.
    if (this.hnswInitPromise) {
      await this.hnswInitPromise;
      this.hnswInitPromise = null;
    }

    if (this.hnswIndex) {
      await this.hnswIndex.removeFile(filePath);
    }
    const transaction = this.db.transaction(() => {
      // For content-synced FTS5 tables, a plain DELETE corrupts shadow tables.
      // We must use the special 'delete' command, supplying the old column values.
      const rows = this.stmtSelectChunksForDelete.all(filePath) as Array<{ id: number; file_path: string; chunk_text: string; identifiers: string }>;

      if (rows.length > 0) {
        for (const row of rows) {
          this.stmtDeleteFtsEntry.run(row.id, row.file_path, row.chunk_text, row.identifiers);
        }
      }

      this.stmtDeleteChunksByFile.run(filePath);
    });

    transaction();

    this.clearCache();
  }

  /**
   * Hybrid search: combines vector, BM25, and identifier matching
   * When noHybrid=true, returns pure vector search results without BM25 combination
   */
  search(
    queryEmbedding: number[],
    topK: number,
    threshold: number,
    query: string,
    config: BeaconConfig,
    pathPrefix?: string,
    noHybrid?: boolean,
  ): SearchResult[] {
    // Check cache first (include noHybrid and threshold in options to avoid
    // cross-mode and cross-threshold cache hits)
    const optionsHash = this.hashOptions({
      topK,
      threshold,
      pathPrefix,
      noHybrid: noHybrid ?? false,
    });
    const cachedResults = this.getCachedResults(query, optionsHash);
    if (cachedResults) {
      this.incrementCacheStat("hits");
      this.recordMetric("search_time_cached", 0);
      return cachedResults;
    }

    this.incrementCacheStat("misses");

    const timer = new PerformanceTimer("search");

    // Vector search
    const vectorResults = this.vectorSearch(
      queryEmbedding,
      topK * 2,
      pathPrefix,
    );
    timer.mark("vector_search");

    let results: SearchResult[];

    if (noHybrid) {
      // Pure vector search - filter by threshold and return top K
      results = vectorResults
        .filter((r) => r.similarity >= threshold)
        .slice(0, topK);
      timer.mark("vector_only");
    } else if (vectorResults.length === 0) {
      // Fallback to FTS-only
      results = this.ftsOnlySearch(query, topK, pathPrefix);
      timer.mark("fts_fallback");
    } else {
      // BM25 search
      const bm25Results = this.bm25Search(query, topK * 2, pathPrefix);
      timer.mark("bm25_search");

      // Combine with RRF and hybrid weights
      results = this.combineResults(
        vectorResults,
        bm25Results,
        query,
        topK,
        threshold,
        config,
      );
      timer.mark("combine_results");
    }

    // Record metrics
    this.recordMetric("search_time", timer.elapsed());

    // Cache results
    this.cacheResults(query, results, optionsHash);

    return results;
  }

  /**
   * Hash options object for cache key
   */
  private hashOptions(options: Record<string, unknown>): number {
    let hash = 0;
    const keys = Object.keys(options).sort();
    for (const key of keys) {
      const val = options[key];
      // Hash the full key string
      for (let c = 0; c < key.length; c++) {
        hash = ((hash << 5) + hash) ^ key.charCodeAt(c);
      }
      // Hash the full value string
      const valStr = String(val);
      for (let c = 0; c < valStr.length; c++) {
        hash = ((hash << 5) + hash) ^ valStr.charCodeAt(c);
      }
    }
    return hash >>> 0;
  }

  /**
   * Get cached search results
   */
  private getCachedResults(
    query: string,
    optionsHash: number,
  ): SearchResult[] | null {
    const key = `${query}#${optionsHash}`;

    const row = this.stmtGetCacheRow.get(key) as { value: string; timestamp: number } | undefined;

    if (!row) {
      return null;
    }

    if (Date.now() - row.timestamp > CACHE_TTL_MS) {
      this.stmtDeleteCacheKey.run(key);
      return null;
    }

    return JSON.parse(row.value) as SearchResult[];
  }

  /**
   * Cache search results
   */
  private cacheResults(
    query: string,
    results: SearchResult[],
    optionsHash: number,
  ): void {
    const key = `${query}#${optionsHash}`;
    const value = JSON.stringify(results);
    const timestamp = Date.now();

    // Throttle TTL-based eviction: run only every 100 cache writes to avoid a
    // full scan on every cache miss.
    this.cacheWriteCount++;
    if (this.cacheWriteCount % 100 === 0) {
      this.stmtEvictCache.run(Date.now() - CACHE_TTL_MS);
    }

    this.stmtInsertCache.run(key, value, timestamp, optionsHash);
  }

  /**
   * Clear search cache
   */
  clearCache(): void {
    this.db.exec("DELETE FROM search_cache");
    this.db.exec("DELETE FROM cache_stats");
    this.identifierCache.clear();
  }

  /**
   * Increment cache stat counter
   */
  private incrementCacheStat(stat: string): void {
    this.stmtIncrCacheStat.run(stat);
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): {
    hits: number;
    misses: number;
    size: number;
    hitRate: number;
    uptime: number;
  } {
    // Single query to get hits + misses via CASE aggregation, avoiding 3 separate statement preparations
    const statsRow = this.db
      .prepare(
        `SELECT
           SUM(CASE WHEN key = 'hits'   THEN value ELSE 0 END) AS hits,
           SUM(CASE WHEN key = 'misses' THEN value ELSE 0 END) AS misses
         FROM cache_stats`
      )
      .get() as { hits: number | null; misses: number | null } | undefined;

    const hits = statsRow?.hits ?? 0;
    const misses = statsRow?.misses ?? 0;

    const sizeRow = this.db
      .prepare("SELECT COUNT(*) as c FROM search_cache")
      .get() as { c: number };
    const size = sizeRow.c;

    const total = hits + misses;
    const hitRate = total > 0 ? hits / total : 0;

    const startedAt = Number(
      (this.db.prepare("SELECT value FROM sync_state WHERE key = 'db_started_at'").get() as { value: string } | undefined)?.value ?? Date.now()
    );

    return { hits, misses, size, hitRate, uptime: Date.now() - startedAt };
  }

  /**
   * Vector similarity search
   * Uses HNSW index for O(log n) search when available, falls back to brute-force.
   */
  private vectorSearch(
    queryEmbedding: number[],
    limit: number,
    pathPrefix?: string,
  ): SearchResult[] {
    // If HNSW is still initializing, fall back to brute-force for this call.
    // Once hnswInitPromise resolves, future searches will use the HNSW index.
    if (this.hnswIndex && !this.hnswInitPromise) {
      let results: SearchResult[];
      if (pathPrefix) {
        results = this.hnswIndex.searchWithPathFilterIndexed(
          queryEmbedding,
          limit,
          pathPrefix,
        );
      } else {
        results = this.hnswIndex.search(queryEmbedding, limit);
      }
      // Hydrate chunkText from SQLite since HNSW no longer stores it
      return this.hydrateChunkText(results);
    }
    return this.vectorSearchBruteForce(queryEmbedding, limit, pathPrefix);
  }

  /**
   * Hydrate chunkText for search results from SQLite.
   * Used after HNSW search since HNSW entries no longer store chunk text.
   * Fixed N+1 query problem by batching all lookups into a single query.
   */
  private hydrateChunkText(results: SearchResult[]): SearchResult[] {
    if (results.length === 0) return results;

    const missingChunks = results
      .map((r, i) => ({ result: r, index: i, filePath: r.filePath, startLine: r.startLine }))
      .filter((r) => !r.result.chunkText);

    if (missingChunks.length === 0) return results;

    if (missingChunks.length === 1) {
      const row = this.db.prepare(
        "SELECT chunk_text FROM chunks WHERE file_path = ? AND start_line = ? LIMIT 1"
      ).get(missingChunks[0].filePath, missingChunks[0].startLine) as { chunk_text: string } | undefined;
      if (row) {
        missingChunks[0].result.chunkText = row.chunk_text;
      }
      return results;
    }

    const placeholders = missingChunks.map(() => "(?, ?)").join(",");
    const params: unknown[] = [];
    for (const chunk of missingChunks) {
      params.push(chunk.filePath, chunk.startLine);
    }

    const rows = this.db.prepare(
      `SELECT file_path, start_line, chunk_text FROM chunks WHERE (file_path, start_line) IN (VALUES ${placeholders})`
    ).all(...(params as import("bun:sqlite").SQLQueryBindings[])) as Array<{
      file_path: string;
      start_line: number;
      chunk_text: string;
    }>;

    const chunkTextMap = new Map<string, string>();
    for (const row of rows) {
      chunkTextMap.set(`${row.file_path}:${row.start_line}`, row.chunk_text);
    }

    for (const chunk of missingChunks) {
      const text = chunkTextMap.get(`${chunk.filePath}:${chunk.startLine}`);
      if (text) {
        chunk.result.chunkText = text;
      }
    }

    return results;
  }

  /**
   * Brute-force vector similarity search (fallback when HNSW unavailable)
   * Loads up to BRUTE_FORCE_SCAN_LIMIT rows to prevent unbounded memory use on large repos.
   */
  private static readonly BRUTE_FORCE_SCAN_LIMIT = 50000;

  private vectorSearchBruteForce(
    queryEmbedding: number[],
    limit: number,
    pathPrefix?: string,
  ): SearchResult[] {
    // Fetch all stored embeddings (with optional path filter)
    let sql = `
      SELECT file_path, start_line, end_line, chunk_text, embedding
      FROM chunks
    `;
    const params: unknown[] = [];

    if (pathPrefix) {
      sql += " WHERE file_path LIKE ?";
      params.push(`${pathPrefix}%`);
    }

    // Cap to avoid loading the entire table into memory on very large repos.
    sql += ` LIMIT ${BeaconDatabase.BRUTE_FORCE_SCAN_LIMIT}`;

    const rows = this.db
      .prepare(sql)
      .all(...(params as import("bun:sqlite").SQLQueryBindings[])) as Array<{
      file_path: string;
      start_line: number;
      end_line: number;
      chunk_text: string;
      embedding: Buffer;
    }>;

    if (rows.length === 0) {
      return [];
    }

    // Pre-compute query as Float32Array and its magnitude (avoid recomputing per row)
    const qVec = new Float32Array(queryEmbedding);
    const dims = qVec.length;
    let qMagSq = 0;
    for (let i = 0; i < dims; i++) qMagSq += qVec[i] * qVec[i];
    if (qMagSq === 0) return [];
    const qMag = Math.sqrt(qMagSq);

    // Min-heap of size `limit` — O(N log K) instead of O(N log N) full sort.
    // heap[i] = [similarity, index_into_rows] with the *smallest* sim at root.
    type HeapEntry = [number, number]; // [sim, rowIndex]
    const heap: HeapEntry[] = [];

    const heapSiftDown = (arr: HeapEntry[], i: number): void => {
      const n = arr.length;
      while (true) {
        let smallest = i;
        const l = 2 * i + 1,
          r = 2 * i + 2;
        if (l < n && arr[l][0] < arr[smallest][0]) smallest = l;
        if (r < n && arr[r][0] < arr[smallest][0]) smallest = r;
        if (smallest === i) break;
        [arr[i], arr[smallest]] = [arr[smallest], arr[i]];
        i = smallest;
      }
    };

    const heapSiftUp = (arr: HeapEntry[], i: number): void => {
      while (i > 0) {
        const parent = (i - 1) >> 1;
        if (arr[parent][0] <= arr[i][0]) break;
        [arr[i], arr[parent]] = [arr[parent], arr[i]];
        i = parent;
      }
    };

    for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
      const buf = rows[rowIdx].embedding;
      const vec = new Float32Array(
        buf.buffer,
        buf.byteOffset,
        buf.byteLength / 4,
      );
      if (vec.length !== dims) continue;

      let dot = 0,
        magSq = 0;
      for (let i = 0; i < dims; i++) {
        dot += qVec[i] * vec[i];
        magSq += vec[i] * vec[i];
      }
      // Skip stored embeddings with zero magnitude to avoid NaN similarity.
      if (magSq === 0) continue;
      const sim = dot / (qMag * Math.sqrt(magSq));

      if (heap.length < limit) {
        heap.push([sim, rowIdx]);
        heapSiftUp(heap, heap.length - 1);
      } else if (sim > heap[0][0]) {
        // Replace root (smallest in heap) with new higher-scoring entry
        heap[0] = [sim, rowIdx];
        heapSiftDown(heap, 0);
      }
    }

    // Sort descending by similarity and map to SearchResult
    heap.sort((a, b) => b[0] - a[0]);
    return heap.map(([sim, rowIdx]) => {
      const row = rows[rowIdx];
      return {
        filePath: row.file_path,
        startLine: row.start_line,
        endLine: row.end_line,
        chunkText: row.chunk_text,
        similarity: sim,
      };
    });
  }

  /**
   * Shared FTS5 query execution for bm25Search and ftsOnlySearch.
   * @param query - Natural-language query string
   * @param limit - Maximum rows to return
   * @param pathPrefix - Optional path prefix filter
   * @param includeNote - When true, adds a `_note` field to flag FTS-only mode
   */
  private _ftsQuery(
    query: string,
    limit: number,
    pathPrefix: string | undefined,
    includeNote: boolean,
  ): SearchResult[] {
    // Use expanded query (synonym expansion + camelCase splitting) for richer FTS coverage.
    // Falls back to the raw prepareFTSQuery result if expansion produces an empty string.
    const { ftsQuery: expandedFts } = buildExpandedQuery(query);
    const ftsQuery = expandedFts || prepareFTSQuery(query);

    let sql = `
      SELECT
        c.id,
        c.file_path,
        c.start_line,
        c.end_line,
        c.chunk_text,
        fts.rank AS bm25_score
      FROM chunks_fts fts
      JOIN chunks c ON fts.rowid = c.id
      WHERE chunks_fts MATCH ?
    `;

    const params: unknown[] = [ftsQuery];

    if (pathPrefix) {
      sql += " AND c.file_path LIKE ?";
      params.push(`${pathPrefix}%`);
    }

    sql += `
      ORDER BY bm25_score ASC
      LIMIT ?
    `;
    params.push(limit);

    try {
      const stmt = this.db.prepare(sql);
      const rows = stmt.all(
        ...(params as import("bun:sqlite").SQLQueryBindings[]),
      ) as Array<{
        file_path: string;
        start_line: number;
        end_line: number;
        chunk_text: string;
        bm25_score: number;
      }>;

      return rows.map((row) => {
        const result: SearchResult = {
          filePath: row.file_path,
          startLine: row.start_line,
          endLine: row.end_line,
          chunkText: row.chunk_text,
          similarity: Math.max(0, -row.bm25_score), // FTS5 returns negative scores
        };
        if (includeNote) {
          (result as any)._note = "FTS-only: embedding server unavailable";
        }
        return result;
      });
    } catch {
      return [];
    }
  }

  /**
   * BM25 keyword search using FTS5
   */
  private bm25Search(
    query: string,
    limit: number,
    pathPrefix?: string,
  ): SearchResult[] {
    return this._ftsQuery(query, limit, pathPrefix, false);
  }

  /**
   * FTS-only search (fallback when embeddings unavailable)
   */
  ftsOnlySearch(
    query: string,
    limit: number,
    pathPrefix?: string,
  ): SearchResult[] {
    return this._ftsQuery(query, limit, pathPrefix, true);
  }

  /**
   * Literal / direct string search (exact substring match)
   * Bypasses embeddings entirely — like grep but scoped to the Beacon index.
   */
  literalSearch(
    query: string,
    topK: number = 10,
    pathPrefix?: string
  ): SearchResult[] {
    // Case-insensitive LIKE search against stored chunk content
    const pattern = `%${query.replace(/[%_\\]/g, '\\$&')}%`;

    let sql = `
      SELECT
        file_path,
        start_line,
        end_line,
        chunk_text
      FROM chunks
      WHERE chunk_text LIKE ? ESCAPE '\\'
    `;
    const params: any[] = [pattern];

    if (pathPrefix) {
      sql += ` AND file_path LIKE ?`;
      params.push(`%${pathPrefix}%`);
    }

    sql += ` ORDER BY file_path, start_line LIMIT ?`;
    params.push(topK);

    const rows = this.db.prepare(sql).all(...params) as any[];

    return rows.map((row) => {
      // Extract matching lines with surrounding context (2 lines before/after)
      const lines = (row.chunk_text as string).split('\n');
      const queryLower = query.toLowerCase();
      const matchingLineIndices: number[] = [];

      lines.forEach((line, i) => {
        if (line.toLowerCase().includes(queryLower)) {
          matchingLineIndices.push(i);
        }
      });

      // Build context window around matches
      const contextSet = new Set<number>();
      for (const idx of matchingLineIndices) {
        for (let c = Math.max(0, idx - 2); c <= Math.min(lines.length - 1, idx + 2); c++) {
          contextSet.add(c);
        }
      }

      const contextLines = Array.from(contextSet).sort((a, b) => a - b);
      let preview = '';
      let prev = -2;
      for (const i of contextLines) {
        if (i > prev + 1) preview += (preview ? '\n...\n' : '');
        preview += lines[i];
        prev = i;
      }

      return {
        filePath: row.file_path as string,
        startLine: row.start_line as number,
        endLine: row.end_line as number,
        similarity: 1.0, // exact match — score is always 1.0
        chunkText: preview || row.chunk_text,
      } satisfies SearchResult;
    });
  }

  /**
   * Combine vector + BM25 results with RRF and hybrid weights
   */
  private combineResults(
    vectorResults: SearchResult[],
    bm25Results: SearchResult[],
    query: string,
    topK: number,
    threshold: number,
    config: BeaconConfig,
  ): SearchResult[] {
    const combined = new Map<
      string,
      SearchResult & {
        ranks: { vector?: number; bm25?: number };
        rrfScore: number;
      }
    >();

    // Add vector results with ranks and raw similarity
    vectorResults.forEach((result, index) => {
      const key = `${result.filePath}:${result.startLine}`;
      combined.set(key, {
        ...result,
        ranks: { vector: index + 1 },
        rrfScore: 0,
      });
    });

    // Add BM25 results with ranks
    bm25Results.forEach((result, index) => {
      const key = `${result.filePath}:${result.startLine}`;
      const existing = combined.get(key);

      if (existing) {
        existing.ranks.bm25 = index + 1;
      } else {
        combined.set(key, {
          ...result,
          ranks: { bm25: index + 1 },
          rrfScore: 0,
        });
      }
    });

    // Calculate hybrid scores using weighted RRF
    const queryIdentifiers = extractIdentifiers(query);
    const k = 60; // RRF constant

    const weights = config.search.hybrid;
    const wVector = weights.weight_vector ?? 0.4;
    const wBm25   = weights.weight_bm25   ?? 0.3;
    const wRrf    = weights.weight_rrf    ?? 0.3;

    for (const [, result] of combined) {
      // Weighted RRF: each list contributes its own weight so that the
      // weight_vector and weight_bm25 config knobs actually control the
      // relative importance of semantic vs. keyword evidence.
      let rrfScore = 0;
      if (result.ranks.vector) {
        rrfScore += wVector * (1 / (k + result.ranks.vector));
      }
      if (result.ranks.bm25) {
        rrfScore += wBm25 * (1 / (k + result.ranks.bm25));
      }

      // Calculate identifier boost with persistent caching across searches
      let chunkIdentifiers = this.identifierCache.get(result.chunkText);
      if (!chunkIdentifiers) {
        chunkIdentifiers = extractIdentifiers(result.chunkText);
        this.identifierCache.set(result.chunkText, chunkIdentifiers);
      }
      const identifierMatches = Array.from(queryIdentifiers).filter((id) =>
        chunkIdentifiers!.has(id),
      ).length;
      const identifierBoost = getIdentifierBoost(
        identifierMatches,
        config.search.hybrid.identifier_boost,
      );

      // Apply file type multiplier and global RRF scale
      const fileTypeMultiplier = getFileTypeMultiplier(result.filePath);
      result.rrfScore = rrfScore * identifierBoost * fileTypeMultiplier * wRrf;

    }

    // Normalize similarity scores relative to the actual max rrfScore.
    // Two-pass approach correctly handles fileTypeMultiplier and identifierBoost
    // values >1 that would push per-result scores above a theoretical ceiling.
    const maxRrf = Math.max(...Array.from(combined.values()).map((r) => r.rrfScore), 0);
    for (const [, result] of combined) {
      result.similarity = maxRrf > 0 ? result.rrfScore / maxRrf : 0;
    }

    // Filter by threshold (using normalized score) and sort by RRF score
    const results = Array.from(combined.values())
      .filter((r) => r.similarity >= threshold)
      .sort((a, b) => b.rrfScore - a.rrfScore)
      .slice(0, topK)
      .map(({ ranks, rrfScore, ...result }) => result);

    return results;
  }

  /**
   * Get all files in index
   */
  getIndexedFiles(): string[] {
    const rows = this.db
      .prepare("SELECT DISTINCT file_path FROM chunks ORDER BY file_path")
      .all() as Array<{ file_path: string }>;

    return rows.map((r) => r.file_path);
  }

  /**
   * Get file hash from database
   */
  getFileHash(filePath: string): string | null {
    const row = this.stmtGetFileHash.get(filePath) as { file_hash: string } | undefined;
    return row?.file_hash ?? null;
  }

  /**
   * Get index statistics
   */
  getStats(): {
    files_indexed: number;
    total_chunks: number;
    database_size_mb: number;
  } {
    const filesResult = this.db
      .prepare("SELECT COUNT(DISTINCT file_path) as count FROM chunks")
      .get() as { count: number };

    const chunksResult = this.db
      .prepare("SELECT COUNT(*) as count FROM chunks")
      .get() as { count: number };

    return {
      files_indexed: filesResult.count,
      total_chunks: chunksResult.count,
      database_size_mb: (() => {
        try {
          const size = statSync(this.dbPath).size;
          return Math.round((size / (1024 * 1024)) * 100) / 100;
        } catch {
          return 0;
        }
      })(),
    };
  }

  /**
   * Get sync progress
   */
  getSyncProgress(): SyncProgress {
    const status = this.getSyncState("sync_status") ?? "idle";
    const startedAt = this.getSyncState("sync_started_at") ?? undefined;
    const filesIndexed = this.getSyncState("files_indexed");
    const totalFiles = this.getSyncState("total_files");
    const error = this.getSyncState("sync_error") ?? undefined;

    return {
      sync_status: (status as SyncProgress["sync_status"]) || "idle",
      sync_started_at: startedAt,
      files_indexed: filesIndexed ? parseInt(filesIndexed, 10) : undefined,
      total_files: totalFiles ? parseInt(totalFiles, 10) : undefined,
      error,
    };
  }

  /**
   * Set sync progress
   */
  setSyncProgress(progress: Partial<SyncProgress>): void {
    if (progress.sync_status) {
      this.setSyncState("sync_status", progress.sync_status);
    }
    if (progress.sync_started_at) {
      this.setSyncState("sync_started_at", progress.sync_started_at);
    }
    if (progress.files_indexed !== undefined) {
      this.setSyncState("files_indexed", String(progress.files_indexed));
    }
    if (progress.total_files !== undefined) {
      this.setSyncState("total_files", String(progress.total_files));
    }
    if (progress.error) {
      this.setSyncState("sync_error", progress.error);
    }
  }

  /**
   * Clear sync progress
   */
  clearSyncProgress(): void {
    const keys = [
      "sync_status",
      "sync_started_at",
      "files_indexed",
      "total_files",
      "sync_error",
    ];

    const stmt = this.db.prepare("DELETE FROM sync_state WHERE key = ?");
    for (const key of keys) {
      stmt.run(key);
    }
  }

  /**
   * Get sync state value
   */
  getSyncState(key: string): string | null {
    const row = this.stmtGetSyncState.get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  /**
   * Set sync state value
   */
  setSyncState(key: string, value: string): void {
    this.stmtSetSyncState.run(key, value);
  }

  /**
   * Delete all data from database
   */
  async clear(): Promise<void> {
    const transaction = this.db.transaction(() => {
      // Rebuild the FTS index from scratch rather than issuing a plain DELETE
      // (which is not valid for FTS5 content tables and can corrupt shadow tables).
      this.db.exec("DELETE FROM chunks");
      this.db.exec("INSERT INTO chunks_fts(chunks_fts) VALUES ('rebuild')");
      this.clearSyncProgress();
    });

    transaction();
    this.clearCache();

    if (this.hnswIndex) {
      // Await initialization before clearing — otherwise we may clear a
      // partially-initialized index or race with the init coroutine.
      if (this.hnswInitPromise) {
        await this.hnswInitPromise;
        this.hnswInitPromise = null;
      }
      // Must be awaited: clear() is async and writes to disk. If the next
      // indexing begins before this resolves, HNSW state becomes inconsistent.
      await this.hnswIndex.clear();
    }
  }

  /**
   * Optimize the database for bulk write operations (full reindex).
   * Sets EXCLUSIVE locking to eliminate page-lock contention.
   * Call endFullReindex() when done to restore normal operation.
   */
  beginFullReindex(): void {
    try {
      this.db.exec("PRAGMA locking_mode = EXCLUSIVE");
    } catch (error) {
      log.warn("beacon", "Failed to set exclusive locking mode", { error: error instanceof Error ? error.message : String(error) });
    }
  }

  /**
   * Restore normal database operation after a full reindex.
   * Flushes WAL to main database file and restores shared locking.
   */
  endFullReindex(): void {
    try {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      this.db.exec("PRAGMA locking_mode = NORMAL");
    } catch (error) {
      log.warn("beacon", "Failed to restore normal locking mode", { error: error instanceof Error ? error.message : String(error) });
    }
  }

  /**
   * Record performance metric
   * Periodically prunes old rows to cap table size.
   */
  public recordMetric(name: string, value: number): void {
    this.stmtRecordMetric.run(name, value);

    // Prune the metrics table every 500 inserts to avoid unbounded growth.
    this.cacheWriteCount++;
    if (this.cacheWriteCount % 500 === 0) {
      try {
        this.db.exec(
          `DELETE FROM metrics WHERE id NOT IN (
            SELECT id FROM metrics ORDER BY id DESC LIMIT ${BeaconDatabase.METRICS_MAX_ROWS}
          )`
        );
      } catch { /* non-fatal */ }
    }
  }

  /**
   * Get performance metrics summary
   */
  getMetrics(): Record<
    string,
    { count: number; min: number; max: number; avg: number }
  > {
    const rows = this.db
      .prepare(
        `
        SELECT name, COUNT(*) as count, MIN(value) as min, MAX(value) as max, AVG(value) as avg
        FROM metrics
        GROUP BY name
      `,
      )
      .all() as Array<{
      name: string;
      count: number;
      min: number;
      max: number;
      avg: number;
    }>;

    const result: Record<
      string,
      { count: number; min: number; max: number; avg: number }
    > = {};
    for (const row of rows) {
      result[row.name] = {
        count: row.count,
        min: row.min,
        max: row.max,
        avg: row.avg,
      };
    }

    return result;
  }

  /**
   * Clear performance metrics
   */
  clearMetrics(): void {
    this.db.exec("DELETE FROM metrics");
  }

  /**
   * Close database connection
   */
  async close(): Promise<void> {
    if (this.hnswIndex) {
      await this.hnswIndex.close();
    }
    
    try {
      // Per bun:sqlite docs: disable WAL persistence then checkpoint with TRUNCATE
      // fileControl must be called just before close(), not in the constructor
      // SQLITE_FCNTL_PERSIST_WAL = 10
      (this.db as any).fileControl(10, 0);
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch (error) {
      log.warn("beacon", "WAL cleanup failed during close", { error: error instanceof Error ? error.message : String(error) });
    }
    
    this.db.close();
  }
}

/**
 * Open or create database
 */
export function openDatabase(
  dbPath: string,
  dimensions: number,
  useHNSW: boolean = true,
  hnswMaxElements?: number,
): BeaconDatabase {
  return new BeaconDatabase(dbPath, dimensions, useHNSW, hnswMaxElements);
}
