/**
 * Safety checks and blacklist management
 * Prevents indexing of sensitive paths
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { getBeaconRoot } from "./repo-root.js";

/**
 * Default blacklist paths (sensitive directories / files).
 * Matching is substring-based: a path is blocked if it CONTAINS any of these strings.
 * Entries should be path segments, not globs.
 */
const DEFAULT_BLACKLIST = [
    // Version control internals
    "/.git/",
    "/.svn/",
    "/.hg/",
    "/.bzr/",
    // Secrets and credentials (always highest priority)
    "/.env", // matches .env, .env.local, .env.production, etc.
    ".pem",
    ".key",
    ".p12",
    ".pfx",
    "/secrets/",
    "/.secrets/",
    // Package manager dependencies
    "/node_modules/",
    "/vendor/",
    "/bower_components/",
    "/__pypackages__/",
    "/.pnp/",
    "/.yarn/cache/",
    // Python environments & caches
    "/venv/",
    "/.venv/",
    "/env/",
    "/__pycache__/",
    "/.pytest_cache/",
    "/.mypy_cache/",
    "/.ruff_cache/",
    "/.tox/",
    ".egg-info/",
    "/site-packages/",
    // Build output directories
    "/dist/",
    "/build/",
    "/out/",
    "/output/",
    "/target/",
    "/bin/",
    "/obj/",
    "/.next/",
    "/.nuxt/",
    "/.svelte-kit/",
    "/_site/",
    "/public/build/",
    "/.turbo/",
    "/.vercel/",
    "/.netlify/",
    // Compiled / minified / generated files
    ".min.js",
    ".min.css",
    ".map",
    ".pb.go",
    "_pb2.py",
    ".generated.ts",
    ".generated.js",
    // IDE and editor files
    "/.idea/",
    "/.vscode/",
    "/.vs/",
    // Cache and temp directories
    "/.cache/",
    "/tmp/",
    "/temp/",
    "/.temp/",
    "/.tmp/",
    // Test coverage output
    "/coverage/",
    "/.nyc_output/",
    "/htmlcov/",
    // Infrastructure / IaC state
    "/.terraform/",
    ".tfstate",
    // OpenCode own storage (never index our own data)
    "/.opencode/",
];

/**
 * Get current working directory blacklist
 * @returns Array of blacklisted paths
 * @throws Error if blacklist file exists but cannot be read/parsed
 */
function getBlacklist(): string[] {
    const repoRoot = getBeaconRoot();
    const blacklistPath = join(repoRoot, ".opencode", "blacklist.json");
    if (existsSync(blacklistPath)) {
        const content = readFileSync(blacklistPath, "utf-8");
        const data = JSON.parse(content);
        // blacklist.json is written as a plain JSON array by the blacklist tool.
        // Accept both a flat array (current format) and the legacy { paths: [...] } shape.
        if (Array.isArray(data)) {
            return [...DEFAULT_BLACKLIST, ...data];
        }
        else if (data && Array.isArray(data.paths)) {
            return [...DEFAULT_BLACKLIST, ...data.paths];
        }
    }
    return DEFAULT_BLACKLIST;
}

/**
 * Load user-configured whitelist from .opencode/whitelist.json.
 * A whitelisted path substring overrides any blacklist match.
 * @param repoRoot - Repository root path (optional)
 * @returns Array of whitelisted path substrings
 */
function getWhitelist(repoRoot?: string): string[] {
    try {
        const safeRoot = repoRoot || getBeaconRoot();
        const whitelistPath = join(safeRoot, ".opencode", "whitelist.json");
        if (existsSync(whitelistPath)) {
            const content = readFileSync(whitelistPath, "utf-8");
            const data = JSON.parse(content);
            if (Array.isArray(data)) {
                return data;
            }
        }
    }
    catch {
        // Silently fail, no whitelist entries
    }
    return [];
}

/**
 * Check if current working directory is blacklisted.
 * Uses isPathBlacklisted() so the same substring rules apply.
 * @returns True if current directory matches any blacklist pattern
 */
export function isCwdBlacklisted() {
    try {
        const cwd = process.cwd();
        return isPathBlacklisted(cwd);
    }
    catch {
        // If blacklist can't be read, assume CWD is not blacklisted
        return false;
    }
}

/**
 * Check if a path is blacklisted.
 * A path is blocked when it matches any blacklist entry AND does NOT match
 * any whitelist entry (whitelist overrides blacklist for user-approved paths).
 * @param path - Absolute path to check
 * @param blacklist - Array of blacklisted path substrings
 * @param whitelist - Array of whitelisted path substrings (overrides blacklist)
 * @returns True if path is blocked
 */
export function isPathBlacklisted(path: string, blacklist: string[] = getBlacklist(), whitelist: string[] = getWhitelist()): boolean {
    // Fast pass: whitelisted paths are always allowed
    for (const allowedPath of whitelist) {
        if (path.includes(allowedPath)) {
            return false;
        }
    }
    // Check blacklist
    for (const blacklistedPath of blacklist) {
        if (path.includes(blacklistedPath)) {
            return true;
        }
    }
    return false;
}

/**
 * Validate that a path is safe to index
 * @param path - Path to validate
 * @throws Error if path is blacklisted or dangerous
 */
export function validatePathSafety(path: string): void {
    // Check for path traversal attempts
    if (path.includes("..")) {
        throw new Error("Path traversal detected");
    }
    // Check blacklist — let filesystem errors from getBlacklist() propagate
    // (a missing/malformed blacklist.json should not silently pass all paths)
    if (isPathBlacklisted(path)) {
        throw new Error(`Path is blacklisted: ${path}`);
    }
}
