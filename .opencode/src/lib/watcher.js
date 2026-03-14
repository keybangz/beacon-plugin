import chokidar from "chokidar";
import { EventEmitter } from "events";
import { shouldIndex } from "./ignore.js";
export class FileWatcher extends EventEmitter {
    constructor(repoRoot, config, debounceMs = 500) {
        super();
        this.watcher = null;
        this.debounceTimers = new Map();
        this.isRunning = false;
        this.repoRoot = repoRoot;
        this.config = config;
        this.debounceMs = debounceMs;
    }
    start() {
        if (this.watcher) {
            return;
        }
        const includePatterns = this.config.indexing.include;
        const excludePatterns = this.config.indexing.exclude;
        const combinedPatterns = [
            ...includePatterns,
            ...excludePatterns.map((p) => `!${p}`),
        ];
        this.watcher = chokidar.watch(combinedPatterns, {
            cwd: this.repoRoot,
            ignoreInitial: true,
            persistent: true,
            awaitWriteFinish: {
                stabilityThreshold: 200,
                pollInterval: 50,
            },
            usePolling: false,
            alwaysStat: false,
            depth: 50,
            ignorePermissionErrors: true,
        });
        this.watcher
            .on("add", (filePath) => this.handleEvent("add", filePath))
            .on("change", (filePath) => this.handleEvent("change", filePath))
            .on("unlink", (filePath) => this.handleEvent("unlink", filePath))
            .on("error", (error) => this.emit("error", error instanceof Error ? error : new Error(String(error))));
        this.isRunning = true;
    }
    stop() {
        if (this.watcher) {
            this.watcher.close();
            this.watcher = null;
        }
        for (const timer of this.debounceTimers.values()) {
            clearTimeout(timer);
        }
        this.debounceTimers.clear();
        this.isRunning = false;
    }
    isActive() {
        return this.isRunning && this.watcher !== null;
    }
    handleEvent(event, filePath) {
        if (!shouldIndex(filePath, this.config.indexing.include, this.config.indexing.exclude)) {
            return;
        }
        const existingTimer = this.debounceTimers.get(filePath);
        if (existingTimer) {
            clearTimeout(existingTimer);
        }
        const timer = setTimeout(() => {
            this.debounceTimers.delete(filePath);
            this.emit(event, filePath);
        }, this.debounceMs);
        this.debounceTimers.set(filePath, timer);
    }
    async waitForReady() {
        if (!this.watcher) {
            return;
        }
        return new Promise((resolve) => {
            this.watcher.on("ready", () => resolve());
        });
    }
}
const activeWatchers = new Map();
export function getOrCreateWatcher(repoRoot, config) {
    let watcher = activeWatchers.get(repoRoot);
    if (!watcher) {
        watcher = new FileWatcher(repoRoot, config);
        activeWatchers.set(repoRoot, watcher);
    }
    return watcher;
}
export function stopWatcher(repoRoot) {
    const watcher = activeWatchers.get(repoRoot);
    if (watcher) {
        watcher.stop();
        activeWatchers.delete(repoRoot);
    }
}
export function stopAllWatchers() {
    for (const watcher of activeWatchers.values()) {
        watcher.stop();
    }
    activeWatchers.clear();
}
//# sourceMappingURL=watcher.js.map