/**
 * Configuration management
 * Loads default config, merges with per-repo overrides
 */

import { readFileSync } from "fs";
import { existsSync, join } from "path";
import type { BeaconConfig, MergedConfig } from "./types.ts";
import { getRepoRoot } from "./repo-root.ts";

/**
 * Deep merge two objects recursively
 * @param target - Base configuration object
 * @param source - Override configuration object
 * @returns Merged configuration
 */
function deepMerge<T extends Record<string, unknown>>(
  target: T,
  source: Partial<T>
): T {
  const result: T = { ...target };

  for (const key in source) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      const sourceValue = source[key];
      const targetValue = result[key];

      // Recursively merge nested objects
      if (
        sourceValue !== null &&
        typeof sourceValue === "object" &&
        !Array.isArray(sourceValue) &&
        targetValue !== null &&
        typeof targetValue === "object" &&
        !Array.isArray(targetValue)
      ) {
        result[key] = deepMerge(
          targetValue as Record<string, unknown>,
          sourceValue as Record<string, unknown>
        ) as T[Extract<keyof T, string>];
      } else {
        result[key] = sourceValue as T[Extract<keyof T, string>];
      }
    }
  }

  return result;
}

/**
 * Load default configuration from package
 * @returns Default Beacon configuration
 */
function loadDefaultConfig(): BeaconConfig {
  const defaultConfigPath: string = join(
    import.meta.dirname ?? process.cwd(),
    "..",
    "..",
    "config",
    "beacon.default.json"
  );

  if (!existsSync(defaultConfigPath)) {
    throw new Error(`Default config not found at ${defaultConfigPath}`);
  }

  try {
    const content: string = readFileSync(defaultConfigPath, "utf-8");
    return JSON.parse(content) as BeaconConfig;
  } catch (error) {
    throw new Error(
      `Failed to parse default config: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Load per-repository configuration override
 * @param repoRoot - Repository root path
 * @returns Partial configuration override, or empty object if not found
 */
function loadRepoConfig(repoRoot: string): Partial<BeaconConfig> {
  const repoConfigPath: string = join(repoRoot, ".opencode", "beacon.json");

  if (!existsSync(repoConfigPath)) {
    return {};
  }

  try {
    const content: string = readFileSync(repoConfigPath, "utf-8");
    return JSON.parse(content) as Partial<BeaconConfig>;
  } catch (error) {
    throw new Error(
      `Failed to parse repo config at ${repoConfigPath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Load and merge Beacon configuration
 * Merges default config with per-repo overrides
 * @param repoRoot - Repository root path (optional, auto-detected if not provided)
 * @returns Complete merged configuration
 */
export function loadConfig(repoRoot?: string): MergedConfig {
  const root: string = repoRoot ?? getRepoRoot();
  const defaultConfig: BeaconConfig = loadDefaultConfig();
  const repoConfig: Partial<BeaconConfig> = loadRepoConfig(root);

  const mergedConfig: BeaconConfig = deepMerge(defaultConfig, repoConfig);

  return {
    ...mergedConfig,
    _merged: true,
  };
}

/**
 * Validate configuration has required fields
 * @param config - Configuration to validate
 * @throws Error if configuration is invalid
 */
export function validateConfig(config: unknown): asserts config is BeaconConfig {
  if (config === null || typeof config !== "object") {
    throw new Error("Configuration must be an object");
  }

  const cfg = config as Record<string, unknown>;

  // Validate required top-level keys
  const requiredKeys: Array<keyof BeaconConfig> = [
    "embedding",
    "chunking",
    "indexing",
    "search",
    "storage",
  ];

  for (const key of requiredKeys) {
    if (!(key in cfg)) {
      throw new Error(`Missing required config key: ${String(key)}`);
    }
  }

  // Validate embedding config
  const embedding = cfg.embedding as Record<string, unknown>;
  if (
    !embedding.api_base ||
    !embedding.model ||
    !embedding.dimensions ||
    !embedding.batch_size
  ) {
    throw new Error("Invalid embedding configuration");
  }

  // Validate storage config
  const storage = cfg.storage as Record<string, unknown>;
  if (!storage.path) {
    throw new Error("Invalid storage configuration");
  }
}
