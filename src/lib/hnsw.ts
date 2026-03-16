import pkg from "hnswlib-node";
const { HierarchicalNSW } = pkg;
import { existsSync, mkdirSync, unlinkSync, readFileSync, writeFileSync } from "fs";
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
  maxElements: 100000,
  efConstruction: 200,
  efSearch: 100,
  m: 16,
};

interface IndexEntry {
  filePath: string;
  startLine: number;
  endLine: number;
  chunkText: string;
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

  constructor(dimensions: number, storagePath: string, config?: Partial<HNSWIndexConfig>) {
    this.config = { ...DEFAULT_CONFIG, dimensions, ...config };
    this.indexPath = join(storagePath, "hnsw.index");
    this.entriesPath = join(storagePath, "hnsw.entries.json");
  }

  initialize(): void {
    if (this.index) {
      return;
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

    this.index.initIndex(this.config.maxElements);
    this.index.setEf(this.config.efSearch);
  }

  private loadFromDisk(): void {
    if (!this.index) return;

    try {
      this.index.readIndex(this.indexPath);
      
      const data = JSON.parse(readFileSync(this.entriesPath, "utf-8"));
      this.entries = new Map(data.entries.map((e: [number, IndexEntry]) => [e[0], e[1]]));
      this.idToInternal = new Map(data.idToInternal);
      this.internalToId = new Map(data.internalToId.map(([k, v]: [number, string]) => [k, v]));
      this.nextInternalId = data.nextInternalId || 0;

      if (data.fileToChunkIds) {
        this.fileToChunkIds = new Map(
          Object.entries(data.fileToChunkIds).map(([k, v]: [string, string[]]) => [k, new Set(v)])
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
      this.index?.writeIndex(this.indexPath);
      
      const data = {
        entries: Array.from(this.entries.entries()),
        idToInternal: Array.from(this.idToInternal.entries()),
        internalToId: Array.from(this.internalToId.entries()),
        nextInternalId: this.nextInternalId,
        fileToChunkIds: Object.fromEntries(
          Array.from(this.fileToChunkIds.entries()).map(([k, v]) => [k, Array.from(v)])
        ),
      };
      
      writeFileSync(this.entriesPath, JSON.stringify(data));
      this.isDirty = false;
    } catch (error) {
      console.error(`[HNSW] Failed to save index to disk:`, error);
      throw new Error("Failed to save HNSW index to disk");
    }
  }

  async addVector(chunkId: string, embedding: number[], entry: IndexEntry): Promise<void> {
    return this.mutex.runExclusive(async () => {
      if (!this.index) {
        this.initialize();
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

      this.index!.addPoint(embedding, internalId);
      this.isDirty = true;
    });
  }

  private async updateVectorInternal(chunkId: string, embedding: number[], entry: IndexEntry): Promise<void> {
    if (!this.index) {
      this.initialize();
    }

    const internalId = this.idToInternal.get(chunkId);
    if (internalId === undefined) {
      await this.addVector(chunkId, embedding, entry);
      return;
    }

    this.index!.markDelete(internalId);
    
    const newInternalId = this.nextInternalId++;
    this.idToInternal.set(chunkId, newInternalId);
    this.internalToId.delete(internalId);
    this.internalToId.set(newInternalId, chunkId);
    this.entries.delete(internalId);
    this.entries.set(newInternalId, entry);

    this.index!.addPoint(embedding, newInternalId);
    this.isDirty = true;
  }

  async updateVector(chunkId: string, embedding: number[], entry: IndexEntry): Promise<void> {
    return this.mutex.runExclusive(() => this.updateVectorInternal(chunkId, embedding, entry));
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
    });
  }

  search(queryEmbedding: number[], topK: number): SearchResult[] {
    if (!this.index) {
      try {
        this.initialize();
      } catch (error) {
        console.error(`[Beacon] HNSW initialization failed during search:`, error);
        return [];
      }
    }

    if (!this.index) {
      return [];
    }

    const numElements = this.index.getMaxElements();
    if (numElements === 0) {
      return [];
    }

    const effectiveK = Math.min(topK, this.index.getCurrentCount());
    if (effectiveK === 0) {
      return [];
    }

    const results = this.index.searchKnn(queryEmbedding, effectiveK);

    const searchResults: SearchResult[] = [];
    for (let i = 0; i < results.neighbors.length; i++) {
      const internalId = results.neighbors[i];
      const entry = this.entries.get(internalId);

      if (entry) {
        searchResults.push({
          filePath: entry.filePath,
          startLine: entry.startLine,
          endLine: entry.endLine,
          chunkText: entry.chunkText,
          similarity: 1 - results.distances[i],
        });
      }
    }

    return searchResults;
  }

  searchWithPathFilter(
    queryEmbedding: number[],
    topK: number,
    pathPrefix: string
  ): SearchResult[] {
    const candidateMultiplier = 5;
    const candidates = this.search(queryEmbedding, topK * candidateMultiplier);

    return candidates
      .filter((r) => r.filePath.startsWith(pathPrefix))
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
        this.index.initIndex(this.config.maxElements);
        this.index.setEf(this.config.efSearch);
      }
      this.entries.clear();
      this.idToInternal.clear();
      this.internalToId.clear();
      this.nextInternalId = 0;
      this.isDirty = true;
    });
  }

  close(): void {
    if (this.isDirty) {
      this.saveToDisk();
    }
    this.index = null;
  }

  setEfSearch(ef: number): void {
    this.config.efSearch = ef;
    if (this.index) {
      this.index.setEf(ef);
    }
  }
}

const activeIndexes = new Map<string, { index: HNSWVectorIndex; refCount: number }>();

export function getOrCreateIndex(
  storagePath: string,
  dimensions: number,
  config?: Partial<HNSWIndexConfig>
): HNSWVectorIndex {
  let entry = activeIndexes.get(storagePath);

  if (!entry) {
    const index = new HNSWVectorIndex(dimensions, storagePath, config);
    index.initialize();
    entry = { index, refCount: 0 };
    activeIndexes.set(storagePath, entry);
  }

  entry.refCount++;
  return entry.index;
}

export function releaseIndex(storagePath: string): void {
  const entry = activeIndexes.get(storagePath);
  if (entry) {
    entry.refCount--;
    if (entry.refCount <= 0) {
      entry.index.close();
      activeIndexes.delete(storagePath);
    }
  }
}

export function closeIndex(storagePath: string): void {
  const entry = activeIndexes.get(storagePath);
  if (entry) {
    entry.index.close();
    activeIndexes.delete(storagePath);
  }
}

export function closeAllIndexes(): void {
  for (const entry of activeIndexes.values()) {
    entry.index.close();
  }
  activeIndexes.clear();
}

export function getIndexStats(): { count: number; paths: string[] } {
  return {
    count: activeIndexes.size,
    paths: Array.from(activeIndexes.keys()),
  };
}
