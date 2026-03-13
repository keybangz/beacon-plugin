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
/**
 * Generic LRU (Least Recently Used) cache implementation
 */
export declare class LRUCache<T> {
    private cache;
    private maxSize;
    private stats;
    private createdAt;
    constructor(maxSize?: number);
    /**
     * Get value from cache
     * @param key - Cache key
     * @returns Cached value or null if not found
     */
    get(key: string): T | null;
    /**
     * Set value in cache
     * @param key - Cache key
     * @param value - Value to cache
     */
    set(key: string, value: T): void;
    /**
     * Check if key exists in cache
     */
    has(key: string): boolean;
    /**
     * Clear all entries from cache
     */
    clear(): void;
    /**
     * Get cache statistics
     */
    getStats(): CacheStats & {
        hitRate: number;
        uptime: number;
    };
    /**
     * Get cache size
     */
    size(): number;
}
/**
 * Search result cache with time-based expiration
 */
export declare class SearchCache {
    private cache;
    private ttl;
    constructor(maxSize?: number, ttlMs?: number);
    /**
     * Generate cache key from search parameters
     */
    private generateKey;
    /**
     * Get cached search results
     */
    get(query: string, options?: Record<string, unknown>): unknown[] | null;
    /**
     * Set cached search results
     */
    set(query: string, results: unknown[], options?: Record<string, unknown>): void;
    /**
     * Clear cache
     */
    clear(): void;
    /**
     * Get cache statistics
     */
    getStats(): ReturnType<typeof this.cache.getStats>;
}
/**
 * Performance timer for measuring operation duration
 */
export declare class PerformanceTimer {
    private startTime;
    private label;
    private measurements;
    constructor(label?: string);
    /**
     * Mark a checkpoint
     */
    mark(name: string): number;
    /**
     * Get duration since start
     */
    elapsed(): number;
    /**
     * Get all measurements
     */
    getMeasurements(): Record<string, {
        count: number;
        min: number;
        max: number;
        avg: number;
    }>;
    /**
     * Get summary
     */
    summary(): string;
}
export {};
//# sourceMappingURL=cache.d.ts.map