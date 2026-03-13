/**
 * Configuration management
 * Loads default config, merges with per-repo overrides
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import type { BeaconConfig, MergedConfig } from "./types.js";
import { getRepoRoot } from "./repo-root.js";

/**
 * Deep merge two objects recursively
 * @param target - Base configuration object
 * @param source - Override configuration object
 * @returns Merged configuration
 */
function deepMerge(
  target: BeaconConfig,
  source: Partial<BeaconConfig>
): BeaconConfig {
  const result = JSON.parse(JSON.stringify(target)) as BeaconConfig;

  for (const key in source) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      const sourceValue = source[key as keyof BeaconConfig];
      const targetValue = result[key as keyof BeaconConfig];

      // Recursively merge nested objects
      if (
        sourceValue !== null &&
        typeof sourceValue === "object" &&
        !Array.isArray(sourceValue) &&
        targetValue !== null &&
        typeof targetValue === "object" &&
        !Array.isArray(targetValue)
      ) {
        (result[key as keyof BeaconConfig] as unknown) = deepMergeObjects(
          targetValue as unknown as Record<string, unknown>,
          sourceValue as unknown as Record<string, unknown>
        );
      } else if (sourceValue !== undefined && sourceValue !== null) {
        (result[key as keyof BeaconConfig] as unknown) = sourceValue;
      }
    }
  }

  return result;
}

/**
 * Helper to deep merge plain objects
 */
function deepMergeObjects(
  target: Record<string, unknown>,
  source: Record<string, unknown>
): Record<string, unknown> {
  const result = { ...target };

  for (const key in source) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      const sourceValue = source[key];
      const targetValue = result[key];

      if (
        sourceValue !== null &&
        typeof sourceValue === "object" &&
        !Array.isArray(sourceValue) &&
        targetValue !== null &&
        typeof targetValue === "object" &&
        !Array.isArray(targetValue)
      ) {
        result[key] = deepMergeObjects(
          targetValue as Record<string, unknown>,
          sourceValue as Record<string, unknown>
        );
      } else if (sourceValue !== undefined && sourceValue !== null) {
        result[key] = sourceValue;
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
