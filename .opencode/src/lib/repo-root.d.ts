/**
 * Repository root detection
 * Finds the .git directory to determine repository root
 */
/**
 * Find the git repository root by searching for .git directory
 * @param startPath - Starting path for search (defaults to cwd)
 * @returns Path to repository root, or null if not found
 */
export declare function findRepoRoot(startPath?: string): string | null;
/**
 * Get repository root, throwing error if not found
 * @param startPath - Starting path for search
 * @returns Path to repository root
 * @throws Error if not in a git repository
 */
export declare function getRepoRoot(startPath?: string): string;
//# sourceMappingURL=repo-root.d.ts.map