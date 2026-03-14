import chokidar, { FSWatcher } from "chokidar";
import { EventEmitter } from "events";
import type { BeaconConfig } from "./types.js";
import { shouldIndex } from "./ignore.js";

export interface WatcherEvents {
  add: (filePath: string) => void;
  change: (filePath: string) => void;
  unlink: (filePath: string) => void;
  error: (error: Error) => void;
}

export class FileWatcher extends EventEmitter {
  private watcher: FSWatcher | null = null;
  private repoRoot: string;
  private config: BeaconConfig;
  private debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private debounceMs: number;
  private isRunning: boolean = false;

  constructor(repoRoot: string, config: BeaconConfig, debounceMs: number = 500) {
    super();
    this.repoRoot = repoRoot;
    this.config = config;
    this.debounceMs = debounceMs;
  }

  start(): void {
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
      .on("add", (filePath: string) => this.handleEvent("add", filePath))
      .on("change", (filePath: string) => this.handleEvent("change", filePath))
      .on("unlink", (filePath: string) => this.handleEvent("unlink", filePath))
      .on("error", (error: unknown) => this.emit("error", error instanceof Error ? error : new Error(String(error))));

    this.isRunning = true;
  }

  stop(): void {
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

  isActive(): boolean {
    return this.isRunning && this.watcher !== null;
  }

  private handleEvent(event: "add" | "change" | "unlink", filePath: string): void {
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

  async waitForReady(): Promise<void> {
    if (!this.watcher) {
      return;
    }

    return new Promise((resolve) => {
      this.watcher!.on("ready", () => resolve());
    });
  }
}

const activeWatchers = new Map<string, FileWatcher>();

export function getOrCreateWatcher(
  repoRoot: string,
  config: BeaconConfig
): FileWatcher {
  let watcher = activeWatchers.get(repoRoot);

  if (!watcher) {
    watcher = new FileWatcher(repoRoot, config);
    activeWatchers.set(repoRoot, watcher);
  }

  return watcher;
}

export function stopWatcher(repoRoot: string): void {
  const watcher = activeWatchers.get(repoRoot);
  if (watcher) {
    watcher.stop();
    activeWatchers.delete(repoRoot);
  }
}

export function stopAllWatchers(): void {
  for (const watcher of activeWatchers.values()) {
    watcher.stop();
  }
  activeWatchers.clear();
}
