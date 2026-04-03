import type { BeaconConfig } from "./types.js";
import { log } from "./logger.js";
import { BeaconDatabase, openDatabase } from "./db.js";
import { Embedder } from "./embedder.js";
import { IndexCoordinator } from "./sync.js";
import { loadConfig } from "./config.js";
import { getBeaconRoot } from "./repo-root.js";
import { clearRepoFilesCache } from "./git.js";

export interface PooledResources {
  db: BeaconDatabase;
  embedder: Embedder;
  coordinator: IndexCoordinator;
  config: BeaconConfig;
  refCount: number;
  lastAccessed: number;
}

interface PoolEntry {
  resources: PooledResources;
  acquiring: Promise<void>;
}

class AsyncMutex {
  private queue: Array<() => void> = [];
  private locked = false;

  async acquire(): Promise<() => void> {
    if (!this.locked) {
      this.locked = true;
      return () => this.release();
    }
    return new Promise<() => void>((resolve) => {
      this.queue.push(() => {
        this.locked = true;  // SET BEFORE resolving
        resolve(() => this.release());
      });
    });
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.locked = false;
    }
  }
}

class ConnectionPool {
  private pools: Map<string, PoolEntry> = new Map();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private readonly IDLE_TIMEOUT_MS = 60000;
  private globalLock = new AsyncMutex();

  // In-memory set of repoRoots whose indexer is currently running.
  // This is the authoritative cross-instance signal — the DB sync_status
  // can be stale (e.g. after a crash) but this flag is only set while
  // performFullIndex is actually executing in this process.
  private runningIndexes: Set<string> = new Set();

  /** Mark that an indexing operation has started for this repoRoot. */
  markIndexerRunning(repoRoot: string): void {
    this.runningIndexes.add(repoRoot);
  }

  /** Mark that the indexing operation has finished (success or error). */
  markIndexerDone(repoRoot: string): void {
    this.runningIndexes.delete(repoRoot);
  }

  /**
   * Returns true if an indexer is currently running for this worktree path.
   * Uses the in-memory flag (authoritative for the current process) OR the
   * DB sync_status as a fallback for external/crash detection.
   */
  isIndexerRunning(worktree: string): boolean {
    const repoRoot = getBeaconRoot(worktree);
    if (this.runningIndexes.has(repoRoot)) return true;
    // Secondary: peek at the DB sync_status if a pool entry exists.
    const entry = this.pools.get(repoRoot);
    if (entry) {
      try {
        const status = entry.resources.db.getSyncState("sync_status");
        if (status === "in_progress" || status === "terminating") return true;
      } catch {
        // DB read failed — treat as not running
      }
    }
    return false;
  }

  constructor() {
    this.startCleanupTimer();
  }

  private startCleanupTimer(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    this.cleanupInterval = setInterval(() => {
      this.cleanupIdle().catch((err) => {
        log.error("beacon", "Pool cleanup error", { error: err instanceof Error ? err.message : String(err) });
      });
    }, 30000);
    // Unref so the timer does not prevent the process from exiting when idle.
    if (typeof this.cleanupInterval === "object" && (this.cleanupInterval as any).unref) {
      (this.cleanupInterval as any).unref();
    }
  }

  private async getGlobalLock(): Promise<() => void> {
    return this.globalLock.acquire();
  }

  private async cleanupIdle(): Promise<void> {
    const now = Date.now();
    
    // Get snapshot of pool keys while holding lock
    const release = await this.getGlobalLock();
    const repoRoots = Array.from(this.pools.keys());
    release();
    
    // Check each entry without holding global lock
    for (const repoRoot of repoRoots) {
      // Re-acquire the lock to get the current (not stale) entry before waiting on its promise.
      const relCheck = await this.getGlobalLock();
      const currentEntry = this.pools.get(repoRoot);
      relCheck();

      if (!currentEntry) continue;

      // Wait for the *current* entry's acquiring promise (not a potentially stale snapshot).
      await currentEntry.acquiring;
      
      // Re-acquire lock to check and potentially cleanup
      const release2 = await this.getGlobalLock();
      let resourcesToClose: PooledResources | null = null;
      try {
        // Re-check entry still exists and hasn't been replaced
        const freshEntry = this.pools.get(repoRoot);
        if (!freshEntry || freshEntry !== currentEntry) continue;
        
        const resources = freshEntry.resources;
        if (
          resources.refCount === 0 &&
          now - resources.lastAccessed > this.IDLE_TIMEOUT_MS
        ) {
          // Remove from pool and close the DB synchronously while holding the
          // lock, but defer the async embedder.close() until after releasing —
          // this prevents the global mutex from blocking all pool operations
          // for the duration of ONNX teardown (which can be hundreds of ms).
          this.pools.delete(repoRoot);
          clearRepoFilesCache(repoRoot);
          resources.db.close();
          resourcesToClose = resources;
        }
      } finally {
        release2();
      }

      // Close the ONNX embedder outside the lock to avoid head-of-line blocking.
      if (resourcesToClose !== null) {
        await resourcesToClose.embedder.close().catch((e: unknown) => {
          log.error("beacon", `Failed to close embedder during idle cleanup for ${repoRoot}`, { error: e instanceof Error ? e.message : String(e) });
        });
      }
    }
  }

