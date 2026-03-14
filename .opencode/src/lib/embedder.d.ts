import type { EmbeddingConfig, EmbedderResult } from "./types.js";
export type EmbedderMode = "api" | "onnx" | "disabled";
export declare class Embedder {
    private config;
    private retryDelays;
    private queryCache;
    private contextLimit;
    private enabled;
    private mode;
    private pendingRequests;
    private onnxEmbedder;
    private storagePath;
    constructor(config: EmbeddingConfig, contextLimit?: number, storagePath?: string);
    private initializeONNX;
    getMode(): EmbedderMode;
    isEnabled(): boolean;
    ping(): Promise<EmbedderResult>;
    embedQuery(text: string): Promise<number[]>;
    private truncateToContextLimit;
    embedDocuments(documents: string[]): Promise<number[][]>;
    private embedSingle;
    private embedBatchWithRetry;
    private performSingleEmbedding;
    private performBatchEmbedding;
    private generatePlaceholderEmbedding;
}
//# sourceMappingURL=embedder.d.ts.map