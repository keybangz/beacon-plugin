/**
 * File ignore pattern matching
 * Uses picomatch for glob pattern matching
 */

import pm from "picomatch";

/**
 * Create a matcher function for glob patterns
 * @param patterns - Array of glob patterns
 * @returns Function that returns true if path matches any pattern
 */
function createMatcher(patterns: string[]): (path: string) => boolean {
  const matchers = patterns.map((pattern) => pm(pattern, { dot: true }));

  return (path: string): boolean => {
    return matchers.some((matcher) => matcher(path));
  };
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
