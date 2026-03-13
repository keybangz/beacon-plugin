/**
 * Embedding API coordination
 * Handles requests to embedding services with retry logic and error handling
 */
/**
 * Embedder class handles communication with embedding API
 * Supports OpenAI-compatible endpoints (Ollama, OpenAI, Voyage AI, LiteLLM, etc.)
 */
export class Embedder {
    constructor(config) {
        this.retryDelays = [1000, 4000]; // 1s, 4s backoff
        this.config = config;
    }
    /**
     * Health check for embedding endpoint
     * @returns Result object with ok status
     */
    async ping() {
        try {
            const headers = {
                "Content-Type": "application/json",
            };
            // Add API key if configured
            if (this.config.api_key_env) {
                const apiKey = process.env[this.config.api_key_env];
                if (apiKey) {
                    headers["Authorization"] = `Bearer ${apiKey}`;
                }
            }
            const response = await fetch(`${this.config.api_base}/models`, {
                method: "GET",
                headers,
            });
            if (!response.ok) {
                return {
                    ok: false,
                    error: `HTTP ${response.status}: ${response.statusText}`,
                };
            }
            return { ok: true };
        }
        catch (error) {
            return {
                ok: false,
                error: error instanceof Error ? error.message : "Unknown error occurred",
            };
        }
    }
    /**
     * Embed documents with retry logic
     * @param documents - Array of text documents to embed
     * @returns Array of embedding vectors
     * @throws Error if embedding fails after retries
     */
    async embedDocuments(documents) {
        if (!documents.length) {
            return [];
        }
        let lastError = null;
        // Try with configured retries
        for (let attempt = 0; attempt <= this.retryDelays.length; attempt++) {
            try {
                const result = await this.performEmbedding(documents);
                return result;
            }
            catch (error) {
                lastError =
                    error instanceof Error
                        ? error
                        : new Error("Unknown embedding error");
                // If this wasn't the last attempt, wait and retry
                if (attempt < this.retryDelays.length) {
                    const delay = this.retryDelays[attempt];
                    await new Promise((resolve) => setTimeout(resolve, delay));
                }
            }
        }
        // All retries exhausted
        throw (lastError ?? new Error("Failed to embed documents after all retries"));
    }
    /**
     * Perform single embedding request
     * @param documents - Documents to embed
     * @returns Array of embedding vectors
     * @throws Error if request fails
     */
    async performEmbedding(documents) {
        const headers = {
            "Content-Type": "application/json",
        };
        // Add API key if configured
        if (this.config.api_key_env) {
            const apiKey = process.env[this.config.api_key_env];
            if (apiKey) {
                headers["Authorization"] = `Bearer ${apiKey}`;
            }
        }
        const body = {
            model: this.config.model,
            input: documents,
        };
        const response = await fetch(`${this.config.api_base}/embeddings`, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
        });
        if (!response.ok) {
            const errorText = await response.text().catch(() => "");
            throw new Error(`Embedding API error (${response.status}): ${errorText || response.statusText}`);
        }
        const data = (await response.json());
        // Extract embeddings from response
        if (!Array.isArray(data.data)) {
            throw new Error("Invalid embedding response: missing data array");
        }
        const embeddings = data.data.sort((a, b) => a.index - b.index).map((item) => item.embedding);
        if (embeddings.length !== documents.length) {
            throw new Error(`Embedding count mismatch: expected ${documents.length}, got ${embeddings.length}`);
        }
        return embeddings;
    }
}
