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
export function findRepoRoot(startPath: string = process.cwd()): string | null {
  let currentPath: string = startPath;
  let previousPath: string = "";
  let iterationCount = 0;
  const MAX_ITERATIONS = 100; // Reasonable limit for directory depth

  // Search up the directory tree for .git directory
  while (iterationCount < MAX_ITERATIONS) {
    const gitPath: string = join(currentPath, ".git");

    if (existsSync(gitPath)) {
      return currentPath;
    }

    const parentPath: string = join(currentPath, "..");

    // Prevent infinite loop at filesystem root or symlink loops
    if (parentPath === currentPath || currentPath === previousPath) {
      return null;
    }

    // Additional safeguard: if we went through many iterations without progress
    iterationCount++;
    previousPath = currentPath;
    currentPath = parentPath;
  }

  // If we hit the iteration limit, return null
  return null;
}

/**
 * Get repository root, throwing error if not found
 * @param startPath - Starting path for search
 * @returns Path to repository root
 * @throws Error if not in a git repository
 */
export function getRepoRoot(startPath?: string): string {
  const root: string | null = findRepoRoot(startPath);

  if (root === null) {
    throw new Error(
      "Not in a git repository. Beacon requires a git-initialized project."
    );
  }

  return root;
}

/**
 * Get repository root or fallback root
 * Finds .git or defaults to project root (cwd) or user home
 * @param startPath - Starting path for search
 * @returns Path to repository root, or fallback
 */
export function getBeaconRoot(startPath?: string): string {
  const repoRoot = findRepoRoot(startPath);
  if (repoRoot) {
    return repoRoot;
  }
  // Fallback to project root (cwd) if not a git repo
  // Guard against filesystem root being used as a project root — it is never valid.
  const isFilesystemRoot = (p: string) => p === "/" || p === "\\" || /^[A-Za-z]:[/\\]?$/.test(p);
  if (startPath && typeof startPath === "string" && startPath.length > 0 && !isFilesystemRoot(startPath)) {
    return startPath;
  }
  if (typeof process.cwd === "function") {
    return process.cwd();
  }
  // Fallback to user home if all else fails
  return process.env.HOME || process.env.USERPROFILE || "/tmp";
}
