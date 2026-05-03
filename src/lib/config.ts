/**
 * Configuration management
 * Loads default config, merges with per-repo overrides
 */
import { existsSync as _existsSync, readFileSync as _readFileSync } from "fs";

// Internal adapter — holds real fs references captured at module-init time,
// before any mock.module('fs') can overwrite the registry.
// Exported as @internal for test injection only.
export const _fsAdapter = {
    existsSync: _existsSync,
    readFileSync: _readFileSync,
};
import { join } from "path";
import { homedir } from "os";
import { log } from "./logger.js";
import { getBeaconRoot } from "./repo-root.js";

/**
 * Parse .opencode/blacklist.json and convert its entries to glob patterns
 * suitable for indexing.exclude.
 *
 * The blacklist tool stores raw path substrings (e.g. "node_modules",
 * "/node_modules/", "src/secrets") that are used for substring matching in
 * safety.ts.  To make them effective during file discovery we normalise them
 * to double-star glob patterns: "<segment>/**".
 *
 * Conversion rules (applied in order):
 *   1. Strip a single leading "/" (safety.ts prefixes entries with "/")
 *   2. Strip a single trailing "/"
 *   3. Append "/**" so the pattern covers the directory and all children
 *
 * Extension-only entries (starting with ".") are kept as-is (e.g. ".pem").
 */
export function parseBlacklistAsGlobs(repoRoot: string): string[] {
    const safeRoot = repoRoot || getBeaconRoot();
    const blacklistPath = join(safeRoot, ".opencode", "blacklist.json");
    if (!_fsAdapter.existsSync(blacklistPath))
        return [];
    try {
        const raw = _fsAdapter.readFileSync(blacklistPath, "utf8");
        const data = JSON.parse(raw);
        const entries = Array.isArray(data)
            ? data
            : Array.isArray((data as any)?.paths)
                ? (data as any).paths
                : [];
        return entries
            .map((entry: string) => entry.trim())
            .filter(Boolean)
            .map((entry: string) => {
            // Extension-only entries — keep verbatim (e.g. ".pem", ".tfstate")
            if (entry.startsWith(".") && !entry.includes("/"))
                return entry;
            // Strip leading slash added by safety.ts convention
            let seg = entry.startsWith("/") ? entry.slice(1) : entry;
            // Strip trailing slash
            if (seg.endsWith("/"))
                seg = seg.slice(0, -1);
            // Already a glob pattern — keep verbatim
            if (seg.includes("*"))
                return seg;
            // Convert plain directory/file name to recursive glob
            return `**/${seg}/**`;
        });
    }
    catch (e) {
        log.warn("beacon", "Failed to parse .opencode/blacklist.json", { error: e instanceof Error ? e.message : String(e) });
        return [];
    }
}

/**
 * Parse .beaconignore file in the repo root, returning an array of patterns.
 * Comments (#) and blank lines are ignored.
 *
 * Pattern normalisation (applied in order):
 *  1. Trailing slash: append "**"  e.g. "node_modules/" becomes "node_modules/**"
 *  2. Bare name/path with no leading star or slash: prepend "**" + "/"
 *     so the pattern matches anywhere in the tree, not only at the repo root.
 *  3. Patterns already anchored with "/" at the start or already starting with
 *     "**" + "/" are kept as-is.
 *  4. Extension globs like "*.log" get "**" + "/" prepended too.
 */
export function parseBeaconIgnore(repoRoot: string): string[] {
    const safeRoot = repoRoot || getBeaconRoot();
    const ignorePath = join(safeRoot, ".beaconignore");
    if (!_fsAdapter.existsSync(ignorePath))
        return [];
    try {
        const lines = _fsAdapter.readFileSync(ignorePath, "utf8")
            .split("\n")
            .map(line => line.trim())
            .filter(line => line && !line.startsWith("#"));
        return lines.map(line => {
            // Step 1: trailing slash → append "**"
            if (line.endsWith("/"))
                line = line + "**";
            // Already properly anchored — keep verbatim
            if (line.startsWith("/") || line.startsWith("**/"))
                return line;
            // Bare name or relative path — make it match anywhere in the tree
            return `**/${line}`;
        });
    }
    catch (e) {
        log.warn("beacon", "Failed to parse .beaconignore", { error: e instanceof Error ? e.message : String(e) });
        return [];
    }
}

