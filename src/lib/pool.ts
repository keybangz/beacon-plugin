import { join } from "path";
import type { BeaconConfig } from "./types.js";
import { BeaconDatabase, openDatabase } from "./db.js";
import { Embedder } from "./embedder.js";
import { IndexCoordinator } from "./sync.js";
import { loadConfig } from "./config.js";
import { findRepoRoot } from "./repo-root.js";

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
  mutex: Promise<void>;
  resolve: (() => void) | null;
}

class SimpleMutex {
  private queue: (() => void)[] = [];
  private locked = false;

  async acquire(): Promise<() => void> {
    if (!this.locked) {
      this.locked = true;
      return () => this.release();
    }

    return new Promise<() => void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  private release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
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
  private globalMutex = new SimpleMutex();

  constructor() {
    this.startCleanupTimer();
  }

  private startCleanupTimer(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    this.cleanupInterval = setInterval(() => {
      this.cleanupIdle();
    }, 30000);
  }

  private async cleanupIdle(): Promise<void> {
    const now = Date.now();
    const release = await this.globalMutex.acquire();
    
    const entries = Array.from(this.pools.entries());
    const cleanupPromises: Promise<void>[] = [];

    for (const [repoRoot, entry] of entries) {
      cleanupPromises.push((async () => {
        // Wait for entry mutex
        const entryRelease = entry.mutex;
        try {
          await entryRelease;
        } catch {}

        const resources = entry.resources;
        if (
          resources.refCount === 0 &&
          now - resources.lastAccessed > this.IDLE_TIMEOUT_MS
        ) {
          try {
            resources.db.close();
            this.pools.delete(repoRoot);
          } catch (error) {
            // Silently handle cleanup errors
          }
        }
      })());
    }

    await Promise.allSettled(cleanupPromises);
    release();
  }

  async acquire(worktree: string): Promise<PooledResources> {
    const repoRoot = findRepoRoot(worktree);
    if (!repoRoot) {
      throw new Error("No git repository found");
    }

    // Global lock to prevent race conditions
    const globalRelease = await this.globalMutex.acquire();
    
    try {
      let entry = this.pools.get(repoRoot);
      
      if (!entry) {
        // Create new resources
        const config = loadConfig(repoRoot);
        const storagePath = join(repoRoot, config.storage.path);
        const dbPath = join(storagePath, "embeddings.db");

        const db = openDatabase(dbPath, config.embedding.dimensions);
        const effectiveContextLimit =
          config.embedding.context_limit ?? config.chunking.max_tokens;
        const embedder = new Embedder(config.embedding, effectiveContextLimit, storagePath);
        const coordinator = new IndexCoordinator(config, db, embedder, repoRoot);

        const resources: PooledResources = {
          db,
          embedder,
          coordinator,
          config,
          refCount: 1,
          lastAccessed: Date.now(),
        };

        // Create immediate resolved promise for the mutex
        let mutexResolve: () => void;
        const mutexPromise = new Promise<void>((resolve) => {
          mutexResolve = resolve;
        });
        mutexResolve!();

        entry = {
          resources,
          mutex: mutexPromise,
          resolve: mutexResolve,
        };

        this.pools.set(repoRoot, entry);
      } else {
        // Wait for entry lock then update
        await entry.mutex;
        
        // Create new mutex for this update
        let mutexResolve: () => void;
        const mutexPromise = new Promise<void>((resolve) => {
          mutexResolve = resolve;
        });
        entry.mutex = mutexPromise;
        entry.resolve = mutexResolve;

        // Update
        entry.resources.refCount++;
        entry.resources.lastAccessed = Date.now();

        // Release immediately
        if (entry.resolve) {
          entry.resolve();
        }
      }

      globalRelease();
      return entry.resources;
    } catch (error) {
      globalRelease();
      throw error;
    }
  }

  async release(worktree: string): Promise<void> {
    const repoRoot = findRepoRoot(worktree);
    if (!repoRoot) return;

    const globalRelease = await this.globalMutex.acquire();
    
    try {
      const entry = this.pools.get(repoRoot);
      if (!entry) {
        globalRelease();
        return;
      }

      // Wait for entry lock
      await entry.mutex;
      
      // Create new mutex for update
      let mutexResolve: () => void;
      const mutexPromise = new Promise<void>((resolve) => {
        mutexResolve = resolve;
      });
      entry.mutex = mutexPromise;
      entry.resolve = mutexResolve;

      // Update
      entry.resources.refCount = Math.max(0, entry.resources.refCount - 1);
      entry.resources.lastAccessed = Date.now();

      // Release
      if (entry.resolve) {
        entry.resolve();
      }

      globalRelease();
    } catch (error) {
      globalRelease();
      throw error;
    }
  }

  get(worktree: string): PooledResources | undefined {
    const repoRoot = findRepoRoot(worktree);
    if (!repoRoot) return undefined;
    
    const entry = this.pools.get(repoRoot);
    return entry?.resources;
  }

  async close(worktree: string): Promise<void> {
    const repoRoot = findRepoRoot(worktree);
    if (!repoRoot) return;

    const globalRelease = await this.globalMutex.acquire();
    
    try {
      const entry = this.pools.get(repoRoot);
      if (!entry) {
        globalRelease();
        return;
      }

      await entry.mutex;
      
      entry.resources.db.close();
      this.pools.delete(repoRoot);
      
      globalRelease();
    } catch (error) {
      globalRelease();
      // Ignore errors in close
    }
  }

  async closeAll(): Promise<void> {
    const globalRelease = await this.globalMutex.acquire();
    
    try {
      const entries = Array.from(this.pools.entries());
      
      for (const [repoRoot, entry] of entries) {
        await entry.mutex;
        try {
          entry.resources.db.close();
        } catch {}
      }
      
      this.pools.clear();

      if (this.cleanupInterval) {
        clearInterval(this.cleanupInterval);
        this.cleanupInterval = null;
      }
      
      globalRelease();
    } catch (error) {
      globalRelease();
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
