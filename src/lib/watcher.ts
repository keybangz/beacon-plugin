import chokidar, { FSWatcher } from "chokidar";
import { EventEmitter } from "events";
import { relative, isAbsolute } from "path";
import type { BeaconConfig } from "./types.js";
import { shouldIndex } from "./ignore.js";

export interface WatcherBatchEvents {
  batch: (eventType: "add" | "change" | "unlink", filePaths: string[]) => void;
  error: (error: Error) => void;
}

export class FileWatcher extends EventEmitter {
  private watcher: FSWatcher | null = null;
  private repoRoot: string;
  private config: BeaconConfig;
  private debounceMs: number;
  private isRunning: boolean = false;

  // Track batched file events
  private batchEvents: Record<"add" | "change" | "unlink", Set<string>> = {
    add: new Set(),
    change: new Set(),
    unlink: new Set(),
  };

  private batchTimer: ReturnType<typeof setTimeout> | null = null;
  // Profiling metrics
  private metrics = {
    eventCounts: { add: 0, change: 0, unlink: 0 } as Record<string, number>,
    batchCounts: { add: 0, change: 0, unlink: 0 } as Record<string, number>,
    batchSizes: { add: 0, change: 0, unlink: 0 } as Record<string, number>,
    batchLatencyMs: 0,
    errorCount: 0,
  };


  constructor(repoRoot: string, config: BeaconConfig, debounceMs: number = 500) {
    super();
    this.repoRoot = repoRoot;
    this.config = config;
    this.debounceMs = debounceMs;
  }

  // New batching handler for file events
  private handleBatchEvent(event: "add" | "change" | "unlink", filePath: string): void {
    // Normalize: strip leading './' or absolute prefix so the path is always
    // relative to repoRoot without any leading separator.
    if (filePath.startsWith("./")) {
      filePath = filePath.slice(2);
    } else if (isAbsolute(filePath)) {
      // Convert absolute path back to relative (chokidar should not emit these with cwd set,
      // but guard defensively)
      const rel = relative(this.repoRoot, filePath);
      if (!rel.startsWith("..")) {
        filePath = rel;
      }
    }

    if (!shouldIndex(filePath, this.config.indexing.include, this.config.indexing.exclude)) {
      return;
    }

    this.metrics.eventCounts[event]++;
    this.batchEvents[event].add(filePath);

    // Reset the debounce timer on every new event so the batch fires only
    // after the debounce window has passed with no further activity.
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    const start = Date.now();
    this.batchTimer = setTimeout(() => {
      // Compute latency once for the whole batch flush, not per event type.
      const latencyMs = Date.now() - start;
      this.metrics.batchLatencyMs = latencyMs;
      (["add", "change", "unlink"] as const).forEach((etype) => {
        const paths = Array.from(this.batchEvents[etype]);
        if (paths.length > 0) {
          this.metrics.batchCounts[etype]++;
          this.metrics.batchSizes[etype] += paths.length;
          this.emit("batch", etype, paths);
          this.batchEvents[etype].clear();
        }
      });
      this.batchTimer = null;
    }, this.debounceMs);
  }


  start(): void {
    if (this.isRunning) return;
    const includePatterns = this.config.indexing.include;
    const excludePatterns = this.config.indexing.exclude;

    this.watcher = chokidar.watch(includePatterns, {
      cwd: this.repoRoot,
      ignored: excludePatterns.length > 0 ? excludePatterns : undefined,
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: {
        stabilityThreshold: this.config.indexing.watcher_stability_ms ?? 200,
        pollInterval: this.config.indexing.watcher_poll_interval ?? 50,
      },
      usePolling: false,
      alwaysStat: false,
      depth: this.config.indexing.watcher_depth ?? 50,
      ignorePermissionErrors: true,
    });

    this.watcher
      .on("add", (filePath: string) => this.handleBatchEvent("add", filePath))
      .on("change", (filePath: string) => this.handleBatchEvent("change", filePath))
      .on("unlink", (filePath: string) => this.handleBatchEvent("unlink", filePath))
      .on("error", (error: unknown) => {
        this.metrics.errorCount++;
        this.emit("error", error instanceof Error ? error : new Error(String(error)));
      });

    this.isRunning = true;
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    // Clear batch timer
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    // Clear all event sets
    (["add", "change", "unlink"] as const).forEach((etype) => {
      this.batchEvents[etype].clear();
    });
    this.isRunning = false;
  }

