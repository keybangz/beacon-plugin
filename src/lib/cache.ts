interface CacheStats {
  hits: number;
  misses: number;
  evictions: number;
  size: number;
}

interface CacheEntry<T> {
  value: T;
  timestamp: number;
  accessCount: number;
}

export class LRUCache<T> {
  private cache: Map<string, CacheEntry<T>>;
  private maxSize: number;
  private stats: CacheStats;
  private createdAt: number;

  constructor(maxSize: number = 1000) {
    this.cache = new Map();
    this.maxSize = maxSize;
    this.stats = {
      hits: 0,
      misses: 0,
      evictions: 0,
      size: 0,
    };
    this.createdAt = Date.now();
  }

  get(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) {
      this.stats.misses++;
      return null;
    }

    entry.timestamp = Date.now();
    entry.accessCount++;
    this.stats.hits++;

    this.cache.delete(key);
    this.cache.set(key, entry);

    return entry.value;
  }

  set(key: string, value: T): void {
    const isUpdate = this.cache.has(key);

    if (isUpdate) {
      this.cache.delete(key);
    } else {
      this.stats.size++;
    }

    this.cache.set(key, {
      value,
      timestamp: Date.now(),
      accessCount: 0,
    });

    if (this.cache.size > this.maxSize) {
      const firstKey = this.cache.keys().next().value as string | undefined;
      if (firstKey) {
        this.cache.delete(firstKey);
        this.stats.evictions++;
        this.stats.size--;
      }
    }
  }

  has(key: string): boolean {
    return this.cache.has(key);
  }

  delete(key: string): boolean {
    const deleted = this.cache.delete(key);
    if (deleted) {
      this.stats.size--;
    }
    return deleted;
  }

  clear(): void {
    this.cache.clear();
    this.stats.size = 0;
  }

  getStats(): CacheStats & { hitRate: number; uptime: number } {
    const total = this.stats.hits + this.stats.misses;
    const hitRate = total > 0 ? this.stats.hits / total : 0;
    const uptime = Date.now() - this.createdAt;

    return {
      ...this.stats,
      hitRate,
      uptime,
    };
  }

  size(): number {
    return this.cache.size;
  }
}

interface SearchCacheEntry {
  results: unknown[];
  timestamp: number;
  optionsHash: number;
}

function hashString(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
  }
  return hash >>> 0;
}

function hashOptions(options?: Record<string, unknown>): number {
  if (!options || Object.keys(options).length === 0) return 0;
  
  let hash = 0;
  const keys = Object.keys(options).sort();
  for (const key of keys) {
    const val = options[key];
    hash = ((hash << 5) + hash) ^ hashString(key);
    hash = ((hash << 5) + hash) ^ hashString(String(val));
  }
  return hash >>> 0;
}

export class SearchCache {
  private cache: LRUCache<SearchCacheEntry>;
  private ttl: number;

  constructor(maxSize: number = 500, ttlMs: number = 300000) {
    this.cache = new LRUCache(maxSize);
    this.ttl = ttlMs;
  }

  private generateKey(query: string, optionsHash: number): string {
    return `${query}#${optionsHash}`;
  }

  get(query: string, options?: Record<string, unknown>): unknown[] | null {
    const optionsHash = hashOptions(options);
    const key = this.generateKey(query, optionsHash);
    const entry = this.cache.get(key);

    if (!entry) {
      return null;
    }

    if (Date.now() - entry.timestamp > this.ttl) {
      this.cache.delete(key);
      return null;
    }

    return entry.results;
  }

  set(query: string, results: unknown[], options?: Record<string, unknown>): void {
    const optionsHash = hashOptions(options);
    const key = this.generateKey(query, optionsHash);
    this.cache.set(key, {
      results,
      timestamp: Date.now(),
      optionsHash,
    });
  }

  clear(): void {
    this.cache.clear();
  }

  getStats(): ReturnType<typeof this.cache.getStats> {
    return this.cache.getStats();
  }
}

export class PerformanceTimer {
  private startTime: number;
  private label: string;
  private measurements: Map<string, number[]>;

  constructor(label: string = "operation") {
    this.label = label;
    this.startTime = performance.now();
    this.measurements = new Map();
  }

  mark(name: string): number {
    const now = performance.now();
    const duration = now - this.startTime;

    if (!this.measurements.has(name)) {
      this.measurements.set(name, []);
    }
    this.measurements.get(name)!.push(duration);

    return duration;
  }

  elapsed(): number {
    return performance.now() - this.startTime;
  }

  getMeasurements(): Record<string, { count: number; min: number; max: number; avg: number }> {
    const result: Record<string, { count: number; min: number; max: number; avg: number }> = {};

    for (const [name, measurements] of this.measurements) {
      const count = measurements.length;
      const min = Math.min(...measurements);
      const max = Math.max(...measurements);
      const avg = measurements.reduce((a, b) => a + b, 0) / count;

      result[name] = { count, min, max, avg };
    }

    return result;
  }

  summary(): string {
    const measurements = this.getMeasurements();
    const total = this.elapsed();
    let summary = `${this.label} (${total.toFixed(2)}ms):\n`;

    for (const [name, stats] of Object.entries(measurements)) {
      summary += `  ${name}: ${stats.avg.toFixed(2)}ms (${stats.count} samples, min: ${stats.min.toFixed(2)}ms, max: ${stats.max.toFixed(2)}ms)\n`;
    }

    return summary;
  }
}
