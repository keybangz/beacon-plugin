import pkg from "hnswlib-node";
const { HierarchicalNSW } = pkg;
import { existsSync, mkdirSync, unlinkSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import type { SearchResult } from "./types.js";

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
  private nextInternalId: number = 0;
  private config: HNSWIndexConfig;
  private indexPath: string;
  private entriesPath: string;
  private isDirty: boolean = false;

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
      };
      
      writeFileSync(this.entriesPath, JSON.stringify(data));
      this.isDirty = false;
    } catch {
      throw new Error("Failed to save HNSW index to disk");
    }
  }

  addVector(chunkId: string, embedding: number[], entry: IndexEntry): void {
    if (!this.index) {
      this.initialize();
    }

    if (this.idToInternal.has(chunkId)) {
      this.updateVector(chunkId, embedding, entry);
      return;
    }

    const internalId = this.nextInternalId++;
    this.idToInternal.set(chunkId, internalId);
    this.internalToId.set(internalId, chunkId);
    this.entries.set(internalId, entry);

    this.index!.addPoint(embedding, internalId);
    this.isDirty = true;
  }

  updateVector(chunkId: string, embedding: number[], entry: IndexEntry): void {
    if (!this.index) {
      this.initialize();
    }

    const internalId = this.idToInternal.get(chunkId);
    if (internalId === undefined) {
      this.addVector(chunkId, embedding, entry);
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

  removeVector(chunkId: string): boolean {
    if (!this.index) return false;

    const internalId = this.idToInternal.get(chunkId);
    if (internalId === undefined) return false;

    this.index.markDelete(internalId);
    this.idToInternal.delete(chunkId);
    this.internalToId.delete(internalId);
    this.entries.delete(internalId);
    this.isDirty = true;

    return true;
  }

  removeFile(filePath: string): number {
    let removed = 0;
    const toRemove: string[] = [];

    for (const [chunkId, internalId] of this.idToInternal) {
      const entry = this.entries.get(internalId);
      if (entry && entry.filePath === filePath) {
        toRemove.push(chunkId);
      }
    }

    for (const chunkId of toRemove) {
      if (this.removeVector(chunkId)) {
        removed++;
      }
    }

    return removed;
  }

  search(queryEmbedding: number[], topK: number): SearchResult[] {
    if (!this.index) {
      this.initialize();
    }

    const numElements = this.index!.getMaxElements();
    if (numElements === 0) {
      return [];
    }

    const effectiveK = Math.min(topK, this.index!.getCurrentCount());
    if (effectiveK === 0) {
      return [];
    }

    const results = this.index!.searchKnn(queryEmbedding, effectiveK);

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

  clear(): void {
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

const activeIndexes = new Map<string, HNSWVectorIndex>();

export function getOrCreateIndex(
  storagePath: string,
  dimensions: number,
  config?: Partial<HNSWIndexConfig>
): HNSWVectorIndex {
  let index = activeIndexes.get(storagePath);

  if (!index) {
    index = new HNSWVectorIndex(dimensions, storagePath, config);
    index.initialize();
    activeIndexes.set(storagePath, index);
  }

  return index;
}

export function closeIndex(storagePath: string): void {
  const index = activeIndexes.get(storagePath);
  if (index) {
    index.close();
    activeIndexes.delete(storagePath);
  }
}
