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
  acquiring: Promise<void>;
}

class ConnectionPool {
  private pools: Map<string, PoolEntry> = new Map();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private readonly IDLE_TIMEOUT_MS = 60000;
  private globalLock: Promise<void> = Promise.resolve();
  private resolveGlobalLock: (() => void) | null = null;

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

  private async getGlobalLock(): Promise<() => void> {
    let myResolve: (() => void) | null = null;
    
    while (true) {
      if (this.resolveGlobalLock === null) {
        const currentLock = this.globalLock;
        let nextPromiseResolve: (() => void) | null = null;
        
        myResolve = () => {
          this.resolveGlobalLock = null;
          this.globalLock = Promise.resolve();
          if (nextPromiseResolve) {
            nextPromiseResolve();
          }
        };
        
        this.resolveGlobalLock = myResolve;
        this.globalLock = new Promise((resolve) => {
          nextPromiseResolve = resolve;
        });
        
        await currentLock;
        return myResolve;
      }
      
      await this.globalLock;
    }
  }

  private async cleanupIdle(): Promise<void> {
    const now = Date.now();
    
    // Get snapshot of pool keys while holding lock
    const release = await this.getGlobalLock();
    const repoRoots = Array.from(this.pools.keys());
    release();
    
    // Check each entry without holding global lock
    for (const repoRoot of repoRoots) {
      const entry = this.pools.get(repoRoot);
      if (!entry) continue;
      
      // Wait for entry to be available (without global lock to prevent deadlock)
      await entry.acquiring;
      
      // Re-acquire lock to check and potentially cleanup
      const release2 = await this.getGlobalLock();
      try {
        // Re-check entry still exists and is idle
        const currentEntry = this.pools.get(repoRoot);
        if (!currentEntry) continue;
        
        const resources = currentEntry.resources;
        if (
          resources.refCount === 0 &&
          now - resources.lastAccessed > this.IDLE_TIMEOUT_MS
        ) {
          try {
            resources.db.close();
            this.pools.delete(repoRoot);
          } catch (error) {
            console.error(`[Beacon] Failed to cleanup pool entry for ${repoRoot}:`, error);
          }
        }
      } finally {
        release2();
      }
    }
  }

  async acquire(worktree: string): Promise<PooledResources> {
    const repoRoot = findRepoRoot(worktree);
    if (!repoRoot) {
      throw new Error("No git repository found");
    }

    // Global lock to prevent race conditions
    const release = await this.getGlobalLock();
    
    try {
      let entry = this.pools.get(repoRoot);
      
      if (!entry) {
        // Create new resources immediately
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

        // Entry with immediate resolved promise
        entry = {
          resources,
          acquiring: Promise.resolve(),
        };

        this.pools.set(repoRoot, entry);
      } else {
        // Wait for any pending operations on this entry
        await entry.acquiring;
        
        // Update with new completed promise
        entry.resources.refCount++;
        entry.resources.lastAccessed = Date.now();
        entry.acquiring = Promise.resolve();
      }

      return entry.resources;
    } finally {
      release();
    }
  }

  async release(worktree: string): Promise<void> {
    const repoRoot = findRepoRoot(worktree);
    if (!repoRoot) return;

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

  get(worktree: string): PooledResources | undefined {
    const repoRoot = findRepoRoot(worktree);
    if (!repoRoot) return undefined;
    
    return this.pools.get(repoRoot)?.resources;
  }

  async close(worktree: string): Promise<void> {
    const repoRoot = findRepoRoot(worktree);
    if (!repoRoot) return;

    const release = await this.getGlobalLock();
    
    try {
      const entry = this.pools.get(repoRoot);
      if (!entry) return;

      await entry.acquiring;
      
      entry.resources.db.close();
      this.pools.delete(repoRoot);
    } finally {
      release();
    }
  }

  async closeAll(): Promise<void> {
    const release = await this.getGlobalLock();
    
    try {
      const entries = Array.from(this.pools.entries());
      
      for (const [repoRoot, entry] of entries) {
        await entry.acquiring;
        try {
          entry.resources.db.close();
        } catch {}
      }
      
      this.pools.clear();

      if (this.cleanupInterval) {
        clearInterval(this.cleanupInterval);
        this.cleanupInterval = null;
      }
    } finally {
      release();
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
