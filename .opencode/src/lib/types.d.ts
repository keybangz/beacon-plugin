/**
 * Type definitions for Beacon OpenCode plugin
 * Provides strict typing for configuration, database, and search operations
 */
export interface EmbeddingConfig {
    /** API endpoint for embeddings (e.g., Ollama, OpenAI, etc.) */
    api_base: string;
    /** Embedding model name */
    model: string;
    /** Environment variable name for API key (empty string if not needed) */
    api_key_env: string;
    /** Vector dimensions (must match model output) */
    dimensions: number;
    /** Batch size for embedding requests */
    batch_size: number;
    /** Prefix to prepend to search queries */
    query_prefix: string;
    /** Model context limit in tokens (for hard-truncation). Defaults to 256. */
    context_limit?: number;
    /** Enable/disable embedding generation. When false, uses BM25-only search. */
    enabled?: boolean;
}
export interface ChunkingConfig {
    /** Chunking strategy: "hybrid" combines syntax and semantic boundaries */
    strategy: "hybrid" | "semantic" | "syntactic";
    /** Maximum tokens per chunk */
    max_tokens: number;
    /** Overlap tokens between chunks */
    overlap_tokens: number;
}
export interface IndexingConfig {
    /** Glob patterns to include */
    include: string[];
    /** Glob patterns to exclude */
    exclude: string[];
    /** Maximum file size in KB */
    max_file_size_kb: number;
    /** Auto-index on session start */
    auto_index: boolean;
    /** Maximum number of files to index */
    max_files: number;
    /** Parallel indexing concurrency */
    concurrency: number;
}
export interface HybridSearchWeights {
    /** Weight for vector similarity scores */
    weight_vector: number;
    /** Weight for BM25 scores */
    weight_bm25: number;
    /** Weight for RRF ranking */
    weight_rrf: number;
    /** Penalty for duplicate documents */
    doc_penalty: number;
    /** Boost for identifier matches */
    identifier_boost: number;
    /** Enable debug output in search results */
    debug: boolean;
}
export interface SearchConfig {
    /** Maximum results per query */
    top_k: number;
    /** Minimum similarity threshold */
    similarity_threshold: number;
    /** Hybrid search configuration */
    hybrid: HybridSearchWeights & {
        enabled: boolean;
    };
}
export interface StorageConfig {
    /** Path to database directory */
    path: string;
}
export interface BeaconConfig {
    embedding: EmbeddingConfig;
    chunking: ChunkingConfig;
    indexing: IndexingConfig;
    search: SearchConfig;
    storage: StorageConfig;
}
export interface Chunk {
    id: number;
    file_path: string;
    chunk_index: number;
    chunk_text: string;
    start_line: number;
    end_line: number;
    embedding: Buffer;
    file_hash: string;
    identifiers: string;
    updated_at: string;
}
export interface SearchResult {
    filePath: string;
    startLine: number;
    endLine: number;
    chunkText: string;
    similarity: number;
    score?: number;
    _note?: string;
}
export interface DimensionCheck {
    ok: boolean;
    stored: number;
    current: number;
}
export interface SyncProgress {
    sync_status: "idle" | "in_progress" | "error";
    sync_started_at?: string;
    files_indexed?: number;
    total_files?: number;
    error?: string;
}
export interface EmbedderResult {
    ok: boolean;
    error?: string;
}
export interface EmbedderEmbedding {
    embedding: number[];
    index: number;
}
export interface FileInfo {
    path: string;
    hash: string;
    modified_at: string;
}
export interface ModifiedFile {
    path: string;
    modified_at: string;
}
export interface SearchQuery {
    query: string;
    top_k?: number;
    threshold?: number;
    path_prefix?: string;
    hybrid_enabled?: boolean;
}
export interface SearchResultFormatted {
    file: string;
    lines: string;
    similarity: string;
    score?: string;
    preview: string;
    _note?: string;
}
export interface TokenizerIdentifiers {
    [identifier: string]: number;
}
export interface BM25Scores {
    [docId: number]: number;
}
export interface RRFResult {
    docId: number;
    score: number;
}
export interface MergedConfig extends BeaconConfig {
    _merged: boolean;
}
//# sourceMappingURL=types.d.ts.map