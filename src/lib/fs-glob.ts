import fg from "fast-glob";
import { log } from "./logger.js";

// Enumerates all files based on config.include and config.exclude (FS-based, git-optional)
export function getAllFilesViaGlob(repoRoot: string, include: string[], exclude: string[] = []): string[] {
    // fast-glob supports negation patterns natively; pass them as part of `patterns`
    // so the pattern array alone drives all filtering. Passing exclude separately via
    // the `ignore` option would apply it twice, wasting work and potentially causing
    // unexpected results with complex glob patterns.
    const patterns = [...include, ...exclude.map((e) => `!${e}`)];
    try {
        const files = fg.sync(patterns, {
            cwd: repoRoot,
            absolute: false,
            dot: true, // Include dotfiles if specified in pattern
            onlyFiles: true,
            unique: true,
            suppressErrors: true,
            followSymbolicLinks: false,
        });
        return files;
    }
    catch (err) {
        log.error("beacon", "FS glob failed", { error: err instanceof Error ? err.message : String(err) });
        return [];
    }
}
