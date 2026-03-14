import type { ModifiedFile } from "./types.js";
export declare function getRepoFiles(repoRoot: string): string[];
export declare function getFileHash(content: string): string;
export declare function getModifiedFilesSince(repoRoot: string, sinceIso: string): ModifiedFile[];
export declare function isTrackedByGit(repoRoot: string, filePath: string): boolean;
export declare function getFileFromGit(repoRoot: string, filePath: string, ref?: string): string;
export declare function getCurrentCommitHash(repoRoot: string): string;
export declare function clearRepoFilesCache(): void;
//# sourceMappingURL=git.d.ts.map