  isActive(): boolean {
    return this.isRunning && this.watcher !== null;
  }

  // Legacy handler removed: now replaced by batching logic


  async waitForReady(timeoutMs: number = 10000): Promise<void> {
    if (!this.watcher) {
      return;
    }

    // Fallback for chokidar "ready" bug with empty folders
    return new Promise((resolve) => {
      let resolved = false;
      const readyHandler = () => {
        if (!resolved) {
          this.watcher?.off("ready", readyHandler);
          resolved = true;
          resolve();
        }
      };
      this.watcher!.on("ready", readyHandler);
      // Fallback: resolve after timeout if "ready" never fires
      setTimeout(() => {
        if (!resolved) {
          this.watcher?.off("ready", readyHandler);
          resolved = true;
          resolve();
        }
      }, timeoutMs);
    });
  }
}

const activeWatchers = new Map<string, { watcher: FileWatcher; refCount: number }>();
const watcherMutexLock = { locked: false, queue: [] as (() => void)[] };

async function acquireWatcherLock(): Promise<() => void> {
  if (!watcherMutexLock.locked) {
    watcherMutexLock.locked = true;
    return () => {
      watcherMutexLock.locked = false;
      if (watcherMutexLock.queue.length > 0) {
        const next = watcherMutexLock.queue.shift()!;
        next();
      }
    };
  }

  return new Promise<() => void>((resolve) => {
    watcherMutexLock.queue.push(() => {
      watcherMutexLock.locked = true;
      resolve(() => {
        watcherMutexLock.locked = false;
        if (watcherMutexLock.queue.length > 0) {
          const next = watcherMutexLock.queue.shift()!;
          next();
        }
      });
    });
  });
}

export async function getOrCreateWatcher(
  repoRoot: string,
  config: BeaconConfig
): Promise<FileWatcher> {
  const release = await acquireWatcherLock();
  
  try {
    let entry = activeWatchers.get(repoRoot);

    if (!entry) {
      const watcher = new FileWatcher(repoRoot, config);
      watcher.start();
      entry = { watcher, refCount: 0 };
      activeWatchers.set(repoRoot, entry);
    }

    entry.refCount++;
    return entry.watcher;
  } finally {
    release();
  }
}

export async function releaseWatcher(repoRoot: string): Promise<void> {
  const release = await acquireWatcherLock();
  
  try {
    const entry = activeWatchers.get(repoRoot);
    if (entry) {
      entry.refCount--;
      if (entry.refCount <= 0) {
        entry.watcher.stop();
        activeWatchers.delete(repoRoot);
      }
    }
  } finally {
    release();
  }
}

export async function stopWatcher(repoRoot: string): Promise<void> {
  const release = await acquireWatcherLock();
  
  try {
    const entry = activeWatchers.get(repoRoot);
    if (entry) {
      entry.watcher.stop();
      activeWatchers.delete(repoRoot);
    }
  } finally {
    release();
  }
}

export async function stopAllWatchers(): Promise<void> {
  const release = await acquireWatcherLock();
  
  try {
    for (const entry of Array.from(activeWatchers.values())) {
      entry.watcher.stop();
    }
    activeWatchers.clear();
  } finally {
    release();
  }
}

export function getWatcherStats(): { count: number; repos: string[] } {
  return {
    count: activeWatchers.size,
    repos: Array.from(activeWatchers.keys()),
  };
}

// For metrics reporting
export function getWatcherProfilerStats(repoRoot: string): any {
  const entry = activeWatchers.get(repoRoot);
  if (entry && entry.watcher && (entry.watcher as any).metrics) {
    return (entry.watcher as any).metrics;
  }
  return null;
}
