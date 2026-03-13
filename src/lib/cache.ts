/**
 * LRU Cache with performance tracking
 * Provides in-memory caching for search results and embeddings
 */

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

/**
 * Generic LRU (Least Recently Used) cache implementation
 */
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

  /**
   * Get value from cache
   * @param key - Cache key
   * @returns Cached value or null if not found
   */
  get(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) {
      this.stats.misses++;
      return null;
    }

    // Update access metadata
    entry.timestamp = Date.now();
    entry.accessCount++;
    this.stats.hits++;

    // Move to end (most recently used)
    this.cache.delete(key);
    this.cache.set(key, entry);

    return entry.value;
  }

  /**
   * Set value in cache
   * @param key - Cache key
   * @param value - Value to cache
   */
  set(key: string, value: T): void {
    // Remove if exists (will be re-added)
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else {
      this.stats.size++;
    }

    // Add new entry
    this.cache.set(key, {
      value,
      timestamp: Date.now(),
      accessCount: 0,
    });

    // Evict least recently used if cache is full
    if (this.cache.size > this.maxSize) {
      const firstKey = this.cache.keys().next().value as string | undefined;
      if (firstKey) {
        this.cache.delete(firstKey);
        this.stats.evictions++;
        this.stats.size--;
      }
    }
  }

  /**
   * Check if key exists in cache
   */
  has(key: string): boolean {
    return this.cache.has(key);
  }

  /**
   * Clear all entries from cache
   */
  clear(): void {
    this.cache.clear();
    this.stats.size = 0;
  }

  /**
   * Get cache statistics
   */
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

  /**
   * Get cache size
   */
  size(): number {
    return this.cache.size;
  }
}

interface SearchCacheEntry {
  results: unknown[];
  timestamp: number;
}

/**
 * Search result cache with time-based expiration
 */
export class SearchCache {
  private cache: LRUCache<SearchCacheEntry>;
  private ttl: number; // Time to live in milliseconds

  constructor(maxSize: number = 500, ttlMs: number = 300000) {
    // 5 min default TTL
    this.cache = new LRUCache(maxSize);
    this.ttl = ttlMs;
  }

  /**
   * Generate cache key from search parameters
   */
  private generateKey(
    query: string,
    options?: Record<string, unknown>
  ): string {
    const optionsStr = options ? JSON.stringify(options) : "{}";
    return `${query}:${optionsStr}`;
  }

  /**
   * Get cached search results
   */
  get(query: string, options?: Record<string, unknown>): unknown[] | null {
    const key = this.generateKey(query, options);
    const entry = this.cache.get(key);

    if (!entry) {
      return null;
    }

    // Check if expired
    if (Date.now() - entry.timestamp > this.ttl) {
      this.cache.set(key, entry); // Will evict if needed
      return null;
    }

    return entry.results;
  }

  /**
   * Set cached search results
   */
  set(query: string, results: unknown[], options?: Record<string, unknown>): void {
    const key = this.generateKey(query, options);
    this.cache.set(key, {
      results,
      timestamp: Date.now(),
    });
  }

  /**
   * Clear cache
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get cache statistics
   */
  getStats(): ReturnType<typeof this.cache.getStats> {
    return this.cache.getStats();
  }
}

/**
 * Performance timer for measuring operation duration
 */
export class PerformanceTimer {
  private startTime: number;
  private label: string;
  private measurements: Map<string, number[]>;

  constructor(label: string = "operation") {
    this.label = label;
    this.startTime = performance.now();
    this.measurements = new Map();
  }

  /**
   * Mark a checkpoint
   */
  mark(name: string): number {
    const now = performance.now();
    const duration = now - this.startTime;

    if (!this.measurements.has(name)) {
      this.measurements.set(name, []);
    }
    this.measurements.get(name)!.push(duration);

    return duration;
  }

  /**
   * Get duration since start
   */
  elapsed(): number {
    return performance.now() - this.startTime;
  }

  /**
   * Get all measurements
   */
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

  /**
   * Get summary
   */
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
