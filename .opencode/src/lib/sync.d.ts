import type { BeaconConfig } from "./types.js";
import { Embedder } from "./embedder.js";
import { BeaconDatabase } from "./db.js";
export declare function terminateIndexer(db?: BeaconDatabase): boolean;
export declare function isIndexerRunning(db?: BeaconDatabase): boolean;
export declare function shouldTerminate(db: BeaconDatabase): boolean;
export declare class IndexCoordinator {
    private config;
    private db;
    private embedder;
    private repoRoot;
    private useEmbeddings;
    constructor(config: BeaconConfig, db: BeaconDatabase, embedder: Embedder, repoRoot: string);
    performFullIndex(): Promise<{
        success: boolean;
        filesIndexed: number;
    }>;
    performDiffSync(): Promise<{
        success: boolean;
        filesIndexed: number;
    }>;
    private indexFiles;
    private generatePlaceholderEmbedding;
    reembedFile(filePath: string): Promise<boolean>;
    garbageCollect(): number;
}
export declare function initializeIndexing(config: BeaconConfig, repoRoot: string): {
    coordinator: IndexCoordinator;
    db: BeaconDatabase;
};
//# sourceMappingURL=sync.d.ts.map