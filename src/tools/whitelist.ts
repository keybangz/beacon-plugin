import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import { getBeaconRoot } from "../lib/repo-root.js";
import { invalidateConfigCache } from "../lib/config.js";
import { join } from "path";
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "fs";

const WHITELIST_FILE = ".opencode/whitelist.json";

function loadWhitelist(repoRoot: string): string[] {
  const whitelistPath = join(repoRoot, WHITELIST_FILE);

  if (!existsSync(whitelistPath)) {
    return [];
  }

  try {
    const content = readFileSync(whitelistPath, "utf-8");
    const data = JSON.parse(content);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function saveWhitelist(repoRoot: string, patterns: string[]): void {
  const whitelistPath = join(repoRoot, WHITELIST_FILE);
  const dir = join(repoRoot, ".opencode");

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // Atomic write: write to a temp file then rename to prevent corruption on crash.
  const tmpPath = `${whitelistPath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(patterns, null, 2), "utf-8");
  renameSync(tmpPath, whitelistPath);
}

const _export: ToolDefinition = tool({
  description:
    "Manage whitelist - allow indexing in specific directories even if they match blacklist patterns",
  args: {
    action: tool.schema
      .enum(["list", "add", "remove"])
      .optional()
      .describe("Action: 'list' to show whitelist, 'add'/'remove' to modify"),
    path: tool.schema
      .string()
      .optional()
      .describe("Directory path to add or remove from whitelist"),
  },
  async execute(args: any, context: any): Promise<string> {
    try {
      const repoRoot = getBeaconRoot(context.worktree);
      const action = args.action ?? "list";

      if (action === "list") {
        const patterns = loadWhitelist(repoRoot);

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

        const patterns = loadWhitelist(repoRoot);

        if (patterns.includes(args.path)) {
          return JSON.stringify({
            status: "warning",
            message: "Pattern already exists in whitelist",
            pattern: args.path,
            patterns,
          });
        }

        patterns.push(args.path);
        patterns.sort();
        saveWhitelist(repoRoot, patterns);
        invalidateConfigCache(repoRoot);

        return JSON.stringify({
          status: "success",
          action: "add",
          message: "Pattern added to whitelist",
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

        const patterns = loadWhitelist(repoRoot);
        const initialCount = patterns.length;
        const filteredPatterns = patterns.filter((p) => p !== args.path);

        if (initialCount === filteredPatterns.length) {
          return JSON.stringify({
            status: "warning",
            message: "Pattern not found in whitelist",
            pattern: args.path,
            patterns: filteredPatterns,
          });
        }

        saveWhitelist(repoRoot, filteredPatterns);
        invalidateConfigCache(repoRoot);

        return JSON.stringify({
          status: "success",
          action: "remove",
          message: "Pattern removed from whitelist",
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
        error: `Whitelist operation failed: ${errorMessage}`,
      });
    }
  },
});
export default _export;
