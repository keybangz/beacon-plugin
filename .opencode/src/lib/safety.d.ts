/**
 * Safety checks and blacklist management
 * Prevents indexing of sensitive paths
 */
/**
 * Check if current working directory is blacklisted
 * @returns True if current directory is blacklisted
 */
export declare function isCwdBlacklisted(): boolean;
/**
 * Check if a path is blacklisted
 * @param path - Path to check
 * @param blacklist - Array of blacklisted paths
 * @returns True if path matches any blacklist pattern
 */
export declare function isPathBlacklisted(path: string, blacklist?: string[]): boolean;
/**
 * Validate that a path is safe to index
 * @param path - Path to validate
 * @throws Error if path is blacklisted or dangerous
 */
export declare function validatePathSafety(path: string): void;
//# sourceMappingURL=safety.d.ts.map