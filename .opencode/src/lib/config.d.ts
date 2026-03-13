/**
 * Configuration management
 * Loads default config, merges with per-repo overrides
 */
import type { BeaconConfig, MergedConfig } from "./types.js";
/**
 * Load and merge Beacon configuration
 * Merges default config with per-repo overrides
 * @param repoRoot - Repository root path (optional, auto-detected if not provided)
 * @returns Complete merged configuration
 */
export declare function loadConfig(repoRoot?: string): MergedConfig;
/**
 * Validate configuration has required fields
 * @param config - Configuration to validate
 * @throws Error if configuration is invalid
 */
export declare function validateConfig(config: unknown): asserts config is BeaconConfig;
//# sourceMappingURL=config.d.ts.map