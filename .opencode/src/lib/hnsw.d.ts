import type { SearchResult } from "./types.js";
export interface HNSWIndexConfig {
    dimensions: number;
    maxElements: number;
    efConstruction: number;
    efSearch: number;
    m: number;
}
interface IndexEntry {
    filePath: string;
    startLine: number;
    endLine: number;
    chunkText: string;
    chunkId: string;
}
export declare class HNSWVectorIndex {
    private index;
    private entries;
    private idToInternal;
    private internalToId;
    private nextInternalId;
    private config;
    private indexPath;
    private entriesPath;
    private isDirty;
    constructor(dimensions: number, storagePath: string, config?: Partial<HNSWIndexConfig>);
    initialize(): void;
    private loadFromDisk;
    private saveToDisk;
    addVector(chunkId: string, embedding: number[], entry: IndexEntry): void;
    updateVector(chunkId: string, embedding: number[], entry: IndexEntry): void;
    removeVector(chunkId: string): boolean;
    removeFile(filePath: string): number;
    search(queryEmbedding: number[], topK: number): SearchResult[];
    searchWithPathFilter(queryEmbedding: number[], topK: number, pathPrefix: string): SearchResult[];
    getStats(): {
        totalVectors: number;
        dimensions: number;
    };
    clear(): void;
    close(): void;
    setEfSearch(ef: number): void;
}
export declare function getOrCreateIndex(storagePath: string, dimensions: number, config?: Partial<HNSWIndexConfig>): HNSWVectorIndex;
export declare function closeIndex(storagePath: string): void;
export {};
//# sourceMappingURL=hnsw.d.ts.map