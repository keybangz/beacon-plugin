import type { EmbedderResult } from "./types.js";
export interface ONNXEmbedderConfig {
    modelPath: string;
    dimensions: number;
    maxTokens: number;
    cacheSize?: number;
}
export declare class ONNXEmbedder {
    private session;
    private tokenizer;
    private config;
    private queryCache;
    private initialized;
    constructor(config: ONNXEmbedderConfig);
    initialize(): Promise<EmbedderResult>;
    embed(text: string): Promise<number[]>;
    embedBatch(texts: string[]): Promise<number[][]>;
    private meanPool;
    private normalize;
    clearCache(): void;
    close(): Promise<void>;
    isInitialized(): boolean;
}
export declare function getOrCreateONNXEmbedder(config: ONNXEmbedderConfig): ONNXEmbedder;
export declare function closeONNXEmbedder(modelPath: string): Promise<void>;
//# sourceMappingURL=onnx-embedder.d.ts.map