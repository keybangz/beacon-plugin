/**
 * Configuration management
 * Loads default config, merges with per-repo overrides
 */
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { getRepoRoot } from "./repo-root.js";
/**
 * Deep merge two objects recursively
 * @param target - Base configuration object
 * @param source - Override configuration object
 * @returns Merged configuration
 */
function deepMerge(target, source) {
    const result = JSON.parse(JSON.stringify(target));
    for (const key in source) {
        if (Object.prototype.hasOwnProperty.call(source, key)) {
            const sourceValue = source[key];
            const targetValue = result[key];
            // Recursively merge nested objects
            if (sourceValue !== null &&
                typeof sourceValue === "object" &&
                !Array.isArray(sourceValue) &&
                targetValue !== null &&
                typeof targetValue === "object" &&
                !Array.isArray(targetValue)) {
                result[key] = deepMergeObjects(targetValue, sourceValue);
            }
            else if (sourceValue !== undefined && sourceValue !== null) {
                result[key] = sourceValue;
            }
        }
    }
    return result;
}
/**
 * Helper to deep merge plain objects
 */
function deepMergeObjects(target, source) {
    const result = { ...target };
    for (const key in source) {
        if (Object.prototype.hasOwnProperty.call(source, key)) {
            const sourceValue = source[key];
            const targetValue = result[key];
            if (sourceValue !== null &&
                typeof sourceValue === "object" &&
                !Array.isArray(sourceValue) &&
                targetValue !== null &&
                typeof targetValue === "object" &&
                !Array.isArray(targetValue)) {
                result[key] = deepMergeObjects(targetValue, sourceValue);
            }
            else if (sourceValue !== undefined && sourceValue !== null) {
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
function loadDefaultConfig() {
    // Get repo root first to build absolute path to config
    const repoRoot = getRepoRoot();
    const defaultConfigPath = join(repoRoot, "config", "beacon.default.json");
    if (!existsSync(defaultConfigPath)) {
        throw new Error(`Default config not found at ${defaultConfigPath}`);
    }
    try {
        const content = readFileSync(defaultConfigPath, "utf-8");
        return JSON.parse(content);
    }
    catch (error) {
        throw new Error(`Failed to parse default config: ${error instanceof Error ? error.message : String(error)}`);
    }
}
/**
 * Load per-repository configuration override
 * @param repoRoot - Repository root path
 * @returns Partial configuration override, or empty object if not found
 */
function loadRepoConfig(repoRoot) {
    const repoConfigPath = join(repoRoot, ".opencode", "beacon.json");
    if (!existsSync(repoConfigPath)) {
        return {};
    }
    try {
        const content = readFileSync(repoConfigPath, "utf-8");
        return JSON.parse(content);
    }
    catch (error) {
        throw new Error(`Failed to parse repo config at ${repoConfigPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
}
/**
 * Load and merge Beacon configuration
 * Merges default config with per-repo overrides
 * @param repoRoot - Repository root path (optional, auto-detected if not provided)
 * @returns Complete merged configuration
 */
export function loadConfig(repoRoot) {
    const root = repoRoot ?? getRepoRoot();
    const defaultConfig = loadDefaultConfig();
    const repoConfig = loadRepoConfig(root);
    const mergedConfig = deepMerge(defaultConfig, repoConfig);
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
export function validateConfig(config) {
    if (config === null || typeof config !== "object") {
        throw new Error("Configuration must be an object");
    }
    const cfg = config;
    // Validate required top-level keys
    const requiredKeys = [
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
    const embedding = cfg.embedding;
    if (!embedding.api_base ||
        !embedding.model ||
        !embedding.dimensions ||
        !embedding.batch_size) {
        throw new Error("Invalid embedding configuration");
    }
    // Validate storage config
    const storage = cfg.storage;
    if (!storage.path) {
        throw new Error("Invalid storage configuration");
    }
    // Validate chunking vs embedding context limits
    const chunking = cfg.chunking;
    const contextLimit = embedding.context_limit;
    const maxTokens = chunking.max_tokens;
    if (contextLimit !== undefined && maxTokens !== undefined) {
        if (maxTokens > contextLimit) {
            console.warn(`⚠️  Warning: chunking.max_tokens (${maxTokens}) exceeds embedding.context_limit (${contextLimit}). ` +
                `This may cause chunks to be truncated during embedding. ` +
                `Consider setting max_tokens <= context_limit or removing context_limit to use max_tokens.`);
        }
    }
}
//# sourceMappingURL=config.js.map