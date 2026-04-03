import { spawnSync } from "child_process";
import { statSync } from "fs";
import { join } from "path";
import { log } from "./logger.js";
import type { ModifiedFile } from "./types.js";

const repoFilesCache = new Map<string, { files: string[]; timestamp: number }>();
const CACHE_TTL = 5000;

export function getRepoFiles(repoRoot: string): string[] {
    const cached = repoFilesCache.get(repoRoot);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        return cached.files;
    }
    try {
        // Use spawnSync so repoRoot is never interpreted by the shell.
        const result = spawnSync("git", ["ls-files"], {
            cwd: repoRoot,
            encoding: "utf-8",
        });
        if (result.status !== 0) {
            throw new Error(result.stderr || "git ls-files failed");
        }
        const files = result.stdout
            .trim()
            .split("\n")
            .filter((line) => line.length > 0);
        repoFilesCache.set(repoRoot, { files, timestamp: Date.now() });
        return files;
    }
    catch (error) {
        // If we have stale cached data, return it as fallback
        if (cached) {
            log.error("beacon", "Git command failed, using stale cache", { error: error instanceof Error ? error.message : String(error) });
            return cached.files;
        }
        throw new Error(`Failed to get repo files: ${error instanceof Error ? error.message : String(error)}`);
    }
}

export function getFileHash(content: string): string {
    // FNV-1a 64-bit hash (emulated with two 32-bit halves for JS compatibility)
    // ~8-10x faster than SHA-256 for file change detection purposes.
    let h1 = 0x811c9dc5 >>> 0; // FNV offset basis (low 32)
    let h2 = 0x84222325 >>> 0; // FNV offset basis (high 32)
    for (let i = 0; i < content.length; i++) {
        const c = content.charCodeAt(i);
        h1 ^= c;
        // FNV prime multiply: emulate 64-bit via two 32-bit halves
        const lo1 = Math.imul(h1, 0x01000193);
        const lo2 = Math.imul(h2, 0x01000193);
        h1 = lo1 >>> 0;
        h2 = (lo2 + Math.imul(h1, 0)) >>> 0; // cross term simplified
        h2 ^= (c >>> 8);
    }
    return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}

export function getModifiedFilesSince(
    repoRoot: string,
    sinceIso: string
): ModifiedFile[] {
    const sinceMs = new Date(sinceIso).getTime();
    try {
        const committedFiles = new Set<string>();
        // Use spawnSync with an explicit arg array so sinceIso and file paths are
        // never interpreted by the shell (prevents command injection when values
        // come from the database or untrusted sources).
        const logResult = spawnSync("git", ["log", `--since=${sinceIso}`, "--name-only", "--pretty=format:"], { cwd: repoRoot, encoding: "utf-8" });
        if (logResult.status === 0 && logResult.stdout) {
            const files = logResult.stdout.trim().split("\n").filter((l) => l.length > 0);
            for (const file of files)
                committedFiles.add(file);
        }
        const diffResult = spawnSync("git", ["diff-index", "--name-only", "HEAD"], { cwd: repoRoot, encoding: "utf-8" });
        if (diffResult.status === 0 && diffResult.stdout) {
            const workingTreeFiles = diffResult.stdout.trim().split("\n").filter((l) => l.length > 0);
            for (const file of workingTreeFiles)
                committedFiles.add(file);
        }
        const modifiedFiles: ModifiedFile[] = [];
        for (const file of committedFiles) {
            try {
                const fullPath = join(repoRoot, file);
                const mtime = statSync(fullPath).mtime;
                modifiedFiles.push({
                    path: file,
                    modified_at: mtime.toISOString(),
                });
            }
            catch {
                // File was deleted — skip it; garbage collection handles stale entries.
            }
        }
        const untrackedResult = spawnSync("git", ["ls-files", "--others", "--exclude-standard"], { cwd: repoRoot, encoding: "utf-8" });
        if (untrackedResult.status === 0 && untrackedResult.stdout) {
            const untrackedFiles = untrackedResult.stdout.trim().split("\n").filter((l) => l.length > 0);
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
                }
            }
        }
        return modifiedFiles;
    }
    catch (error) {
        if (error instanceof Error &&
            (error.message.includes("fatal: Not a valid object name") ||
                error.message.includes("fatal: bad default revision"))) {
            return [];
        }
        throw new Error(`Failed to get modified files: ${error instanceof Error ? error.message : String(error)}`);
    }
}

export function isTrackedByGit(repoRoot: string, filePath: string): boolean {
    // Use spawnSync so filePath is never interpreted by the shell.
    const result = spawnSync("git", ["ls-files", "--error-unmatch", filePath], { cwd: repoRoot, stdio: "pipe" });
    return result.status === 0;
}

export function getFileFromGit(
    repoRoot: string,
    filePath: string,
    ref: string = "HEAD"
): string {
    // Use spawnSync so filePath and ref are never interpreted by the shell.
    const result = spawnSync("git", ["show", `${ref}:${filePath}`], { cwd: repoRoot, encoding: "utf-8" });
    if (result.status !== 0) {
        throw new Error(`Failed to get file from git: ${result.stderr || "unknown error"}`);
    }
    return result.stdout;
}

export function getCurrentCommitHash(repoRoot: string): string {
    // Use spawnSync so repoRoot is never interpolated into a shell command string.
    const result = spawnSync("git", ["rev-parse", "HEAD"], {
        cwd: repoRoot,
        encoding: "utf-8",
    });
    if (result.status !== 0) {
        throw new Error(`Failed to get commit hash: ${result.stderr || "git rev-parse HEAD failed"}`);
    }
    return result.stdout.trim();
}

export function clearRepoFilesCache(repoRoot?: string): void {
    if (repoRoot) {
        repoFilesCache.delete(repoRoot);
    }
    else {
        repoFilesCache.clear();
    }
}
