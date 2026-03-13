/**
 * File ignore pattern matching
 * Uses picomatch for glob pattern matching with memoized compiled matchers
 */
/**
 * Determine if a file should be indexed
 * @param filePath - Relative file path
 * @param includePatterns - Patterns to include
 * @param excludePatterns - Patterns to exclude
 * @returns True if file should be indexed
 */
export declare function shouldIndex(filePath: string, includePatterns: string[], excludePatterns: string[]): boolean;
/**
 * Validate glob patterns
 * @param patterns - Patterns to validate
 * @throws Error if any pattern is invalid
 */
export declare function validatePatterns(patterns: string[]): void;
//# sourceMappingURL=ignore.d.ts.map