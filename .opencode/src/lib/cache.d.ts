interface CacheStats {
    hits: number;
    misses: number;
    evictions: number;
    size: number;
}
export declare class LRUCache<T> {
    private cache;
    private maxSize;
    private stats;
    private createdAt;
    constructor(maxSize?: number);
    get(key: string): T | null;
    set(key: string, value: T): void;
    has(key: string): boolean;
    delete(key: string): boolean;
    clear(): void;
    getStats(): CacheStats & {
        hitRate: number;
        uptime: number;
    };
    size(): number;
}
export declare class SearchCache {
    private cache;
    private ttl;
    constructor(maxSize?: number, ttlMs?: number);
    private generateKey;
    get(query: string, options?: Record<string, unknown>): unknown[] | null;
    set(query: string, results: unknown[], options?: Record<string, unknown>): void;
    clear(): void;
    getStats(): ReturnType<typeof this.cache.getStats>;
}
export declare class PerformanceTimer {
    private startTime;
    private label;
    private measurements;
    constructor(label?: string);
    mark(name: string): number;
    elapsed(): number;
    getMeasurements(): Record<string, {
        count: number;
        min: number;
        max: number;
        avg: number;
    }>;
    summary(): string;
}
export {};
//# sourceMappingURL=cache.d.ts.map