// Static placeholder — actual path is resolved lazily in loadConfig()
const DEFAULT_CONFIG = {
    embedding: {
        api_base: "local",
        model: "all-MiniLM-L6-v2",
        dimensions: 384,
        batch_size: 32,
        context_limit: 512,
        query_prefix: "",
        document_prefix: "",
        api_key_env: "",
        enabled: true,
        execution_provider: "cpu"
    },
    chunking: {
        strategy: "hybrid",
        max_tokens: 512,
        overlap_tokens: 32
    },
    indexing: {
        include: [
            // TypeScript / JavaScript
            "**/*.ts",
            "**/*.tsx",
            "**/*.js",
            "**/*.jsx",
            "**/*.mjs",
            "**/*.cjs",
            // Python
            "**/*.py",
            "**/*.pyi",
            // Go
            "**/*.go",
            // Rust
            "**/*.rs",
            // Java / JVM
            "**/*.java",
            "**/*.kt",
            "**/*.kts",
            "**/*.scala",
            "**/*.groovy",
            // C# / .NET
            "**/*.cs",
            "**/*.fs",
            "**/*.fsx",
            // C / C++
            "**/*.c",
            "**/*.cpp",
            "**/*.cc",
            "**/*.cxx",
            "**/*.h",
            "**/*.hpp",
            "**/*.hxx",
            // Web / Frontend
            "**/*.vue",
            "**/*.svelte",
            "**/*.astro",
            "**/*.html",
            "**/*.htm",
            "**/*.css",
            "**/*.scss",
            "**/*.sass",
            "**/*.less",
            // Ruby
            "**/*.rb",
            "**/*.rake",
            "**/*.erb",
            // PHP
            "**/*.php",
            "**/*.phtml",
            // Swift / Objective-C
            "**/*.swift",
            "**/*.m",
            "**/*.mm",
            // Dart / Flutter
            "**/*.dart",
            // Elixir / Erlang
            "**/*.ex",
            "**/*.exs",
            "**/*.erl",
            "**/*.hrl",
            // Haskell / F# / OCaml
            "**/*.hs",
            "**/*.lhs",
            "**/*.ml",
            "**/*.mli",
            // Lua
            "**/*.lua",
            // Shell / Scripts
            "**/*.sh",
            "**/*.bash",
            "**/*.zsh",
            "**/*.fish",
            "**/*.ps1",
            "**/*.psm1",
            // SQL
            "**/*.sql",
            // Config / Data formats
            "**/*.json",
            "**/*.jsonc",
            "**/*.yaml",
            "**/*.yml",
            "**/*.toml",
            "**/*.xml",
            // Documentation
            "**/*.md",
            "**/*.mdx",
            "**/*.rst",
            "**/*.txt",
            // Infrastructure
            "**/*.tf",
            "**/*.hcl",
            "**/*.dockerfile",
            "**/Dockerfile",
            "**/Makefile",
            "**/*.mk",
            "**/*.cmake",
            "**/CMakeLists.txt",
            // GraphQL / Prisma
            "**/*.graphql",
            "**/*.gql",
            "**/*.prisma",
            // Proto
            "**/*.proto",
        ],
        exclude: [
            // Version control
            ".git/**",
            ".svn/**",
            ".hg/**",
            ".bzr/**",
            // Package manager dependencies
            "node_modules/**",
            "vendor/**", // PHP (Composer), Go modules mirror, Ruby gems
            "bower_components/**",
            "__pypackages__/**", // PEP 582
            ".pnp/**", // Yarn PnP
            ".yarn/cache/**",
            // Python environments & caches
            "venv/**",
            ".venv/**",
            "env/**",
            ".env/**",
            "__pycache__/**",
            ".pytest_cache/**",
            ".mypy_cache/**",
            ".ruff_cache/**",
            ".tox/**",
            "*.egg-info/**",
            "site-packages/**",
            // Build output directories
            "dist/**",
            "build/**",
            "out/**",
            "output/**",
            "target/**", // Rust (cargo), Java (Maven), Scala (sbt)
            "bin/**",
            "obj/**", // .NET / C#
            ".next/**", // Next.js
            ".nuxt/**", // Nuxt.js
            ".svelte-kit/**", // SvelteKit
            "_site/**", // Jekyll / static site generators
            "public/build/**", // Remix, Phoenix
            ".turbo/**", // Turborepo cache
            ".vercel/**", // Vercel output
            ".netlify/**", // Netlify cache
            // Java / Android
            "*.class",
            "*.jar",
            "*.war",
            "*.aar",
            ".gradle/**",
            "gradle/**",
            // Compiled / minified / generated files
            "*.min.js",
            "*.min.css",
            "*.map", // source maps
            "*.pb.go", // protobuf generated Go
            "*_pb2.py", // protobuf generated Python
            "*.generated.ts",
            "*.generated.js",
            // Lock files (large, no semantic value)
            "*.lock",
            "package-lock.json",
            "yarn.lock",
            "pnpm-lock.yaml",
            "Pipfile.lock",
            "poetry.lock",
            "Cargo.lock",
            "go.sum",
            "Gemfile.lock",
            "composer.lock",
            // Secrets and environment files
            ".env",
            ".env.*",
            "*.pem",
            "*.key",
            "*.p12",
            "*.pfx",
            "secrets/**",
            ".secrets/**",
            // IDE and editor files
            ".idea/**",
            ".vscode/**",
            ".vs/**",
            "*.swp",
            "*.swo",
            ".project",
            ".classpath",
            // OS metadata
            ".DS_Store",
            "Thumbs.db",
            "desktop.ini",
            // Cache and temp directories
            ".cache/**",
            "tmp/**",
            "temp/**",
            ".temp/**",
            ".tmp/**",
            // Test coverage output
            "coverage/**",
            ".nyc_output/**",
            "htmlcov/**", // Python coverage.py
            ".coverage",
            // Logs
            "logs/**",
            "*.log",
            // Binary / media assets (no text value for code search)
            "*.png",
            "*.jpg",
            "*.jpeg",
            "*.gif",
            "*.ico",
            "*.svg",
            "*.webp",
            "*.woff",
            "*.woff2",
            "*.ttf",
            "*.eot",
            "*.otf",
            "*.mp4",
            "*.mp3",
            "*.webm",
            // Archives
            "*.zip",
            "*.tar",
            "*.gz",
            "*.tgz",
            "*.bz2",
            "*.7z",
            "*.rar",
            // Databases and data files
            "*.sqlite",
            "*.sqlite3",
            "*.db",
            // Infrastructure / IaC state
            ".terraform/**",
            "*.tfstate",
            "*.tfstate.backup",
            // OpenCode own storage (never index our own data)
            ".opencode/**",
            // C# / .NET build artifacts
            "*.dll",
            "*.exe",
            "*.pdb",
            "*.nupkg",
            "packages/**",   // NuGet packages
            // C / C++ build artifacts
            "*.o",
            "*.a",
            "*.so",
            "*.dylib",
            "CMakeFiles/**",
            "cmake-build-*/**",
            // Swift / Xcode
            "*.xcodeproj/**",
            "*.xcworkspace/**",
            "DerivedData/**",
            "Pods/**",           // CocoaPods
            ".build/**",         // Swift Package Manager
            // Kotlin / Android
            "*.apk",
            "*.aab",
            "*.dex",
            // Dart / Flutter
            ".dart_tool/**",
            ".flutter-plugins",
            ".flutter-plugins-dependencies",
            // Ruby
            ".bundle/**",
            // PHP
            "*.phar",
            // Elixir
            "_build/**",
            ".elixir_ls/**",
            "deps/**",           // Mix dependencies
            // Haskell
            ".stack-work/**",
            "dist-newstyle/**",
            // Rust additional
            "**/.cargo/registry/**",
            // Go additional
            "**/.gopath/**",
            // Generated / compiled assets
            "*.pyc",
            "*.pyo",
            "*.beam",            // Erlang/Elixir compiled
            "*.hi",              // Haskell interface files
            // Misc
            "storybook-static/**",
            ".storybook/public/**",
            "__snapshots__/**",  // Jest snapshots (usually auto-generated)
        ],
        max_file_size_kb: 500,
        auto_index: true,
        max_files: 10000,
        concurrency: 8
    },
    search: {
        top_k: 10,
        similarity_threshold: 0.35,
        hybrid: {
            enabled: true,
            weight_vector: 0.4,
            weight_bm25: 0.3,
            weight_rrf: 0.3,
            doc_penalty: 0.5,
            identifier_boost: 1.5,
            debug: false
        }
    },
    storage: {
        path: ".opencode/.beacon" // static placeholder; resolved lazily in loadConfig()
    }
};

