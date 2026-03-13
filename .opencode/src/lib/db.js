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
import { Database } from "bun:sqlite";
import { extractIdentifiers, prepareFTSQuery, getFileTypeMultiplier, getIdentifierBoost, } from "./tokenizer.js";
import { SearchCache, PerformanceTimer } from "./cache.js";
const SCHEMA_VERSION = 2;
/**
 * Convert embedding array to buffer for storage
 */
function embeddingToBuffer(arr) {
    const float32Array = new Float32Array(arr);
    return Buffer.from(float32Array.buffer);
}
/**
 * Convert buffer back to embedding array
 */
function bufferToEmbedding(buf) {
    return Array.from(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
}
/**
 * Beacon database class
 * Handles all database operations: schema creation, chunking, searching, state management
 */
export class BeaconDatabase {
    constructor(dbPath, dimensions) {
        this.db = new Database(dbPath, { create: true });
        this.dimensions = dimensions;
        this.searchCache = new SearchCache(1000, 300000); // 1000 items, 5 min TTL
        this.performanceMetrics = new Map();
        this.init();
    }
    /**
     * Initialize database schema and load extensions
     */
    init() {
        // Set pragmas for performance (Bun:SQLite compatible)
        this.db.exec("PRAGMA journal_mode = WAL");
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
        // Note: Vector table (chunks_vec) removed - using BM25 search via FTS5 instead
        // sqlite-vec is not available in Bun runtime
        // Migrate to schema v2
        this.migrateToV2();
    }
    /**
     * Migrate to schema version 2 (add identifiers + FTS5)
     */
    migrateToV2() {
        const currentVersion = parseInt(this.getSyncState("schema_version") ?? "1", 10);
        if (currentVersion >= SCHEMA_VERSION) {
            return;
        }
        // Add identifiers column if missing
        const cols = this.db
            .prepare("PRAGMA table_info(chunks)")
            .all();
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
            .all();
        if (allChunks.length > 0) {
            const insertFts = this.db.prepare("INSERT OR IGNORE INTO chunks_fts(rowid, file_path, chunk_text, identifiers) VALUES (?, ?, ?, ?)");
            const transaction = this.db.transaction(() => {
                for (const chunk of allChunks) {
                    insertFts.run(chunk.id, chunk.file_path, chunk.chunk_text, chunk.identifiers);
                }
            });
            transaction();
        }
        this.setSyncState("schema_version", String(SCHEMA_VERSION));
    }
    /**
     * Check if database dimensions match config
     * Note: With BM25-only search, dimensions are not stored in database
     * This method returns ok:true since embeddings are stored in chunks table
     */
    checkDimensions() {
        try {
            // Check if chunks table exists and has data
            const result = this.db
                .prepare("SELECT COUNT(*) as count FROM chunks LIMIT 1")
                .get();
            if (!result || result.count === 0) {
                // Empty database, dimensions are ok
                return { ok: true, stored: this.dimensions, current: this.dimensions };
            }
            // Sample an embedding to verify it can be retrieved
            const sampleRow = this.db
                .prepare("SELECT embedding FROM chunks LIMIT 1")
                .get();
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
        }
        catch {
            return { ok: true, stored: this.dimensions, current: this.dimensions };
        }
    }
    /**
     * Insert or update chunks for a file
     */
    insertChunks(filePath, chunks, embeddings, fileHash) {
        if (chunks.length !== embeddings.length) {
            throw new Error(`Chunk count mismatch: ${chunks.length} chunks but ${embeddings.length} embeddings`);
        }
        // Use transactions for atomicity
        const transaction = this.db.transaction(() => {
            // First, delete old chunks for this file
            this.db.prepare("DELETE FROM chunks WHERE file_path = ?").run(filePath);
            this.db.prepare("DELETE FROM chunks_fts WHERE file_path = ?").run(filePath);
            // Insert new chunks
            const insertChunk = this.db.prepare(`INSERT INTO chunks
         (file_path, chunk_index, chunk_text, start_line, end_line, embedding, file_hash, identifiers)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
            const insertFts = this.db.prepare(`INSERT INTO chunks_fts(rowid, file_path, chunk_text, identifiers)
         VALUES (?, ?, ?, ?)`);
            for (let i = 0; i < chunks.length; i++) {
                const chunk = chunks[i];
                const embedding = embeddings[i];
                const identifiers = Array.from(extractIdentifiers(chunk.text)).join(" ");
                // Insert into main table - prepare will execute with results
                const chunkInsert = this.db.prepare(`INSERT INTO chunks
           (file_path, chunk_index, chunk_text, start_line, end_line, embedding, file_hash, identifiers)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
                chunkInsert.run(filePath, i, chunk.text, chunk.start_line, chunk.end_line, embeddingToBuffer(embedding), fileHash, identifiers);
                // Get the ID of the inserted chunk
                const lastIdQuery = this.db.prepare("SELECT last_insert_rowid() as id");
                const lastIdResult = lastIdQuery.get();
                const chunkId = lastIdResult.id;
                // Insert into FTS table
                const ftsInsert = this.db.prepare(`INSERT INTO chunks_fts(rowid, file_path, chunk_text, identifiers)
           VALUES (?, ?, ?, ?)`);
                ftsInsert.run(chunkId, filePath, chunk.text, identifiers);
            }
        });
        transaction();
    }
    /**
     * Delete chunks for a file
     */
    deleteChunks(filePath) {
        const transaction = this.db.transaction(() => {
            this.db.prepare("DELETE FROM chunks WHERE file_path = ?").run(filePath);
            this.db.prepare("DELETE FROM chunks_fts WHERE file_path = ?").run(filePath);
        });
        transaction();
    }
    /**
     * Hybrid search: combines vector, BM25, and identifier matching
     */
    search(queryEmbedding, topK, threshold, query, config, pathPrefix) {
        // Check cache first
        const cacheKey = `${query}:${topK}:${pathPrefix || ""}`;
        const cachedResults = this.searchCache.get(query, { topK, pathPrefix });
        if (cachedResults) {
            return cachedResults;
        }
        const timer = new PerformanceTimer("search");
        // Vector search
        const vectorResults = this.vectorSearch(queryEmbedding, topK * 2, pathPrefix);
        timer.mark("vector_search");
        let results;
        if (vectorResults.length === 0) {
            // Fallback to FTS-only
            results = this.ftsOnlySearch(query, topK, pathPrefix);
            timer.mark("fts_fallback");
        }
        else {
            // BM25 search
            const bm25Results = this.bm25Search(query, topK * 2, pathPrefix);
            timer.mark("bm25_search");
            // Combine with RRF and hybrid weights
            results = this.combineResults(vectorResults, bm25Results, query, topK, threshold, config);
            timer.mark("combine_results");
        }
        // Record metrics
        this.recordMetric("search_time", timer.elapsed());
        // Cache results
        this.searchCache.set(query, results, { topK, pathPrefix });
        return results;
    }
    /**
     * Vector similarity search
     * Note: Currently disabled due to sqlite-vec API compatibility issues
     * Returns empty array to trigger BM25 fallback
     */
    vectorSearch(queryEmbedding, limit, pathPrefix) {
        // Vector search is currently unavailable
        // BM25 search will be used as fallback
        return [];
    }
    /**
     * BM25 keyword search using FTS5
     */
    bm25Search(query, limit, pathPrefix) {
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
        const params = [ftsQuery];
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
            const rows = stmt.all(...params);
            return rows.map((row) => ({
                filePath: row.file_path,
                startLine: row.start_line,
                endLine: row.end_line,
                chunkText: row.chunk_text,
                similarity: Math.max(0, -row.bm25_score), // FTS5 returns negative scores
            }));
        }
        catch {
            // FTS query might fail, return empty
            return [];
        }
    }
    /**
     * FTS-only search (fallback when embeddings unavailable)
     */
    ftsOnlySearch(query, limit, pathPrefix) {
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
        const params = [ftsQuery];
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
            const rows = stmt.all(...params);
            return rows.map((row) => ({
                filePath: row.file_path,
                startLine: row.start_line,
                endLine: row.end_line,
                chunkText: row.chunk_text,
                similarity: Math.max(0, -row.bm25_score),
                _note: "FTS-only: embedding server unavailable",
            }));
        }
        catch {
            return [];
        }
    }
    /**
     * Combine vector + BM25 results with RRF and hybrid weights
     */
    combineResults(vectorResults, bm25Results, query, topK, threshold, config) {
        const combined = new Map();
        // Add vector results with ranks
        vectorResults.forEach((result, index) => {
            const key = `${result.filePath}:${result.startLine}`;
            combined.set(key, {
                ...result,
                ranks: { vector: index + 1 },
                score: 0,
            });
        });
        // Add BM25 results with ranks
        bm25Results.forEach((result, index) => {
            const key = `${result.filePath}:${result.startLine}`;
            const existing = combined.get(key);
            if (existing) {
                existing.ranks.bm25 = index + 1;
            }
            else {
                combined.set(key, {
                    ...result,
                    ranks: { bm25: index + 1 },
                    score: 0,
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
            const identifierMatches = Array.from(queryIdentifiers).filter((id) => chunkIdentifiers.has(id)).length;
            const identifierBoost = getIdentifierBoost(identifierMatches, config.search.hybrid.identifier_boost);
            // Apply file type multiplier
            const fileTypeMultiplier = getFileTypeMultiplier(result.filePath);
            // Combine with weights
            const weights = config.search.hybrid;
            result.score =
                rffScore *
                    identifierBoost *
                    fileTypeMultiplier *
                    (weights.weight_rrf || 0.3);
            // Apply threshold
            if (result.score < threshold) {
                combined.delete(`${result.filePath}:${result.startLine}`);
            }
        }
        // Sort by score and return top K
        return Array.from(combined.values())
            .sort((a, b) => b.score - a.score)
            .slice(0, topK)
            .map(({ ranks, ...result }) => result);
    }
    /**
     * Get all files in index
     */
    getIndexedFiles() {
        const rows = this.db
            .prepare("SELECT DISTINCT file_path FROM chunks ORDER BY file_path")
            .all();
        return rows.map((r) => r.file_path);
    }
    /**
     * Get file hash from database
     */
    getFileHash(filePath) {
        const row = this.db
            .prepare("SELECT file_hash FROM chunks WHERE file_path = ? LIMIT 1")
            .get(filePath);
        return row?.file_hash ?? null;
    }
    /**
     * Get index statistics
     */
    getStats() {
        const filesResult = this.db
            .prepare("SELECT COUNT(DISTINCT file_path) as count FROM chunks")
            .get();
        const chunksResult = this.db
            .prepare("SELECT COUNT(*) as count FROM chunks")
            .get();
        return {
            files_indexed: filesResult.count,
            total_chunks: chunksResult.count,
            database_size_mb: 0, // TODO: calculate from file size
        };
    }
    /**
     * Get sync progress
     */
    getSyncProgress() {
        const status = this.getSyncState("sync_status") ?? "idle";
        const startedAt = this.getSyncState("sync_started_at") ?? undefined;
        const filesIndexed = this.getSyncState("files_indexed");
        const totalFiles = this.getSyncState("total_files");
        const error = this.getSyncState("sync_error") ?? undefined;
        return {
            sync_status: status || "idle",
            sync_started_at: startedAt,
            files_indexed: filesIndexed ? parseInt(filesIndexed, 10) : undefined,
            total_files: totalFiles ? parseInt(totalFiles, 10) : undefined,
            error,
        };
    }
    /**
     * Set sync progress
     */
    setSyncProgress(progress) {
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
    clearSyncProgress() {
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
    getSyncState(key) {
        const row = this.db
            .prepare("SELECT value FROM sync_state WHERE key = ?")
            .get(key);
        return row?.value ?? null;
    }
    /**
     * Set sync state value
     */
    setSyncState(key, value) {
        this.db
            .prepare("INSERT OR REPLACE INTO sync_state (key, value) VALUES (?, ?)")
            .run(key, value);
    }
    /**
     * Delete all data from database
     */
    clear() {
        const transaction = this.db.transaction(() => {
            this.db.exec("DELETE FROM chunks");
            this.db.exec("DELETE FROM chunks_fts");
            // Note: chunks_vec table removed - no longer using sqlite-vec
            this.clearSyncProgress();
        });
        transaction();
        this.searchCache.clear();
    }
    /**
     * Record performance metric
     */
    recordMetric(name, value) {
        if (!this.performanceMetrics.has(name)) {
            this.performanceMetrics.set(name, []);
        }
        this.performanceMetrics.get(name).push(value);
    }
    /**
     * Get performance metrics summary
     */
    getMetrics() {
        const result = {};
        for (const [name, values] of this.performanceMetrics) {
            const count = values.length;
            const min = Math.min(...values);
            const max = Math.max(...values);
            const avg = values.reduce((a, b) => a + b, 0) / count;
            result[name] = { count, min, max, avg };
        }
        return result;
    }
    /**
     * Get cache statistics
     */
    getCacheStats() {
        return this.searchCache.getStats();
    }
    /**
     * Clear performance metrics
     */
    clearMetrics() {
        this.performanceMetrics.clear();
    }
    /**
     * Close database connection
     */
    close() {
        this.db.close();
    }
}
/**
 * Open or create database
 */
export function openDatabase(dbPath, dimensions) {
    return new BeaconDatabase(dbPath, dimensions);
}
