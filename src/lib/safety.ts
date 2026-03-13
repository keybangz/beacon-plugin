/**
 * Safety checks and blacklist management
 * Prevents indexing of sensitive paths
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { getRepoRoot } from "./repo-root.js";

/**
 * Default blacklist paths (sensitive directories)
 */
const DEFAULT_BLACKLIST: string[] = [
  ".git",
  ".env",
  ".env.local",
  ".env.*.local",
  "node_modules",
  "venv",
  ".venv",
  "vendor",
  "dist",
  "build",
];

/**
 * Get current working directory blacklist
 * @returns Array of blacklisted paths
 */
function getBlacklist(): string[] {
  try {
    const repoRoot: string = getRepoRoot();
    const blacklistPath: string = join(repoRoot, ".opencode", "blacklist.json");

    if (existsSync(blacklistPath)) {
      const content: string = readFileSync(blacklistPath, "utf-8");
      const data = JSON.parse(content) as Record<string, unknown>;

      if (Array.isArray(data.paths)) {
        return [...DEFAULT_BLACKLIST, ...(data.paths as string[])];
      }
    }
  } catch {
    // Silently fail, use defaults
  }

  return DEFAULT_BLACKLIST;
}

/**
 * Check if current working directory is blacklisted
 * @returns True if current directory is blacklisted
 */
export function isCwdBlacklisted(): boolean {
  try {
    const cwd: string = process.cwd();
    const repoRoot: string = getRepoRoot();
    const blacklist: string[] = getBlacklist();

    for (const blacklistedPath of blacklist) {
      const fullPath: string = join(repoRoot, blacklistedPath);

      if (cwd.startsWith(fullPath)) {
        return true;
      }
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Check if a path is blacklisted
 * @param path - Path to check
 * @param blacklist - Array of blacklisted paths
 * @returns True if path matches any blacklist pattern
 */
export function isPathBlacklisted(
  path: string,
  blacklist: string[] = getBlacklist()
): boolean {
  for (const blacklistedPath of blacklist) {
    if (path.includes(blacklistedPath)) {
      return true;
    }
  }

  return false;
}

/**
 * Validate that a path is safe to index
 * @param path - Path to validate
 * @throws Error if path is blacklisted or dangerous
 */
export function validatePathSafety(path: string): void {
  // Check for path traversal attempts
  if (path.includes("..")) {
    throw new Error("Path traversal detected");
  }

  // Check blacklist
  if (isPathBlacklisted(path)) {
    throw new Error(`Path is blacklisted: ${path}`);
  }
}
