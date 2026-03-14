import { execSync } from "child_process";
import { createHash } from "crypto";
import { statSync } from "fs";
import { join } from "path";
const repoFilesCache = new Map();
const CACHE_TTL = 5000;
export function getRepoFiles(repoRoot) {
    const cached = repoFilesCache.get(repoRoot);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        return cached.files;
    }
    try {
        const result = execSync("git ls-files", {
            cwd: repoRoot,
            encoding: "utf-8",
        });
        const files = result
            .trim()
            .split("\n")
            .filter((line) => line.length > 0);
        repoFilesCache.set(repoRoot, { files, timestamp: Date.now() });
        return files;
    }
    catch (error) {
        throw new Error(`Failed to get repo files: ${error instanceof Error ? error.message : String(error)}`);
    }
}
export function getFileHash(content) {
    return createHash("sha256").update(content, "utf-8").digest("hex");
}
export function getModifiedFilesSince(repoRoot, sinceIso) {
    const sinceMs = new Date(sinceIso).getTime();
    try {
        const committedFiles = new Set();
        const logResult = execSync(`git log --since="${sinceIso}" --name-only --pretty=format:""`, { cwd: repoRoot, encoding: "utf-8" });
        const files = logResult.trim().split("\n").filter((l) => l.length > 0);
        for (const file of files)
            committedFiles.add(file);
        const diffResult = execSync("git diff-index --name-only HEAD", { cwd: repoRoot, encoding: "utf-8" });
        const workingTreeFiles = diffResult.trim().split("\n").filter((l) => l.length > 0);
        for (const file of workingTreeFiles)
            committedFiles.add(file);
        const modifiedFiles = [];
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
            }
        }
        const untrackedResult = execSync("git ls-files --others --exclude-standard", { cwd: repoRoot, encoding: "utf-8" });
        const untrackedFiles = untrackedResult.trim().split("\n").filter((l) => l.length > 0);
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
export function clearRepoFilesCache() {
    repoFilesCache.clear();
}
//# sourceMappingURL=git.js.map