/**
 * Deep merge two objects recursively
 * @param target - Base configuration object
 * @param source - Override configuration object
 * @returns Merged configuration
 */
/**
 * Top-level merge: deep-clones target via JSON round-trip, then delegates
 * nested object merging to deepMergeObjects (which union-merges arrays).
 * The JSON round-trip ensures the returned object is fully independent of
 * the input references.
 */
function deepMerge(target: any, source: any): any {
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
 * Helper to deep merge plain objects.
 *
 * Array fields are UNION-merged (deduped) so that a project-level config can
 * ADD patterns to `indexing.exclude` / `indexing.include` without wiping the
 * hardcoded defaults.  A project that sets:
 *   { "indexing": { "exclude": ["my-secrets/**"] } }
 * …gets the full default exclude list PLUS "my-secrets/**", not just the one
 * custom pattern.
 *
 * To replace an array entirely a project must supply every entry explicitly.
 */
function deepMergeObjects(target: any, source: any): any {
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
            else if (Array.isArray(sourceValue) && Array.isArray(targetValue)) {
                // Union-merge: keep all target entries, append any source entries not already present.
                result[key] = Array.from(new Set([...targetValue, ...sourceValue]));
            }
            else if (sourceValue !== undefined && sourceValue !== null) {
                result[key] = sourceValue;
            }
        }
    }
    return result;
}

