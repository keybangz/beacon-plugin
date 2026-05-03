import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import { getBeaconRoot } from "../lib/repo-root.js";
import { loadConfig, validateConfig, getGlobalConfigPath, invalidateConfigCache } from "../lib/config.js";
import { join, dirname } from "path";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import type { BeaconConfig } from "../lib/types.js";

/**
 * Deep merge two objects. Values in `override` overwrite those in `base`
 * recursively for plain objects; all other types are replaced directly.
 */
function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const key of Object.keys(override)) {
    const baseVal = base[key];
    const overrideVal = override[key];
    if (
      typeof overrideVal === "object" && overrideVal !== null && !Array.isArray(overrideVal) &&
      typeof baseVal === "object" && baseVal !== null && !Array.isArray(baseVal)
    ) {
      result[key] = deepMerge(baseVal as Record<string, unknown>, overrideVal as Record<string, unknown>);
    } else {
      result[key] = overrideVal;
    }
  }
  return result;
}

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

const _export: ToolDefinition = tool({
  description:
    "View and modify Beacon configuration settings (embedding model, search weights, etc.). " +
    "Use scope='global' to set user-wide defaults (stored in ~/.config/beacon/config.json) " +
    "or scope='project' (default) for per-project overrides (.opencode/beacon.json). " +
    "Use action='reset' to delete a broken or outdated config file and restore defaults.",
  args: {
    action: tool.schema
      .enum(["view", "set", "reset"])
      .optional()
      .describe("Action: 'view' to display config, 'set' to modify a key, 'reset' to delete the config file and restore defaults"),
    key: tool.schema
      .string()
      .optional()
      .describe("Config key to view or modify (e.g., 'embedding.model', 'embedding.execution_provider')"),
    value: tool.schema
      .string()
      .optional()
      .describe("New value for the key"),
    scope: tool.schema
      .enum(["project", "global"])
      .optional()
      .describe(
        "'project' (default) writes to .opencode/beacon.json in the repo root. " +
        "'global' writes to ~/.config/beacon/config.json and applies to all projects that don't override it."
      ),
  },
  async execute(args: any, context: any): Promise<string> {
    try {
      const repoRoot = getBeaconRoot(context.worktree);
      const globalConfigPath = getGlobalConfigPath();
      const projectConfigPath = join(repoRoot, ".opencode", "beacon.json");

      // Determine which config file to write to for 'set' actions
      const scope: "project" | "global" = args.scope === "global" ? "global" : "project";
      const targetConfigPath = scope === "global" ? globalConfigPath : projectConfigPath;

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
        if (existsSync(targetConfigPath)) {
          const content = readFileSync(targetConfigPath, "utf-8");
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
        } else if (args.value === "null") {
          parsedValue = null;
        } else if (args.value.length > 0 && !isNaN(Number(args.value)) && isFinite(Number(args.value))) {
          parsedValue = Number(args.value);
        } else if (args.value.startsWith("[") || args.value.startsWith("{")) {
          try {
            parsedValue = JSON.parse(args.value);
          } catch {
            // Keep as string if JSON parse fails
          }
        }

        // Set the value
        setNestedValue(configData, args.key, parsedValue);

        // Validate the updated config by merging with defaults
        try {
          const mergedConfig = deepMerge(
            loadConfig(repoRoot) as unknown as Record<string, unknown>,
            configData
          );
          validateConfig(mergedConfig);
        } catch (validationError: unknown) {
          return JSON.stringify({
            error: `Configuration validation failed: ${validationError instanceof Error ? validationError.message : String(validationError)}`,
          });
        }

        // Ensure target directory exists (especially for global config)
        mkdirSync(dirname(targetConfigPath), { recursive: true });

        // Write back to file
        writeFileSync(targetConfigPath, JSON.stringify(configData, null, 2), "utf-8");

        // Invalidate the config cache so the next call picks up the change
        invalidateConfigCache(repoRoot);

        return JSON.stringify({
          status: "success",
          message: `Configuration updated: ${args.key}`,
          scope,
          config_file: targetConfigPath,
          key: args.key,
          old_value: oldValue,
          new_value: parsedValue,
        });
      } else if (args.action === "reset") {
        // Determine which config file to reset
        const { unlinkSync, existsSync: fsExistsSync } = await import("fs");
        const resetPath = scope === "global" ? globalConfigPath : projectConfigPath;
        const scopeLabel = scope === "global" ? "global" : "project";

        if (!fsExistsSync(resetPath)) {
          return JSON.stringify({
            status: "success",
            message: `No ${scopeLabel} config file found — already using defaults.`,
            scope,
            config_file: resetPath,
          });
        }

        // Read the current config before deleting (for the diff in the response)
        let previousConfig: Record<string, unknown> = {};
        try {
          previousConfig = JSON.parse(readFileSync(resetPath, "utf-8"));
        } catch {
          // If we can't read it, it's likely corrupt — still delete it
        }

        unlinkSync(resetPath);
        invalidateConfigCache(repoRoot);

        return JSON.stringify({
          status: "success",
          message: `${scopeLabel.charAt(0).toUpperCase() + scopeLabel.slice(1)} config reset to defaults. The file has been deleted.`,
          scope,
          config_file: resetPath,
          previous_config: previousConfig,
          note: "Run 'view' to see the active defaults now in effect.",
        });
      } else {
        // Default to view action
        let config: BeaconConfig;

        if (args.key) {
          config = loadConfig(repoRoot);
          const value = getNestedValue(config as any, args.key);

          return JSON.stringify({
            status: "success",
            key: args.key,
            value,
          });
        } else {
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
            config_files: {
              global: globalConfigPath,
              project: projectConfigPath,
              global_exists: existsSync(globalConfigPath),
              project_exists: existsSync(projectConfigPath),
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
export default _export;
