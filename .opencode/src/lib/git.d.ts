/**
 * Git repository integration
 * Handles file discovery, hashing, and diff detection
 */
import type { ModifiedFile } from "./types.js";
/**
 * Get all files tracked by git in repository
 * @param repoRoot - Repository root path
 * @returns Array of file paths relative to repo root
 */
export declare function getRepoFiles(repoRoot: string): string[];
/**
 * Calculate SHA256 hash of file content
 * @param content - File content
 * @returns Hex-encoded hash
 */
export declare function getFileHash(content: string): string;
/**
 * Get modified files since a given timestamp.
 * - Tracked files: uses `git log --since` to find files changed in commits after
 *   sinceIso, plus `git diff-index HEAD` for staged/unstaged working-tree changes.
 * - Untracked files: only included when their mtime is newer than sinceIso.
 * @param repoRoot - Repository root path
 * @param sinceIso - ISO timestamp; only files modified after this are returned
 * @returns Array of modified files with timestamps
 */
export declare function getModifiedFilesSince(repoRoot: string, sinceIso: string): ModifiedFile[];
/**
 * Check if file exists in git index
 * @param repoRoot - Repository root path
 * @param filePath - File path relative to repo root
 * @returns True if file is tracked by git
 */
export declare function isTrackedByGit(repoRoot: string, filePath: string): boolean;
/**
 * Get file content from git
 * @param repoRoot - Repository root path
 * @param filePath - File path relative to repo root
 * @param ref - Git reference (default: HEAD)
 * @returns File content
 */
export declare function getFileFromGit(repoRoot: string, filePath: string, ref?: string): string;
/**
 * Get current git commit hash
 * @param repoRoot - Repository root path
 * @returns Current commit SHA
 */
export declare function getCurrentCommitHash(repoRoot: string): string;
//# sourceMappingURL=git.d.ts.map