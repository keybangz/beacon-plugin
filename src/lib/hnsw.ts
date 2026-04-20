// Lazy-loaded to avoid crashing the plugin if the native binding is unavailable.
// HierarchicalNSW will be null until initialize() successfully loads it.
let HierarchicalNSW: any = null;
let _hnswLoadPromise: Promise<void> | null = null;
import { log } from "./logger.js";

async function ensureHnsw(): Promise<boolean> {
  if (HierarchicalNSW !== null) return true;
  if (_hnswLoadPromise) {
    await _hnswLoadPromise;
    return HierarchicalNSW !== null;
  }
  _hnswLoadPromise = import("hnswlib-node")
    .then((mod) => {
      HierarchicalNSW = (mod.default ?? mod).HierarchicalNSW;
    })
    .catch((e) => {
      log.warn("beacon", "hnswlib-node unavailable, HNSW disabled", { error: e instanceof Error ? e.message : String(e) });
    });
  await _hnswLoadPromise;
  return HierarchicalNSW !== null;
}
import {
  existsSync,
  mkdirSync,
  unlinkSync,
  readFileSync,
  writeFileSync,
  renameSync,
  copyFileSync,
} from "fs";
import { join, dirname } from "path";
import type { SearchResult } from "./types.js";

class AsyncMutex {
  private locked = false;
  private queue: Array<() => void> = [];

  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }

    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.locked = false;
    }
  }

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

export interface HNSWIndexConfig {
  dimensions: number;
  maxElements: number;
  efConstruction: number;
  efSearch: number;
  m: number;
}

const DEFAULT_CONFIG: Omit<HNSWIndexConfig, "dimensions"> = {
  maxElements: 50000,      // was 10000 — pre-allocate to avoid mid-index resize
  efConstruction: 100,     // was 200 — 2x faster build with minimal recall loss
  efSearch: 100,           // unchanged
  m: 16,                   // unchanged
};

interface IndexEntry {
  filePath: string;
  startLine: number;
  endLine: number;
  chunkId: string;
}

export class HNSWVectorIndex {
  private index: any | null = null;
  private entries: Map<number, IndexEntry> = new Map();
  private idToInternal: Map<string, number> = new Map();
  private internalToId: Map<number, string> = new Map();
  private fileToChunkIds: Map<string, Set<string>> = new Map();
  private nextInternalId: number = 0;
  private config: HNSWIndexConfig;
  private indexPath: string;
  private entriesPath: string;
  private isDirty: boolean = false;
  private mutex = new AsyncMutex();

  constructor(
    dimensions: number,
    storagePath: string,
    config?: Partial<HNSWIndexConfig>,
  ) {
    this.config = { ...DEFAULT_CONFIG, dimensions, ...config };
    this.indexPath = join(storagePath, "hnsw.index");
    this.entriesPath = join(storagePath, "hnsw.entries.json");
  }

  async initialize(): Promise<void> {
    if (this.index) {
      return;
    }

    const available = await ensureHnsw();
    if (!available) {
      return; // HNSW unavailable, fall back to brute-force in db.ts
    }

    this.index = new HierarchicalNSW("cosine", this.config.dimensions);

    if (existsSync(this.indexPath) && existsSync(this.entriesPath)) {
      try {
        this.loadFromDisk();
        return;
      } catch {
        this.index = new HierarchicalNSW("cosine", this.config.dimensions);
      }
    }

    this.index.initIndex(this.config.maxElements, this.config.m, this.config.efConstruction);
    this.index.setEf(this.config.efSearch);
  }

  private loadFromDisk(): void {
    if (!this.index) return;

    try {
      this.index.readIndex(this.indexPath);

      const data = JSON.parse(readFileSync(this.entriesPath, "utf-8"));
      this.entries = new Map(
        data.entries.map((e: [number, IndexEntry]) => [e[0], e[1]]),
      );
      this.idToInternal = new Map(data.idToInternal);
      this.internalToId = new Map(
        data.internalToId.map(([k, v]: [number, string]) => [k, v]),
      );
      this.nextInternalId = data.nextInternalId || 0;

      if (data.fileToChunkIds) {
        this.fileToChunkIds = new Map(
          (Object.entries(data.fileToChunkIds) as [string, string[]][]).map(
            ([k, v]) => [k, new Set(v)],
          ),
        );
      }
    } catch {
      throw new Error("Failed to load HNSW index from disk");
    }
  }