  async acquire(worktree: string): Promise<PooledResources> {
    // getBeaconRoot falls back to worktree/cwd if no .git found — supports non-git projects
    const repoRoot = getBeaconRoot(worktree);

    // ---- Phase 1: check if pool entry already exists (fast path, minimal lock time) ----
    const releaseCheck = await this.getGlobalLock();
    try {
      const existing = this.pools.get(repoRoot);
      if (existing) {
        await existing.acquiring;
        existing.resources.refCount++;
        existing.resources.lastAccessed = Date.now();
        existing.acquiring = Promise.resolve();
        return existing.resources;
      }
    } finally {
      releaseCheck();
    }

    // ---- Phase 2: perform file I/O (loadConfig) OUTSIDE the lock ----
    // If two callers race here for the same repoRoot, the second one will
    // find the entry already present in Phase 3 and discard the extra resources.
    const config = loadConfig(repoRoot);
    const storagePath = config.storage.path;
    const dbPath = `${storagePath}/embeddings.db`;

    const db = openDatabase(dbPath, config.embedding.dimensions, true, config.storage.hnsw_max_elements);
    const effectiveContextLimit =
      config.embedding.context_limit ?? config.chunking.max_tokens;
    const embedder = new Embedder(config.embedding, effectiveContextLimit, storagePath);

    // ---- Phase 3: re-acquire lock and insert (or discard if a peer already did it) ----
    const release = await this.getGlobalLock();
    try {
      // Check again under the lock — another caller may have created the entry
      // while we were doing I/O in Phase 2.
      const raceEntry = this.pools.get(repoRoot);
      if (raceEntry) {
        // Discard our newly-created resources; use the pooled ones instead.
        // Close the extra DB and embedder outside the lock to avoid blocking.
        const extraDb = db;
        const extraEmbedder = embedder;
        setImmediate(() => {
          extraDb.close();
          extraEmbedder.close().catch(() => {});
        });

        await raceEntry.acquiring;
        raceEntry.resources.refCount++;
        raceEntry.resources.lastAccessed = Date.now();
        raceEntry.acquiring = Promise.resolve();
        return raceEntry.resources;
      }

      const coordinator = new IndexCoordinator(config, db, embedder, repoRoot, (running) => {
        if (running) {
          this.runningIndexes.add(repoRoot);
        } else {
          this.runningIndexes.delete(repoRoot);
        }
      });
      const resources: PooledResources = {
        db,
        embedder,
        coordinator,
        config,
        refCount: 1,
        lastAccessed: Date.now(),
      };

      const entry = {
        resources,
        acquiring: Promise.resolve(),
      };

      this.pools.set(repoRoot, entry);
      return resources;
    } finally {
      release();
    }
  }

  async release(worktree: string): Promise<void> {
    // getBeaconRoot falls back to worktree/cwd if no .git found
    const repoRoot = getBeaconRoot(worktree);

    const release = await this.getGlobalLock();
    
    try {
      const entry = this.pools.get(repoRoot);
      if (!entry) return;

      // Wait for entry to be available
      await entry.acquiring;
      
      // Update
      entry.resources.refCount = Math.max(0, entry.resources.refCount - 1);
      entry.resources.lastAccessed = Date.now();
      
      // Set promise for next operation
      entry.acquiring = Promise.resolve();
    } finally {
      release();
    }
  }

  async close(worktree: string): Promise<void> {
    const repoRoot = getBeaconRoot(worktree);

    // Snapshot and remove the entry under the lock, close resources outside.
    const release = await this.getGlobalLock();
    let entryToClose: PoolEntry | null = null;

    try {
      const entry = this.pools.get(repoRoot);
      if (!entry) return;

      await entry.acquiring;
      this.pools.delete(repoRoot);
      entryToClose = entry;
    } finally {
      release();
    }

    if (entryToClose) {
      entryToClose.resources.db.close();
      await entryToClose.resources.embedder.close().catch((err: unknown) => {
        log.error("beacon", `Failed to close embedder for ${repoRoot}`, { error: err instanceof Error ? err.message : String(err) });
      });
    }
  }

  async closeAll(): Promise<void> {
    // Snapshot and clear the pool under the lock, then close resources outside.
    const release = await this.getGlobalLock();
    let entriesToClose: Array<{ repoRoot: string; entry: PoolEntry }> = [];

    try {
      entriesToClose = Array.from(this.pools.entries()).map(([repoRoot, entry]) => ({ repoRoot, entry }));
      this.pools.clear();

      if (this.cleanupInterval) {
        clearInterval(this.cleanupInterval);
        this.cleanupInterval = null;
      }
    } finally {
      release();
    }

    // Close all resources outside the lock (embedder.close() can be hundreds of ms)
    for (const { entry } of entriesToClose) {
      await entry.acquiring;
      try {
        entry.resources.db.close();
      } catch (error) {
        log.error("beacon", "Failed to close database in closeAll", { error: error instanceof Error ? error.message : String(error) });
      }
      try {
        await entry.resources.embedder.close();
      } catch (error) {
        log.error("beacon", "Failed to close embedder in closeAll", { error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  stats(): { pools: number; totalRefs: number } {
    let totalRefs = 0;
    for (const entry of this.pools.values()) {
      totalRefs += entry.resources.refCount;
    }
    return { pools: this.pools.size, totalRefs };
  }
}

export const connectionPool = new ConnectionPool();

export async function getCoordinator(worktree: string): Promise<PooledResources> {
  return await connectionPool.acquire(worktree);
}

export async function releaseCoordinator(worktree: string): Promise<void> {
  await connectionPool.release(worktree);
}
