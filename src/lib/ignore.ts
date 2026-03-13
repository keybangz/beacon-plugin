/**
 * File ignore pattern matching
 * Uses picomatch for glob pattern matching with memoized compiled matchers
 */

import pm from "picomatch";

/**
 * Memoized cache of compiled picomatch matchers keyed by a stable JSON key
 * of the pattern array. Avoids recompiling 20+ glob patterns for every file
 * during indexing (savings: ~400K compilations for 10K files × 20 patterns).
 */
const matcherCache = new Map<string, (path: string) => boolean>();

/**
 * Create (or retrieve from cache) a matcher function for glob patterns.
 * @param patterns - Array of glob patterns
 * @returns Function that returns true if path matches any pattern
 */
function createMatcher(patterns: string[]): (path: string) => boolean {
  // Use JSON.stringify as a stable key — pattern arrays are small so this is cheap
  const cacheKey = JSON.stringify(patterns);
  const cached = matcherCache.get(cacheKey);
  if (cached) return cached;

  const matchers = patterns.map((pattern) => pm(pattern, { dot: true }));
  const matcher = (path: string): boolean => matchers.some((m) => m(path));

  matcherCache.set(cacheKey, matcher);
  return matcher;
}

/**
 * Determine if a file should be indexed
 * @param filePath - Relative file path
 * @param includePatterns - Patterns to include
 * @param excludePatterns - Patterns to exclude
 * @returns True if file should be indexed
 */
export function shouldIndex(
  filePath: string,
  includePatterns: string[],
  excludePatterns: string[]
): boolean {
  // Check exclude patterns first
  const excludeMatcher = createMatcher(excludePatterns);
  if (excludeMatcher(filePath)) {
    return false;
  }

  // Check include patterns
  const includeMatcher = createMatcher(includePatterns);
  return includeMatcher(filePath);
}

/**
 * Validate glob patterns
 * @param patterns - Patterns to validate
 * @throws Error if any pattern is invalid
 */
export function validatePatterns(patterns: string[]): void {
  for (const pattern of patterns) {
    try {
      // Test pattern compilation
      pm(pattern, { dot: true });
    } catch (error: unknown) {
      throw new Error(
        `Invalid glob pattern "${pattern}": ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
