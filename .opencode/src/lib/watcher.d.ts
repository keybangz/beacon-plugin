import { EventEmitter } from "events";
import type { BeaconConfig } from "./types.js";
export interface WatcherEvents {
    add: (filePath: string) => void;
    change: (filePath: string) => void;
    unlink: (filePath: string) => void;
    error: (error: Error) => void;
}
export declare class FileWatcher extends EventEmitter {
    private watcher;
    private repoRoot;
    private config;
    private debounceTimers;
    private debounceMs;
    private isRunning;
    constructor(repoRoot: string, config: BeaconConfig, debounceMs?: number);
    start(): void;
    stop(): void;
    isActive(): boolean;
    private handleEvent;
    waitForReady(): Promise<void>;
}
export declare function getOrCreateWatcher(repoRoot: string, config: BeaconConfig): FileWatcher;
export declare function stopWatcher(repoRoot: string): void;
export declare function stopAllWatchers(): void;
//# sourceMappingURL=watcher.d.ts.map