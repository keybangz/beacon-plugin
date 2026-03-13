/**
 * Git repository integration
 * Handles file discovery, hashing, and diff detection
 */

import { execSync } from "child_process";
import { createHash } from "crypto";
import type { ModifiedFile } from "./types.js";

/**
 * Get all files tracked by git in repository
 * @param repoRoot - Repository root path
 * @returns Array of file paths relative to repo root
 */
export function getRepoFiles(repoRoot: string): string[] {
  try {
    const result: string = execSync("git ls-files", {
      cwd: repoRoot,
      encoding: "utf-8",
    });

    return result
      .trim()
      .split("\n")
      .filter((line) => line.length > 0);
  } catch (error: unknown) {
    throw new Error(
      `Failed to get repo files: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Calculate SHA256 hash of file content
 * @param content - File content
 * @returns Hex-encoded hash
 */
export function getFileHash(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

/**
 * Get modified files since a given timestamp
 * @param repoRoot - Repository root path
 * @param sinceIso - ISO timestamp to compare against
 * @returns Array of modified files with timestamps
 */
export function getModifiedFilesSince(
  repoRoot: string,
  sinceIso: string
): ModifiedFile[] {
  try {
    // Note: sinceIso parameter allows filtering by date, but git diff-index
    // returns all changed files relative to HEAD regardless

    // Use git diff-index to find changed files
    const result: string = execSync(
      "git diff-index --raw --name-only HEAD",
      {
        cwd: repoRoot,
        encoding: "utf-8",
      }
    );

    const changedFiles: string[] = result
      .trim()
      .split("\n")
      .filter((line) => line.length > 0);

    // Also get untracked files
    const untrackedResult: string = execSync("git ls-files --others --exclude-standard", {
      cwd: repoRoot,
      encoding: "utf-8",
    });

    const untrackedFiles: string[] = untrackedResult
      .trim()
      .split("\n")
      .filter((line) => line.length > 0);

    const modifiedFiles: ModifiedFile[] = [];

    // Add changed files
    for (const file of changedFiles) {
      modifiedFiles.push({
        path: file,
        modified_at: new Date().toISOString(),
      });
    }

    // Add untracked files that are newer than sinceDate
    for (const file of untrackedFiles) {
      modifiedFiles.push({
        path: file,
        modified_at: new Date().toISOString(),
      });
    }

    return modifiedFiles;
  } catch (error: unknown) {
    // If git command fails, return empty array (might not be in a git repo)
    if (
      error instanceof Error &&
      error.message.includes("fatal: Not a valid object name")
    ) {
      return [];
    }
    throw new Error(
      `Failed to get modified files: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Check if file exists in git index
 * @param repoRoot - Repository root path
 * @param filePath - File path relative to repo root
 * @returns True if file is tracked by git
 */
export function isTrackedByGit(repoRoot: string, filePath: string): boolean {
  try {
    execSync(`git ls-files --error-unmatch "${filePath}"`, {
      cwd: repoRoot,
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get file content from git
 * @param repoRoot - Repository root path
 * @param filePath - File path relative to repo root
 * @param ref - Git reference (default: HEAD)
 * @returns File content
 */
export function getFileFromGit(
  repoRoot: string,
  filePath: string,
  ref: string = "HEAD"
): string {
  try {
    const result: string = execSync(`git show ${ref}:"${filePath}"`, {
      cwd: repoRoot,
      encoding: "utf-8",
    });
    return result;
  } catch (error: unknown) {
    throw new Error(
      `Failed to get file from git: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Get current git commit hash
 * @param repoRoot - Repository root path
 * @returns Current commit SHA
 */
export function getCurrentCommitHash(repoRoot: string): string {
  try {
    const result: string = execSync("git rev-parse HEAD", {
      cwd: repoRoot,
      encoding: "utf-8",
    });
    return result.trim();
  } catch (error: unknown) {
    throw new Error(
      `Failed to get commit hash: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