/**
 * Load default configuration from embedded constant
 * @returns Default Beacon configuration
 */
function loadDefaultConfig() {
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

/**
 * Load per-repository configuration override
 * @param repoRoot - Repository root path
 * @returns Partial configuration override, or empty object if not found
 */
function loadRepoConfig(repoRoot: string) {
    const safeRoot = repoRoot || getBeaconRoot();
    const repoConfigPath = join(safeRoot, ".opencode", "beacon.json");
    if (!_fsAdapter.existsSync(repoConfigPath)) {
        return {};
    }
    try {
        const content = _fsAdapter.readFileSync(repoConfigPath, "utf-8");
        return JSON.parse(content);
    }
    catch (error) {
        throw new Error(`Failed to parse repo config at ${repoConfigPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
}

/**
 * Global user config path: ~/.config/beacon/config.json
 * This is the user-level default for settings that should apply across ALL projects,
 * most importantly the embedding model and execution provider. Project-level
 * .opencode/beacon.json overrides take precedence over this.
 */
export function getGlobalConfigPath(): string {
    // Respect XDG_CONFIG_HOME if set, otherwise use ~/.config
    const xdgConfigHome = process.env.XDG_CONFIG_HOME;
    const configBase = xdgConfigHome || join(homedir(), ".config");
    return join(configBase, "beacon", "config.json");
}

/**
 * Load the global user-level Beacon configuration.
 * @returns Partial configuration or empty object if not found.
 */
function loadGlobalConfig(): Partial<typeof DEFAULT_CONFIG> {
    const globalConfigPath = getGlobalConfigPath();
    if (!_fsAdapter.existsSync(globalConfigPath)) {
        return {};
    }
    try {
        const content = _fsAdapter.readFileSync(globalConfigPath, "utf-8");
        return JSON.parse(content);
    }
    catch (error) {
        log.warn("beacon", `Failed to parse global config at ${globalConfigPath}`, { error: error instanceof Error ? error.message : String(error) });
        return {};
    }
}

const configCache = new Map<string, { config: any; expiresAt: number }>();
const CONFIG_CACHE_TTL_MS = 5000; // 5 seconds

export function loadConfig(repoRoot?: string): any {
    // Use getBeaconRoot for correct fallback
    const root = repoRoot ?? getBeaconRoot();
    const now = Date.now();
    const cached = configCache.get(root);
    if (cached && now < cached.expiresAt) {
        return cached.config;
    }
    // Layer 1: hardcoded defaults
    const defaultConfig = loadDefaultConfig();
    // Layer 2: global user config (~/.config/beacon/config.json)
    const globalConfig = loadGlobalConfig();
    // Layer 3: per-project overrides (.opencode/beacon.json)
    const repoConfig = loadRepoConfig(root);
    // Merge in order: defaults ← global ← project
    const afterGlobal = deepMerge(defaultConfig, globalConfig);
    const mergedConfig = deepMerge(afterGlobal, repoConfig);
    // Lazily resolve the storage path unless a config layer provides a custom one.
    // Project config takes precedence; global config can also override; otherwise default.
    if (!repoConfig.storage?.path && !globalConfig.storage?.path) {
        mergedConfig.storage.path = join(root, ".opencode", ".beacon");
    }
    // Layer 4: .beaconignore patterns — user-editable file in repo root
    const ignorePatterns = parseBeaconIgnore(root);
    // Layer 5: .opencode/blacklist.json — patterns added via the blacklist tool
    const blacklistGlobs = parseBlacklistAsGlobs(root);
    const extraExcludes = [...ignorePatterns, ...blacklistGlobs];
    if (extraExcludes.length) {
        mergedConfig.indexing.exclude = Array.from(new Set([
            ...mergedConfig.indexing.exclude,
            ...extraExcludes,
        ]));
    }
    const result = {
        ...mergedConfig,
        _merged: true,
    };
    configCache.set(root, { config: result, expiresAt: now + CONFIG_CACHE_TTL_MS });
    return result;
}

/** Invalidate the cached config for a specific repo root (e.g., after config write). */
export function invalidateConfigCache(repoRoot: string): void {
    configCache.delete(repoRoot);
}

/**
 * Validate configuration has required fields
 * @param config - Configuration to validate
 * @throws Error if configuration is invalid
 */
export function validateConfig(config: any): void {
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
    if (embedding.api_base === undefined ||
        embedding.model === undefined ||
        embedding.dimensions === undefined ||
        embedding.batch_size === undefined) {
        throw new Error("Invalid embedding configuration");
    }
    // Validate that if embeddings are enabled, api_base and model must be set
    if (embedding.enabled !== false) {
        if (!embedding.api_base || !embedding.model) {
            throw new Error("api_base and model are required when embeddings are enabled");
        }
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
            log.warn("beacon", `chunking.max_tokens (${maxTokens}) exceeds embedding.context_limit (${contextLimit}). This may cause chunks to be truncated during embedding. Consider setting max_tokens <= context_limit or removing context_limit to use max_tokens.`);
        }
    }
}
