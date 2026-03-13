/**
 * Beacon Config Tool for OpenCode
 * View and modify Beacon configuration

 */

import { tool } from "@opencode-ai/plugin";
import { getRepoRoot } from "../../src/lib/repo-root.ts";
import { loadConfig, validateConfig } from "../../src/lib/config.ts";
import { join } from "path";
import { readFileSync, writeFileSync, existsSync } from "fs";
import type { BeaconConfig } from "../../src/lib/types.ts";

/**
 * Set a nested value in an object using dot notation (e.g., "embedding.model")
 */
function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split(".");
  let current = obj;

  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (!(key in current) || typeof current[key] !== "object" || current[key] === null) {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }

  const lastKey = keys[keys.length - 1];
  current[lastKey] = value;
}

/**
 * Get a nested value from an object using dot notation
 */
function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const keys = path.split(".");
  let current: unknown = obj;

  for (const key of keys) {
    if (typeof current === "object" && current !== null) {
      current = (current as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }

  return current;
}

export default tool({
  description:
    "View and modify Beacon configuration settings (embedding model, search weights, etc.)",
  args: {
    action: tool.schema
      .enum(["view", "set"])
      .optional()
      .describe("Action: 'view' to display config, 'set' to modify"),
    key: tool.schema
      .string()
      .optional()
      .describe("Config key to view or modify (e.g., 'embedding.model')"),
    value: tool.schema
      .string()
      .optional()
      .describe("New value for the key"),
  },
  async execute(args: any, context: any): Promise<string> {
    try {
      const repoRoot = getRepoRoot(context.worktree);
      const configPath = join(repoRoot, ".opencode", "beacon.json");

      if (args.action === "set") {
        if (!args.key) {
          return JSON.stringify({
            error: "Key is required for 'set' action (e.g., 'embedding.model')",
          });
        }

        if (args.value === undefined) {
          return JSON.stringify({
            error: "Value is required for 'set' action",
          });
        }

        // Load existing config or create new one
        let configData: Record<string, unknown>;
        if (existsSync(configPath)) {
          const content = readFileSync(configPath, "utf-8");
          configData = JSON.parse(content);
        } else {
          configData = {};
        }

        // Get current value before update
        const oldValue = getNestedValue(configData, args.key);

        // Parse value if it looks like JSON
        let parsedValue: unknown = args.value;
        if (args.value === "true") {
          parsedValue = true;
        } else if (args.value === "false") {
          parsedValue = false;
        } else if (!isNaN(Number(args.value))) {
          parsedValue = Number(args.value);
        }

        // Set the value
        setNestedValue(configData, args.key, parsedValue);

        // Validate the updated config by merging with defaults
        try {
          const mergedConfig = {
            ...loadConfig(repoRoot),
            ...configData,
          };
          validateConfig(mergedConfig);
        } catch (validationError: unknown) {
          return JSON.stringify({
            error: `Configuration validation failed: ${validationError instanceof Error ? validationError.message : String(validationError)}`,
          });
        }

        // Write back to file
        writeFileSync(configPath, JSON.stringify(configData, null, 2), "utf-8");

        return JSON.stringify({
          status: "success",
          message: `Configuration updated: ${args.key}`,
          key: args.key,
          old_value: oldValue,
          new_value: parsedValue,
        });
      } else {
        // Default to view action
        let config: BeaconConfig;

        if (args.key) {
          // Load merged config for specific key query
          config = loadConfig(repoRoot);
          const value = getNestedValue(config as any, args.key);

          return JSON.stringify({
            status: "success",
            key: args.key,
            value,
          });
        } else {
          // View full config
          config = loadConfig(repoRoot);

          return JSON.stringify({
            status: "success",
            config: {
              embedding: config.embedding,
              chunking: config.chunking,
              indexing: config.indexing,
              search: config.search,
              storage: config.storage,
            },
          });
        }
      }
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return JSON.stringify({
        error: `Config operation failed: ${errorMessage}`,
      });
    }
  },
});
