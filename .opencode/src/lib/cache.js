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
    get(key) {
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
    set(key, value) {
        if (this.cache.has(key)) {
            this.cache.delete(key);
        }
        else {
            this.stats.size++;
        }
        this.cache.set(key, {
            value,
            timestamp: Date.now(),
            accessCount: 0,
        });
        if (this.cache.size > this.maxSize) {
            const firstKey = this.cache.keys().next().value;
            if (firstKey) {
                this.cache.delete(firstKey);
                this.stats.evictions++;
                this.stats.size--;
            }
        }
    }
    has(key) {
        return this.cache.has(key);
    }
    delete(key) {
        const deleted = this.cache.delete(key);
        if (deleted) {
            this.stats.size--;
        }
        return deleted;
    }
    clear() {
        this.cache.clear();
        this.stats.size = 0;
    }
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
    size() {
        return this.cache.size;
    }
}
function hashString(str) {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
    }
    return hash >>> 0;
}
function hashOptions(options) {
    if (!options || Object.keys(options).length === 0)
        return 0;
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
    constructor(maxSize = 500, ttlMs = 300000) {
        this.cache = new LRUCache(maxSize);
        this.ttl = ttlMs;
    }
    generateKey(query, optionsHash) {
        return `${query}#${optionsHash}`;
    }
    get(query, options) {
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
    set(query, results, options) {
        const optionsHash = hashOptions(options);
        const key = this.generateKey(query, optionsHash);
        this.cache.set(key, {
            results,
            timestamp: Date.now(),
            optionsHash,
        });
    }
    clear() {
        this.cache.clear();
    }
    getStats() {
        return this.cache.getStats();
    }
}
export class PerformanceTimer {
    constructor(label = "operation") {
        this.label = label;
        this.startTime = performance.now();
        this.measurements = new Map();
    }
    mark(name) {
        const now = performance.now();
        const duration = now - this.startTime;
        if (!this.measurements.has(name)) {
            this.measurements.set(name, []);
        }
        this.measurements.get(name).push(duration);
        return duration;
    }
    elapsed() {
        return performance.now() - this.startTime;
    }
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
//# sourceMappingURL=cache.js.map