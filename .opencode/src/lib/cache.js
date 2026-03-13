/**
 * LRU Cache with performance tracking
 * Provides in-memory caching for search results and embeddings
 */
/**
 * Generic LRU (Least Recently Used) cache implementation
 */
export class LRUCache {
    constructor(maxSize = 1000) {
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
    get(key) {
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
    set(key, value) {
        // Remove if exists (will be re-added)
        if (this.cache.has(key)) {
            this.cache.delete(key);
        }
        else {
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
            const firstKey = this.cache.keys().next().value;
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
    has(key) {
        return this.cache.has(key);
    }
    /**
     * Clear all entries from cache
     */
    clear() {
        this.cache.clear();
        this.stats.size = 0;
    }
    /**
     * Get cache statistics
     */
    getStats() {
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
    size() {
        return this.cache.size;
    }
}
/**
 * Search result cache with time-based expiration
 */
export class SearchCache {
    constructor(maxSize = 500, ttlMs = 300000) {
        // 5 min default TTL
        this.cache = new LRUCache(maxSize);
        this.ttl = ttlMs;
    }
    /**
     * Generate cache key from search parameters
     */
    generateKey(query, options) {
        const optionsStr = options ? JSON.stringify(options) : "{}";
        return `${query}:${optionsStr}`;
    }
    /**
     * Get cached search results
     */
    get(query, options) {
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
    set(query, results, options) {
        const key = this.generateKey(query, options);
        this.cache.set(key, {
            results,
            timestamp: Date.now(),
        });
    }
    /**
     * Clear cache
     */
    clear() {
        this.cache.clear();
    }
    /**
     * Get cache statistics
     */
    getStats() {
        return this.cache.getStats();
    }
}
/**
 * Performance timer for measuring operation duration
 */
export class PerformanceTimer {
    constructor(label = "operation") {
        this.label = label;
        this.startTime = performance.now();
        this.measurements = new Map();
    }
    /**
     * Mark a checkpoint
     */
    mark(name) {
        const now = performance.now();
        const duration = now - this.startTime;
        if (!this.measurements.has(name)) {
            this.measurements.set(name, []);
        }
        this.measurements.get(name).push(duration);
        return duration;
    }
    /**
     * Get duration since start
     */
    elapsed() {
        return performance.now() - this.startTime;
    }
    /**
     * Get all measurements
     */
    getMeasurements() {
        const result = {};
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
    summary() {
        const measurements = this.getMeasurements();
        const total = this.elapsed();
        let summary = `${this.label} (${total.toFixed(2)}ms):\n`;
        for (const [name, stats] of Object.entries(measurements)) {
            summary += `  ${name}: ${stats.avg.toFixed(2)}ms (${stats.count} samples, min: ${stats.min.toFixed(2)}ms, max: ${stats.max.toFixed(2)}ms)\n`;
        }
        return summary;
    }
}