  private saveToDisk(): void {
    const dir = dirname(this.indexPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    try {
      // Write binary HNSW index directly (writeIndex handles its own atomicity)
      this.index?.writeIndex(this.indexPath);

      // Stream-write JSON entries to a temp file, then atomically rename.
      // This prevents entries corruption if the process crashes mid-write.
      const entriesTmpPath = `${this.entriesPath}.tmp`;

      const parts: string[] = [];
      parts.push('{"entries":[');
      let first = true;
      for (const [k, v] of this.entries) {
        if (!first) parts.push(',');
        parts.push(JSON.stringify([k, v]));
        first = false;
      }
      parts.push('],"idToInternal":[');
      first = true;
      for (const [k, v] of this.idToInternal) {
        if (!first) parts.push(',');
        parts.push(JSON.stringify([k, v]));
        first = false;
      }
      parts.push('],"internalToId":[');
      first = true;
      for (const [k, v] of this.internalToId) {
        if (!first) parts.push(',');
        parts.push(JSON.stringify([k, v]));
        first = false;
      }
      parts.push(`],"nextInternalId":${this.nextInternalId},"fileToChunkIds":{`);
      first = true;
      for (const [k, v] of this.fileToChunkIds) {
        if (!first) parts.push(',');
        parts.push(`${JSON.stringify(k)}:${JSON.stringify(Array.from(v))}`);
        first = false;
      }
      parts.push('}}');

      writeFileSync(entriesTmpPath, parts.join(''));
      
      // Atomic rename entries file
      try {
        renameSync(entriesTmpPath, this.entriesPath);
      } catch {
        // Fallback: copy and delete
        copyFileSync(entriesTmpPath, this.entriesPath);
        unlinkSync(entriesTmpPath);
      }
      
      this.isDirty = false;
    } catch (error) {
      log.error("beacon", "Failed to save index to disk", { error: error instanceof Error ? error.message : String(error) });
      throw new Error("Failed to save HNSW index to disk");
    }
  }

  async addVector(
    chunkId: string,
    embedding: number[],
    entry: IndexEntry,
  ): Promise<void> {
    return this.mutex.runExclusive(async () => {
      if (!this.index) {
        await this.initialize();
      }

      if (this.idToInternal.has(chunkId)) {
        await this.updateVectorInternal(chunkId, embedding, entry);
        return;
      }

      const internalId = this.nextInternalId++;
      this.idToInternal.set(chunkId, internalId);
      this.internalToId.set(internalId, chunkId);
      this.entries.set(internalId, entry);

      let chunkIds = this.fileToChunkIds.get(entry.filePath);
      if (!chunkIds) {
        chunkIds = new Set();
        this.fileToChunkIds.set(entry.filePath, chunkIds);
      }
      chunkIds.add(chunkId);

      // Auto-resize if approaching capacity
      if (this.nextInternalId >= Math.floor(this.config.maxElements * 0.95)) {
        const newMax = Math.ceil(this.config.maxElements * 1.5);
        this.index!.resizeIndex(newMax);
        this.config.maxElements = newMax;
      }

      this.index!.addPoint(embedding, internalId);
      this.isDirty = true;
    });
  }

  async addVectorBatch(
    items: Array<{ chunkId: string; embedding: number[]; entry: IndexEntry }>
  ): Promise<void> {
    if (items.length === 0) return;
    return this.mutex.runExclusive(async () => {
      if (!this.index) {
        await this.initialize();
      }

      for (let itemIdx = 0; itemIdx < items.length; itemIdx++) {
        const item = items[itemIdx];
        if (this.idToInternal.has(item.chunkId)) {
          // Update existing vector inline (without re-acquiring mutex)
          const oldInternalId = this.idToInternal.get(item.chunkId)!;
          this.index!.markDelete(oldInternalId);

          const newInternalId = this.nextInternalId++;
          this.idToInternal.set(item.chunkId, newInternalId);
          this.internalToId.delete(oldInternalId);
          this.internalToId.set(newInternalId, item.chunkId);
          this.entries.delete(oldInternalId);
          this.entries.set(newInternalId, item.entry);

          // Auto-resize if approaching capacity
          if (this.nextInternalId >= Math.floor(this.config.maxElements * 0.95)) {
            const newMax = Math.ceil(this.config.maxElements * 1.5);
            this.index!.resizeIndex(newMax);
            this.config.maxElements = newMax;
          }

          this.index!.addPoint(item.embedding, newInternalId);

          // Yield every 64 insertions to give the event loop breathing room
          // without excessive context-switch overhead (addPoint is ~0.1-0.5ms each).
          if (itemIdx > 0 && itemIdx % 64 === 0) {
            await new Promise<void>((resolve) => setImmediate(resolve));
          }
          continue;
        }

        const internalId = this.nextInternalId++;
        this.idToInternal.set(item.chunkId, internalId);
        this.internalToId.set(internalId, item.chunkId);
        this.entries.set(internalId, item.entry);

        let chunkIds = this.fileToChunkIds.get(item.entry.filePath);
        if (!chunkIds) {
          chunkIds = new Set();
          this.fileToChunkIds.set(item.entry.filePath, chunkIds);
        }
        chunkIds.add(item.chunkId);

        // Auto-resize if approaching capacity
        if (this.nextInternalId >= Math.floor(this.config.maxElements * 0.95)) {
          const newMax = Math.ceil(this.config.maxElements * 1.5);
          this.index!.resizeIndex(newMax);
          this.config.maxElements = newMax;
        }

        this.index!.addPoint(item.embedding, internalId);

        // Yield every 64 insertions to give the event loop breathing room
        // without excessive context-switch overhead (addPoint is ~0.1-0.5ms each).
        if (itemIdx > 0 && itemIdx % 64 === 0) {
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      }
      this.isDirty = true;
    });
  }

  private async updateVectorInternal(
    chunkId: string,
    embedding: number[],
    entry: IndexEntry,
  ): Promise<void> {
    if (!this.index) {
      await this.initialize();
    }

    const internalId = this.idToInternal.get(chunkId);
    if (internalId === undefined) {
      // Inline the add logic directly (no mutex re-acquire — avoids deadlock)
      const newInternalId = this.nextInternalId++;
      this.idToInternal.set(chunkId, newInternalId);
      this.internalToId.set(newInternalId, chunkId);
      this.entries.set(newInternalId, entry);

      let chunkIds = this.fileToChunkIds.get(entry.filePath);
      if (!chunkIds) {
        chunkIds = new Set();
        this.fileToChunkIds.set(entry.filePath, chunkIds);
      }
      chunkIds.add(chunkId);

      // Auto-resize if approaching capacity
      if (this.nextInternalId >= Math.floor(this.config.maxElements * 0.95)) {
        const newMax = Math.ceil(this.config.maxElements * 1.5);
        this.index!.resizeIndex(newMax);
        this.config.maxElements = newMax;
      }

      this.index!.addPoint(embedding, newInternalId);
      this.isDirty = true;
      return;
    }

    this.index!.markDelete(internalId);

    const newInternalId = this.nextInternalId++;
    this.idToInternal.set(chunkId, newInternalId);
    this.internalToId.delete(internalId);
    this.internalToId.set(newInternalId, chunkId);
    this.entries.delete(internalId);
    this.entries.set(newInternalId, entry);

    // Auto-resize if approaching capacity
    if (this.nextInternalId >= Math.floor(this.config.maxElements * 0.95)) {
      const newMax = Math.ceil(this.config.maxElements * 1.5);
      this.index!.resizeIndex(newMax);
      this.config.maxElements = newMax;
    }

    this.index!.addPoint(embedding, newInternalId);
    this.isDirty = true;
  }

  async updateVector(
    chunkId: string,
    embedding: number[],
    entry: IndexEntry,
  ): Promise<void> {
    return this.mutex.runExclusive(() =>
      this.updateVectorInternal(chunkId, embedding, entry),
    );
  }

  async removeVector(chunkId: string): Promise<boolean> {
    return this.mutex.runExclusive(async () => {
      if (!this.index) return false;

      const internalId = this.idToInternal.get(chunkId);
      if (internalId === undefined) return false;

      const entry = this.entries.get(internalId);
      if (entry) {
        const chunkIds = this.fileToChunkIds.get(entry.filePath);
        if (chunkIds) {
          chunkIds.delete(chunkId);
          if (chunkIds.size === 0) {
            this.fileToChunkIds.delete(entry.filePath);
          }
        }
      }

      this.index.markDelete(internalId);
      this.idToInternal.delete(chunkId);
      this.internalToId.delete(internalId);
      this.entries.delete(internalId);
      this.isDirty = true;

      return true;
    });
  }

  async removeFile(filePath: string): Promise<number> {
    return this.mutex.runExclusive(async () => {
      return this._removeFileLocked(filePath);
    });
  }

  /**
   * Remove all chunks for multiple files in a single mutex acquisition.
   * This eliminates N mutex acquire/release cycles when batch-removing.
   */
  async removeFileBatch(filePaths: string[]): Promise<number> {
    if (filePaths.length === 0) return 0;
    return this.mutex.runExclusive(async () => {
      let total = 0;
      for (const filePath of filePaths) {
        total += this._removeFileLocked(filePath);
      }
      return total;
    });
  }

  /** Internal: remove file without acquiring mutex (caller must hold it). */
  private _removeFileLocked(filePath: string): number {
    const chunkIds = this.fileToChunkIds.get(filePath);
    if (!chunkIds) return 0;

    let removed = 0;
    for (const chunkId of chunkIds) {
      const internalId = this.idToInternal.get(chunkId);
      if (internalId !== undefined && this.index) {
        this.index.markDelete(internalId);
        this.idToInternal.delete(chunkId);
        this.internalToId.delete(internalId);
        this.entries.delete(internalId);
        removed++;
      }
    }

    this.fileToChunkIds.delete(filePath);

    if (removed > 0) {
      this.isDirty = true;
    }

    return removed;
  }

  search(queryEmbedding: number[], topK: number): SearchResult[] {
    // NOTE: search() must be kept synchronous (hnswlib-node's searchKnn is sync).
    // Capture local references to guard against concurrent mutations that may
    // reassign this.index or modify the maps between awaits. The maps are
    // structurally shared (not deep-copied) so this only protects against
    // reference swaps, not mid-iteration map mutations — which is sufficient
    // since mutations are serialized through the async mutex.
    const index = this.index;
    const entries = this.entries;

    if (!index) {
      log.warn("beacon", "HNSW search called before initialization completed; returning empty results.", undefined);
      return [];
    }

    const numElements = index.getMaxElements();
    if (numElements === 0) {
      return [];
    }

    const effectiveK = Math.min(topK, index.getCurrentCount());
    if (effectiveK === 0) {
      return [];
    }

    // Improve ANN recall at query time without impacting index build speed.
    // Higher efSearch explores a wider candidate graph during search.
    const searchEf = Math.max(effectiveK * 4, 50);
    const originalEf = this.config.efSearch;
    if (typeof index.setEf === "function") {
      index.setEf(searchEf);
    } else {
      index.efSearch = searchEf;
    }

    let results;
    try {
      results = index.searchKnn(queryEmbedding, effectiveK);
    } finally {
      if (typeof index.setEf === "function") {
        index.setEf(originalEf);
      } else {
        index.efSearch = originalEf;
      }
    }

    const searchResults: SearchResult[] = [];
    for (let i = 0; i < results.neighbors.length; i++) {
      const internalId = results.neighbors[i];
      const entry = entries.get(internalId);

      if (entry) {
        searchResults.push({
          filePath: entry.filePath,
          startLine: entry.startLine,
          endLine: entry.endLine,
          chunkText: "",  // Hydrated by db layer from SQLite to save memory
          similarity: 1 - results.distances[i],
        });
      }
    }

    return searchResults;
  }

  searchWithPathFilter(
    queryEmbedding: number[],
    topK: number,
    pathPrefix: string,
  ): SearchResult[] {
    const candidateMultiplier = 5;
    const candidates = this.search(queryEmbedding, topK * candidateMultiplier);

    return candidates
      .filter((r) => r.filePath.startsWith(pathPrefix))
      .slice(0, topK);
  }

  /**
   * Search with path prefix using fileToChunkIds index for efficient path filtering.
   * This avoids scanning all candidates when only specific path prefixes are needed.
   */
  searchWithPathFilterIndexed(
    queryEmbedding: number[],
    topK: number,
    pathPrefix: string,
  ): SearchResult[] {
    const matchingChunkIds = new Set<string>();
    for (const [filePath, chunkIds] of this.fileToChunkIds) {
      if (filePath.startsWith(pathPrefix)) {
        for (const chunkId of chunkIds) {
          matchingChunkIds.add(chunkId);
        }
      }
    }

    if (matchingChunkIds.size === 0) {
      return [];
    }

    const candidateMultiplier = 5;
    const candidates = this.search(queryEmbedding, topK * candidateMultiplier);

    return candidates
      .filter((r) => matchingChunkIds.has(`${r.filePath}:${r.startLine}`))
      .slice(0, topK);
  }

  getStats(): { totalVectors: number; dimensions: number } {
    return {
      totalVectors: this.index ? this.index.getCurrentCount() : 0,
      dimensions: this.config.dimensions,
    };
  }

  async clear(): Promise<void> {
    return this.mutex.runExclusive(async () => {
      if (this.index) {
        this.index = new HierarchicalNSW("cosine", this.config.dimensions);
        this.index.initIndex(this.config.maxElements, this.config.m, this.config.efConstruction);
        this.index.setEf(this.config.efSearch);
      }
      this.entries.clear();
      this.idToInternal.clear();
      this.internalToId.clear();
      this.nextInternalId = 0;
      this.isDirty = true;
      // Flush immediately so a crash after clear() doesn't restore a stale index.
      try {
        this.saveToDisk();
      } catch (err) {
        log.error("beacon", "Failed to flush cleared index to disk", { error: err instanceof Error ? err.message : String(err) });
      }
    });
  }

  async close(): Promise<void> {
    // Acquire the mutex to ensure any in-flight addVector/removeFile completes
    // before we flush and null the index.
    await this.mutex.runExclusive(async () => {
      if (this.isDirty) {
        try {
          this.saveToDisk();
        } catch (err) {
          log.error("beacon", "Failed to save index on close", { error: err instanceof Error ? err.message : String(err) });
        }
      }
      this.index = null;
    });
  }

  setEfSearch(ef: number): void {
    this.config.efSearch = ef;
    if (this.index) {
      this.index.setEf(ef);
    }
  }
}

const activeIndexes = new Map<
  string,
  { index: HNSWVectorIndex; refCount: number }
>();

// Tracks in-flight initialization promises to prevent duplicate index creation
// when two callers race on the same storagePath.
const indexInitPromises = new Map<string, Promise<HNSWVectorIndex>>();

export async function getOrCreateIndex(
  storagePath: string,
  dimensions: number,
  config?: Partial<HNSWIndexConfig>,
): Promise<HNSWVectorIndex> {
  const existing = activeIndexes.get(storagePath);
  if (existing) {
    existing.refCount++;
    return existing.index;
  }

  // If another caller is already initializing this same index, wait for it.
  const inflight = indexInitPromises.get(storagePath);
  if (inflight) {
    const index = await inflight;
    const entry = activeIndexes.get(storagePath)!;
    entry.refCount++;
    return index;
  }

  // We are the first — create and register the init promise immediately so
  // any concurrent callers will wait on it rather than creating a second index.
  const initPromise = (async () => {
    const index = new HNSWVectorIndex(dimensions, storagePath, config);
    await index.initialize();
    activeIndexes.set(storagePath, { index, refCount: 0 });
    indexInitPromises.delete(storagePath);
    return index;
  })();

  indexInitPromises.set(storagePath, initPromise);

  const index = await initPromise;
  const entry = activeIndexes.get(storagePath)!;
  entry.refCount++;
  return index;
}

export function releaseIndex(storagePath: string): void {
  const entry = activeIndexes.get(storagePath);
  if (entry) {
    entry.refCount--;
    if (entry.refCount <= 0) {
      // Await any in-flight initialization before closing, to prevent the init
      // coroutine from re-assigning this.index after close() has nulled it out.
      const initPromise = indexInitPromises.get(storagePath);
      const doClose = async () => {
        await entry.index.close();
        activeIndexes.delete(storagePath);
      };
      if (initPromise) {
        initPromise.then(doClose).catch(doClose);
      } else {
        doClose();
      }
    }
  }
}

export function closeIndex(storagePath: string): void {
  const entry = activeIndexes.get(storagePath);
  if (entry) {
    activeIndexes.delete(storagePath);
    const initPromise = indexInitPromises.get(storagePath);
    const doClose = async () => { await entry.index.close(); };
    if (initPromise) {
      initPromise.then(doClose).catch(doClose);
    } else {
      doClose();
    }
  }
}

export function closeAllIndexes(): void {
  const entries = Array.from(activeIndexes.entries());
  activeIndexes.clear();
  for (const [storagePath, entry] of entries) {
    const initPromise = indexInitPromises.get(storagePath);
    const doClose = async () => { await entry.index.close(); };
    if (initPromise) {
      initPromise.then(doClose).catch(doClose);
    } else {
      doClose();
    }
  }
}

export function getIndexStats(): { count: number; paths: string[] } {
  return {
    count: activeIndexes.size,
    paths: Array.from(activeIndexes.keys()),
  };
}
