/**
 * Beacon Blacklist Tool for OpenCode
 * Manage directories excluded from indexing

 */

import { tool } from "@opencode-ai/plugin";
import { getRepoRoot } from "../src/lib/repo-root.js";
import { join } from "path";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";

const BLACKLIST_FILE = ".opencode/blacklist.json";

/**
 * Load blacklist from file
 */
function loadBlacklist(repoRoot: string): string[] {
  const blacklistPath = join(repoRoot, BLACKLIST_FILE);

  if (!existsSync(blacklistPath)) {
    return [];
  }

  try {
    const content = readFileSync(blacklistPath, "utf-8");
    const data = JSON.parse(content);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

/**
 * Save blacklist to file
 */
function saveBlacklist(repoRoot: string, patterns: string[]): void {
  const blacklistPath = join(repoRoot, BLACKLIST_FILE);
  const dir = join(repoRoot, ".opencode");

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(blacklistPath, JSON.stringify(patterns, null, 2), "utf-8");
}

export default tool({
  description:
    "Manage blacklist - prevent indexing of specific directories (e.g., secrets, vendor code)",
  args: {
    action: tool.schema
      .enum(["list", "add", "remove"])
      .optional()
      .describe("Action: 'list' to show current blacklist, 'add'/'remove' to modify"),
    path: tool.schema
      .string()
      .optional()
      .describe("Directory path to add or remove from blacklist"),
  },
  async execute(args: any, context: any): Promise<string> {
    try {
      const repoRoot = getRepoRoot(context.worktree);
      const action = args.action ?? "list";

      if (action === "list") {
        const patterns = loadBlacklist(repoRoot);

        return JSON.stringify({
          status: "success",
          action: "list",
          patterns,
          count: patterns.length,
        });
      } else if (action === "add") {
        if (!args.path) {
          return JSON.stringify({
            error: "Path is required for 'add' action",
          });
        }

        const patterns = loadBlacklist(repoRoot);

        if (patterns.includes(args.path)) {
          return JSON.stringify({
            status: "warning",
            message: "Pattern already exists in blacklist",
            pattern: args.path,
            patterns,
          });
        }

        patterns.push(args.path);
        patterns.sort();
        saveBlacklist(repoRoot, patterns);

        return JSON.stringify({
          status: "success",
          action: "add",
          message: "Pattern added to blacklist",
          pattern: args.path,
          patterns,
          count: patterns.length,
        });
      } else if (action === "remove") {
        if (!args.path) {
          return JSON.stringify({
            error: "Path is required for 'remove' action",
          });
        }

        const patterns = loadBlacklist(repoRoot);
        const initialCount = patterns.length;
        const filteredPatterns = patterns.filter((p) => p !== args.path);

        if (initialCount === filteredPatterns.length) {
          return JSON.stringify({
            status: "warning",
            message: "Pattern not found in blacklist",
            pattern: args.path,
            patterns: filteredPatterns,
          });
        }

        saveBlacklist(repoRoot, filteredPatterns);

        return JSON.stringify({
          status: "success",
          action: "remove",
          message: "Pattern removed from blacklist",
          pattern: args.path,
          patterns: filteredPatterns,
          count: filteredPatterns.length,
        });
      } else {
        return JSON.stringify({
          error: `Unknown action: ${action}`,
        });
      }
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return JSON.stringify({
        error: `Blacklist operation failed: ${errorMessage}`,
      });
    }
  },
});
