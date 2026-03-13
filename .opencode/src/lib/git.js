/**
 * Git repository integration
 * Handles file discovery, hashing, and diff detection
 */
import { execSync } from "child_process";
import { createHash } from "crypto";
import { statSync } from "fs";
import { join } from "path";
/**
 * Get all files tracked by git in repository
 * @param repoRoot - Repository root path
 * @returns Array of file paths relative to repo root
 */
export function getRepoFiles(repoRoot) {
    try {
        const result = execSync("git ls-files", {
            cwd: repoRoot,
            encoding: "utf-8",
        });
        return result
            .trim()
            .split("\n")
            .filter((line) => line.length > 0);
    }
    catch (error) {
        throw new Error(`Failed to get repo files: ${error instanceof Error ? error.message : String(error)}`);
    }
}
/**
 * Calculate SHA256 hash of file content
 * @param content - File content
 * @returns Hex-encoded hash
 */
export function getFileHash(content) {
    return createHash("sha256").update(content, "utf-8").digest("hex");
}
/**
 * Get modified files since a given timestamp.
 * - Tracked files: uses `git log --since` to find files changed in commits after
 *   sinceIso, plus `git diff-index HEAD` for staged/unstaged working-tree changes.
 * - Untracked files: only included when their mtime is newer than sinceIso.
 * @param repoRoot - Repository root path
 * @param sinceIso - ISO timestamp; only files modified after this are returned
 * @returns Array of modified files with timestamps
 */
export function getModifiedFilesSince(repoRoot, sinceIso) {
    const sinceMs = new Date(sinceIso).getTime();
    try {
        // 1. Files changed in commits since sinceIso
        const logResult = execSync(`git log --since="${sinceIso}" --name-only --pretty=format:""`, { cwd: repoRoot, encoding: "utf-8" });
        const committedFiles = new Set(logResult
            .trim()
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l.length > 0));
        // 2. Files with working-tree changes (staged or unstaged) relative to HEAD
        const diffResult = execSync("git diff-index --name-only HEAD", { cwd: repoRoot, encoding: "utf-8" });
        const workingTreeFiles = diffResult
            .trim()
            .split("\n")
            .filter((l) => l.length > 0);
        // Merge both sets of tracked changed files
        for (const f of workingTreeFiles)
            committedFiles.add(f);
        const modifiedFiles = [];
        for (const file of committedFiles) {
            modifiedFiles.push({
                path: file,
                modified_at: new Date().toISOString(),
            });
        }
        // 3. Untracked files — only include those newer than sinceIso
        const untrackedResult = execSync("git ls-files --others --exclude-standard", { cwd: repoRoot, encoding: "utf-8" });
        const untrackedFiles = untrackedResult
            .trim()
            .split("\n")
            .filter((l) => l.length > 0);
        for (const file of untrackedFiles) {
            try {
                const fullPath = join(repoRoot, file);
                const mtime = statSync(fullPath).mtimeMs;
                if (mtime > sinceMs) {
                    modifiedFiles.push({
                        path: file,
                        modified_at: new Date(mtime).toISOString(),
                    });
                }
            }
            catch {
                // File may have been deleted between listing and stat — skip
            }
        }
        return modifiedFiles;
    }
    catch (error) {
        // If git command fails (e.g. no commits yet), return empty array
        if (error instanceof Error &&
            (error.message.includes("fatal: Not a valid object name") ||
                error.message.includes("fatal: bad default revision"))) {
            return [];
        }
        throw new Error(`Failed to get modified files: ${error instanceof Error ? error.message : String(error)}`);
    }
}
/**
 * Check if file exists in git index
 * @param repoRoot - Repository root path
 * @param filePath - File path relative to repo root
 * @returns True if file is tracked by git
 */
export function isTrackedByGit(repoRoot, filePath) {
    try {
        execSync(`git ls-files --error-unmatch "${filePath}"`, {
            cwd: repoRoot,
            stdio: "pipe",
        });
        return true;
    }
    catch {
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
export function getFileFromGit(repoRoot, filePath, ref = "HEAD") {
    try {
        const result = execSync(`git show ${ref}:"${filePath}"`, {
            cwd: repoRoot,
            encoding: "utf-8",
        });
        return result;
    }
    catch (error) {
        throw new Error(`Failed to get file from git: ${error instanceof Error ? error.message : String(error)}`);
    }
}
/**
 * Get current git commit hash
 * @param repoRoot - Repository root path
 * @returns Current commit SHA
 */
export function getCurrentCommitHash(repoRoot) {
    try {
        const result = execSync("git rev-parse HEAD", {
            cwd: repoRoot,
            encoding: "utf-8",
        });
        return result.trim();
    }
    catch (error) {
        throw new Error(`Failed to get commit hash: ${error instanceof Error ? error.message : String(error)}`);
    }
}
//# sourceMappingURL=git.js.map