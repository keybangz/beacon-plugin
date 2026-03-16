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

    // Clear all debounce timers
    for (const [filePath, timer] of this.debounceTimers) {
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

    // Clear existing timer for this file
    const existingTimer = this.debounceTimers.get(filePath);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Create new debounce timer
    const timer = setTimeout(() => {
      this.debounceTimers.delete(filePath);
      // Only emit if watcher is still active
      if (this.isRunning) {
        this.emit(event, filePath);
      }
    }, this.debounceMs);

    // Prevent timer map from growing unbounded
    if (this.debounceTimers.size > 1000) {
      // Emergency cleanup: clear oldest entries
      const entries = Array.from(this.debounceTimers.entries());
      for (let i = 0; i < 100 && i < entries.length; i++) {
        const [oldFilePath, oldTimer] = entries[i];
        clearTimeout(oldTimer);
        this.debounceTimers.delete(oldFilePath);
      }
    }

    this.debounceTimers.set(filePath, timer);
  }

  async waitForReady(): Promise<void> {
    if (!this.watcher) {
      return;
    }

    return new Promise((resolve) => {
      const readyHandler = () => {
        this.watcher?.off("ready", readyHandler);
        resolve();
      };
      this.watcher!.on("ready", readyHandler);
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
    for (const entry of activeWatchers.values()) {
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
