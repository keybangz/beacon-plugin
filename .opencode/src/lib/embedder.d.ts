/**
 * Embedding API coordination
 * Handles requests to embedding services with retry logic, batching, and query caching
 */
import type { EmbeddingConfig, EmbedderResult } from "./types.js";
/**
 * Embedder class handles communication with embedding API
 * Supports OpenAI-compatible endpoints (Ollama, OpenAI, Voyage AI, LiteLLM, etc.)
 */
export declare class Embedder {
    private config;
    private retryDelays;
    private queryCache;
    /** Maximum tokens the embedding model accepts. Used for hard-truncation. */
    private contextLimit;
    /**
     * @param config - Embedding API configuration
     * @param contextLimit - Model context limit in tokens (defaults to config.embedding.context_limit or 256)
     */
    constructor(config: EmbeddingConfig, contextLimit?: number);
    /**
     * Health check for embedding endpoint
     * @returns Result object with ok status
     */
    ping(): Promise<EmbedderResult>;
    /**
     * Embed a single query text with LRU caching.
     * Use this for search queries instead of embedDocuments([text]) to avoid
     * a redundant HTTP round-trip on repeated or identical queries.
     * @param text - Query text (query_prefix should already be prepended if needed)
     * @returns Embedding vector
     */
    embedQuery(text: string): Promise<number[]>;
    /**
     * Truncate text to stay within the embedding model's context window.
     * Uses a conservative 3-char/token estimate with 80% safety margin
     * to account for tokenization differences between our estimator and
     * the actual embedding model.
     * This is a last-resort safety net; the chunker should already produce
     * correctly-sized chunks, but oversized inputs to Ollama cause hard
     * "input length exceeds context length" errors that silently drop chunks.
     * @param text - Input text
     * @param maxTokens - Maximum allowed tokens (will apply 80% safety margin)
     * @returns Truncated text
     */
    private truncateToContextLimit;
    /**
     * Embed documents with retry logic and batch_size splitting.
     * Splits large arrays into chunks of config.batch_size before sending,
     * preventing Ollama from stalling on files with many chunks.
     * @param documents - Array of text documents to embed
     * @returns Array of embedding vectors (same order as input)
     * @throws Error if embedding fails after retries
     */
    embedDocuments(documents: string[]): Promise<number[][]>;
    /**
     * Embed a single batch with retry logic
     * @param documents - Batch of documents to embed (must fit within batch_size)
     * @returns Array of embedding vectors
     * @throws Error if all retries are exhausted
     */
    private embedBatchWithRetry;
    /**
     * Perform single embedding request
     * @param documents - Documents to embed
     * @returns Array of embedding vectors
     * @throws Error if request fails
     */
    private performEmbedding;
}
//# sourceMappingURL=embedder.d.ts.map