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
import { dirname, join } from "path";
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
  getFileTypeMultiplier,
  getIdentifierBoost,
} from "./tokenizer.js";
import { SearchCache, PerformanceTimer } from "./cache.js";
import { HNSWVectorIndex, type HNSWIndexConfig } from "./hnsw.js";

const SCHEMA_VERSION = 4;
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

  constructor(dbPath: string, dimensions: number, useHNSW: boolean = true) {
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
          this.hnswIndex = new HNSWVectorIndex(dimensions, storagePath);
          this.hnswIndex.initialize();
        } catch (error) {
          console.warn(`[Beacon] HNSW initialization failed: ${error instanceof Error ? error.message : String(error)}. Falling back to vector-only search.`);
          this.hnswIndex = null;
          this.useHNSW = false;
        }
      }
    } catch (error) {
      // Ensure we clean up the database if initialization fails
      if (this.db) {
        try {
          this.db.close();
        } catch {}
      }
      throw new Error(`Failed to initialize database: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Initialize database schema and load extensions
   */
  private init(): void {
    // Set pragmas for performance (Bun:SQLite compatible)
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL"); // faster writes, still safe with WAL
    this.db.exec("PRAGMA cache_size = -32000"); // 32MB page cache
    this.db.exec("PRAGMA temp_store = MEMORY"); // temp tables in RAM
    this.db.exec("PRAGMA mmap_size = 536870912"); // 512MB memory-mapped I/O
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA foreign_keys = ON");

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

    // Note: Vector table (chunks_vec) removed - using BM25 search via FTS5 instead
    // sqlite-vec is not available in Bun runtime

    // Migrate to latest schema
    this.migrateToV2();
    this.migrateToV3();
    this.migrateToV4();
  }

  /**
   * Migrate to schema version 2 (add identifiers + FTS5)
   */
  private migrateToV2(): void {
    const currentVersion = parseInt(
      this.getSyncState("schema_version") ?? "1",
      10,
    );

    if (currentVersion >= SCHEMA_VERSION) {
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

    this.setSyncState("schema_version", String(SCHEMA_VERSION));
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
   * Note: With BM25-only search, dimensions are not stored in database
   * This method returns ok:true since embeddings are stored in chunks table
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
    } catch {
      return { ok: true, stored: this.dimensions, current: this.dimensions };
    }
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

    if (this.hnswIndex) {
      await this.hnswIndex.removeFile(filePath);
    }

    const deleteChunks = this.db.prepare(
      "DELETE FROM chunks WHERE file_path = ?",
    );
    const deleteFts = this.db.prepare(
      "DELETE FROM chunks_fts WHERE file_path = ?",
    );
    const insertChunk = this.db.prepare(
      `INSERT INTO chunks
       (file_path, chunk_index, chunk_text, start_line, end_line, embedding, file_hash, identifiers)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const lastInsertId = this.db.prepare("SELECT last_insert_rowid() as id");
    const insertFts = this.db.prepare(
      `INSERT INTO chunks_fts(rowid, file_path, chunk_text, identifiers)
       VALUES (?, ?, ?, ?)`,
    );

    const transaction = this.db.transaction(() => {
      deleteChunks.run(filePath);
      deleteFts.run(filePath);

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const embedding = embeddings[i];
        const identifiers = Array.from(extractIdentifiers(chunk.text)).join(
          " ",
        );

        insertChunk.run(
          filePath,
          i,
          chunk.text,
          chunk.start_line,
          chunk.end_line,
          embeddingToBuffer(embedding),
          fileHash,
          identifiers,
        );

        const chunkId = (lastInsertId.get() as { id: number }).id;
        insertFts.run(chunkId, filePath, chunk.text, identifiers);
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
      throw new Error(`Failed to insert chunks for ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Only update HNSW if DB transaction succeeded
    if (this.hnswIndex) {
      try {
        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          await this.hnswIndex.addVector(`${filePath}:${i}`, embeddings[i], {
            filePath,
            startLine: chunk.start_line,
            endLine: chunk.end_line,
            chunkText: chunk.text,
            chunkId: `${filePath}:${i}`,
          });
        }
      } catch (error) {
        console.error(`[Beacon] HNSW indexing failed for ${filePath}:`, error);
        // DB is already committed, but HNSW failed
        // This is acceptable - search will still work via FTS
      }
    }
  }

  /**
   * Delete chunks for a file
   */
  async deleteChunks(filePath: string): Promise<void> {
    if (this.hnswIndex) {
      await this.hnswIndex.removeFile(filePath);
    }
    const transaction = this.db.transaction(() => {
      this.db.prepare("DELETE FROM chunks WHERE file_path = ?").run(filePath);
      this.db
        .prepare("DELETE FROM chunks_fts WHERE file_path = ?")
        .run(filePath);
    });

    transaction();
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
    // Check cache first (include noHybrid in options to avoid cross-mode cache hits)
    const optionsHash = this.hashOptions({
      topK,
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
      hash = ((hash << 5) + hash) ^ key.charCodeAt(0);
      hash = ((hash << 5) + hash) ^ String(val).charCodeAt(0);
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

    const row = this.db
      .prepare("SELECT value, timestamp FROM search_cache WHERE key = ?")
      .get(key) as { value: string; timestamp: number } | undefined;

    if (!row) {
      return null;
    }

    if (Date.now() - row.timestamp > CACHE_TTL_MS) {
      this.db.prepare("DELETE FROM search_cache WHERE key = ?").run(key);
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

    // Clean up old entries if cache is large
    const count = (
      this.db.prepare("SELECT COUNT(*) as c FROM search_cache").get() as {
        c: number;
      }
    ).c;
    if (count > 1000) {
      this.db
        .prepare("DELETE FROM search_cache WHERE timestamp < ?")
        .run(Date.now() - CACHE_TTL_MS);
    }

    this.db
      .prepare(
        "INSERT OR REPLACE INTO search_cache (key, value, timestamp, options_hash) VALUES (?, ?, ?, ?)",
      )
      .run(key, value, timestamp, optionsHash);
  }

  /**
   * Clear search cache
   */
  clearCache(): void {
    this.db.exec("DELETE FROM search_cache");
    this.db.exec("DELETE FROM cache_stats");
  }

  /**
   * Increment cache stat counter
   */
  private incrementCacheStat(stat: string): void {
    this.db
      .prepare(
        `
        INSERT INTO cache_stats (key, value) VALUES (?, 1)
        ON CONFLICT(key) DO UPDATE SET value = value + 1
      `,
      )
      .run(stat);
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
    const hits =
      (
        this.db
          .prepare("SELECT value FROM cache_stats WHERE key = 'hits'")
          .get() as { value: number } | undefined
      )?.value ?? 0;
    const misses =
      (
        this.db
          .prepare("SELECT value FROM cache_stats WHERE key = 'misses'")
          .get() as { value: number } | undefined
      )?.value ?? 0;
    const size = (
      this.db.prepare("SELECT COUNT(*) as c FROM search_cache").get() as {
        c: number;
      }
    ).c;
    const total = hits + misses;
    const hitRate = total > 0 ? hits / total : 0;

    return { hits, misses, size, hitRate, uptime: 0 };
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
    if (this.hnswIndex) {
      if (pathPrefix) {
        return this.hnswIndex.searchWithPathFilter(
          queryEmbedding,
          limit,
          pathPrefix,
        );
      }
      return this.hnswIndex.search(queryEmbedding, limit);
    }
    return this.vectorSearchBruteForce(queryEmbedding, limit, pathPrefix);
  }

  /**
   * Brute-force vector similarity search (fallback when HNSW unavailable)
   */
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

    const rows = this.db.prepare(sql).all(...params) as Array<{
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
   * BM25 keyword search using FTS5
   */
  private bm25Search(
    query: string,
    limit: number,
    pathPrefix?: string,
  ): SearchResult[] {
    const ftsQuery = prepareFTSQuery(query);

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
      const rows = stmt.all(...params) as Array<{
        file_path: string;
        start_line: number;
        end_line: number;
        chunk_text: string;
        bm25_score: number;
      }>;

      return rows.map((row) => ({
        filePath: row.file_path,
        startLine: row.start_line,
        endLine: row.end_line,
        chunkText: row.chunk_text,
        similarity: Math.max(0, -row.bm25_score), // FTS5 returns negative scores
      }));
    } catch {
      // FTS query might fail, return empty
      return [];
    }
  }

  /**
   * FTS-only search (fallback when embeddings unavailable)
   */
  ftsOnlySearch(
    query: string,
    limit: number,
    pathPrefix?: string,
  ): SearchResult[] {
    const ftsQuery = prepareFTSQuery(query);

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
      const rows = stmt.all(...params) as Array<{
        file_path: string;
        start_line: number;
        end_line: number;
        chunk_text: string;
        bm25_score: number;
      }>;

      return rows.map((row) => ({
        filePath: row.file_path,
        startLine: row.start_line,
        endLine: row.end_line,
        chunkText: row.chunk_text,
        similarity: Math.max(0, -row.bm25_score),
        _note: "FTS-only: embedding server unavailable",
      }));
    } catch {
      return [];
    }
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

    // Calculate hybrid scores using RRF
    const queryIdentifiers = extractIdentifiers(query);
    const k = 60; // RRF constant

    for (const [, result] of combined) {
      let rffScore = 0;

      if (result.ranks.vector) {
        rffScore += 1 / (k + result.ranks.vector);
      }
      if (result.ranks.bm25) {
        rffScore += 1 / (k + result.ranks.bm25);
      }

      // Calculate identifier boost
      const chunkIdentifiers = extractIdentifiers(result.chunkText);
      const identifierMatches = Array.from(queryIdentifiers).filter((id) =>
        chunkIdentifiers.has(id),
      ).length;
      const identifierBoost = getIdentifierBoost(
        identifierMatches,
        config.search.hybrid.identifier_boost,
      );

      // Apply file type multiplier
      const fileTypeMultiplier = getFileTypeMultiplier(result.filePath);

      // Combine with weights
      const weights = config.search.hybrid;
      result.rrfScore =
        rffScore *
        identifierBoost *
        fileTypeMultiplier *
        (weights.weight_rrf || 0.3);

      // For hybrid search, normalize RRF score to 0-1 range for display
      // Max RRF = 2/61 ≈ 0.033, but after weight_rrf (0.3) multiplier, max is ~0.01
      // Also account for identifier boost and file type multipliers which can increase scores
      const baseMaxRrfScore = (2 / 61) * (weights.weight_rrf || 0.3);
      const normalizedScore = Math.min(1, result.rrfScore / baseMaxRrfScore);
      result.similarity = normalizedScore;
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
    const row = this.db
      .prepare("SELECT file_hash FROM chunks WHERE file_path = ? LIMIT 1")
      .get(filePath) as { file_hash: string } | undefined;

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

    for (const key of keys) {
      this.db.prepare("DELETE FROM sync_state WHERE key = ?").run(key);
    }
  }

  /**
   * Get sync state value
   */
  getSyncState(key: string): string | null {
    const row = this.db
      .prepare("SELECT value FROM sync_state WHERE key = ?")
      .get(key) as { value: string } | undefined;

    return row?.value ?? null;
  }

  /**
   * Set sync state value
   */
  setSyncState(key: string, value: string): void {
    this.db
      .prepare("INSERT OR REPLACE INTO sync_state (key, value) VALUES (?, ?)")
      .run(key, value);
  }

  /**
   * Delete all data from database
   */
  clear(): void {
    const transaction = this.db.transaction(() => {
      this.db.exec("DELETE FROM chunks");
      this.db.exec("DELETE FROM chunks_fts");
      this.clearSyncProgress();
    });

    transaction();
    this.clearCache();

    if (this.hnswIndex) {
      this.hnswIndex.clear();
    }
  }

  /**
   * Record performance metric
   */
  private recordMetric(name: string, value: number): void {
    this.db
      .prepare("INSERT INTO metrics (name, value) VALUES (?, ?)")
      .run(name, value);
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
  close(): void {
    if (this.hnswIndex) {
      this.hnswIndex.close();
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
): BeaconDatabase {
  return new BeaconDatabase(dbPath, dimensions, useHNSW);
}
