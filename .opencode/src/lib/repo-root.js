/**
 * Repository root detection
 * Finds the .git directory to determine repository root
 */
import { existsSync } from "fs";
import { join } from "path";
/**
 * Find the git repository root by searching for .git directory
 * @param startPath - Starting path for search (defaults to cwd)
 * @returns Path to repository root, or null if not found
 */
export function findRepoRoot(startPath = process.cwd()) {
    let currentPath = startPath;
    // Search up the directory tree for .git directory
    while (true) {
        const gitPath = join(currentPath, ".git");
        if (existsSync(gitPath)) {
            return currentPath;
        }
        const parentPath = join(currentPath, "..");
        // Prevent infinite loop at filesystem root
        if (parentPath === currentPath) {
            return null;
        }
        currentPath = parentPath;
    }
}
/**
 * Get repository root, throwing error if not found
 * @param startPath - Starting path for search
 * @returns Path to repository root
 * @throws Error if not in a git repository
 */
export function getRepoRoot(startPath) {
    const root = findRepoRoot(startPath);
    if (root === null) {
        throw new Error("Not in a git repository. Beacon requires a git-initialized project.");
    }
    return root;
}
//# sourceMappingURL=repo-root.js.map