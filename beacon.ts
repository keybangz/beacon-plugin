import type { Plugin } from "@opencode-ai/plugin";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { initLogger } from "./src/lib/logger.js";
import SearchTool from "./src/tools/search.js";
import IndexTool from "./src/tools/index.js";
import ReindexTool from "./src/tools/reindex.js";
import StatusTool from "./src/tools/status.js";
import ConfigTool from "./src/tools/config.js";
import BlacklistTool from "./src/tools/blacklist.js";
import WhitelistTool from "./src/tools/whitelist.js";
import PerformanceTool from "./src/tools/performance.js";
import TerminateIndexerTool from "./src/tools/terminate-indexer.js";
import DownloadModelTool from "./src/tools/download-model.js";
import { getBeaconRoot } from "./src/lib/repo-root.js";
import { loadConfig, invalidateConfigCache } from "./src/lib/config.js";
import { getOrCreateWatcher } from "./src/lib/watcher.js";
import type { FileWatcher } from "./src/lib/watcher.js";
import { getCoordinator, releaseCoordinator } from "./src/lib/pool.js";
import type { IndexProgress } from "./src/lib/sync.js";

// ESM-compatible __dirname substitute (works on Node 18+ and all Bun versions)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isNode = typeof process !== "undefined" && process.versions?.node;

function getConfigPath(worktree: string): string {
  if (isNode) {
    return path.join(worktree, ".opencode", "beacon.json");
  }
  return "";
}

function ensureUserConfig(worktree: string): {
  config: any | null;
  created: boolean;
} {
  if (!isNode) return { config: null, created: false };

  const configPath = getConfigPath(worktree);
  const configDir = path.dirname(configPath);

  // Read default config from dist
  let defaultConfig: any = null;
  try {
    const defaultConfigPath = path.join(
      __dirname,
      "..",
      "config",
      "beacon.default.json",
    );
    if (fs.existsSync(defaultConfigPath)) {
      defaultConfig = JSON.parse(fs.readFileSync(defaultConfigPath, "utf8"));
    }
  } catch (err) {
    // Silent fail — console prohibited
  }

  if (!defaultConfig) {
    // Fallback to hardcoded default
    defaultConfig = {
      embedding: {
        api_base: "local",
        model: "all-MiniLM-L6-v2",
        dimensions: 384,
        batch_size: 32,
        context_limit: 256,
        query_prefix: "",
        api_key_env: "",
        enabled: true,
      },
      chunking: {
        strategy: "hybrid",
        max_tokens: 512,
        overlap_tokens: 32,
      },
      indexing: {
        include: [
          "**/*.ts",
          "**/*.tsx",
          "**/*.js",
          "**/*.jsx",
          "**/*.py",
          "**/*.go",
          "**/*.rs",
          "**/*.java",
          "**/*.rb",
          "**/*.php",
          "**/*.sql",
          "**/*.md",
        ],
        exclude: [
          "node_modules/**",
          "dist/**",
          "build/**",
          ".next/**",
          "*.lock",
          "*.min.js",
          ".git/**",
          ".env*",
        ],
        max_file_size_kb: 500,
        auto_index: true,
        max_files: 10000,
        concurrency: 4,
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
          debug: false,
        },
      },
      storage: {
        path: ".opencode/.beacon",
      },
    };
  }

  if (fs.existsSync(configPath)) {
    try {
      const content = fs.readFileSync(configPath, "utf8");
      return { config: JSON.parse(content), created: false };
    } catch {
      return { config: null, created: false };
    }
  }

  try {
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }

    fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2));

    // Also create .beacon storage directory
    const beaconStorageDir = path.join(configDir, ".beacon");
    if (!fs.existsSync(beaconStorageDir)) {
      fs.mkdirSync(beaconStorageDir, { recursive: true });
    }

    return { config: defaultConfig, created: true };
  } catch (err) {
    return { config: null, created: false };
  }
}

function extractFilePath(args: any, toolName: string): string | null {
  if (!args) return null;
  if (toolName === "write_file" || toolName === "edit_file") {
    return args.file_path || args.path || args.file || null;
  }
  if (toolName === "str_replace_editor") {
    return args.path || args.file_path || null;
  }
  return null;
}

function extractDeletedFiles(command: string): string[] {
  const files: string[] = [];
  if (!command) return files;

  const rmPattern = /(?:^|\s)(?:rm|rmdir)\s+(?:-[rf]+\s+)?(.+)/g;
  let match;

  while ((match = rmPattern.exec(command)) !== null) {
    const args = match[1].trim();
    const parts = args.split(/[&&||;\s]+/);
    for (const part of parts) {
      const cleaned = part.replace(/^-[rf]+\s*/, "").trim();
      if (
        cleaned &&
        !cleaned.startsWith("-") &&
        !cleaned.match(/^[{}|$&<>`]/)
      ) {
        files.push(cleaned);
      }
    }
  }

  const gitRmPattern = /git\s+rm\s+(-[rf]+\s+)?(.+)/g;
  while ((match = gitRmPattern.exec(command)) !== null) {
    const args = match[2].trim();
    const parts = args.split(/[&&||;\s]+/);
    for (const part of parts) {
      const cleaned = part.replace(/^-[rf]+\s*/, "").trim();
      if (cleaned && !cleaned.startsWith("-")) {
        files.push(cleaned);
      }
    }
  }

  const gitMvPattern = /git\s+mv\s+(.+)/g;
  while ((match = gitMvPattern.exec(command)) !== null) {
    const args = match[1].trim();
    const parts = args.split(/[&&||;\s]+/);
    for (const part of parts) {
      if (part && !part.startsWith("-")) {
        files.push(part);
      }
    }
  }

  return [...new Set(files)];
}

function formatProgressMessage(progress: IndexProgress): string {
  const barLength = 20;
  const filled = Math.round((progress.percent / 100) * barLength);
  const bar = "█".repeat(filled) + "░".repeat(barLength - filled);

  const phaseEmoji: Record<string, string> = {
    discovering: "🔍",
    chunking: "📝",
    embedding: "🧠",
    storing: "💾",
    complete: "✅",
    error: "❌",
  };

  const emoji = phaseEmoji[progress.phase] || "📊";
  return `${emoji} **Beacon Indexing** [${bar}] ${progress.percent}%\n${progress.message}`;
}

function shouldShowProgress(
  progress: IndexProgress,
  lastMilestone: { percent: number; phase: string },
): boolean {
  if (progress.phase === "error" || progress.phase === "complete") return true;
  if (progress.phase !== lastMilestone.phase) return true;
  const milestones = [25, 50, 75, 100];
  for (const m of milestones) {
    if (progress.percent >= m && lastMilestone.percent < m) return true;
  }
  return false;
}

class InitMutex {
  private locked = false;
  private queue: Array<() => void> = [];

  async acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      if (!this.locked) {
        this.locked = true;
        resolve(() => this.release());
      } else {
        this.queue.push(() => {
          this.locked = true;
          resolve(() => this.release());
        });
      }
    });
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.locked = false;
    }
  }
}

const DEFAULT_BEACONIGNORE = `# Beacon ignore file
# Add glob patterns here to exclude files from indexing
# One pattern per line. Lines starting with # are comments.
#
# Examples:
# secret-dir/
# *.secret
# private/**

# Version control
.git/**
.svn/**
.hg/**
.bzr/**

# Package manager dependencies
node_modules/**
vendor/**
bower_components/**
__pypackages__/**
.pnp/**
.yarn/cache/**

# Python environments & caches
venv/**
.venv/**
env/**
__pycache__/**
.pytest_cache/**
.mypy_cache/**
.ruff_cache/**
.tox/**
*.egg-info/**
site-packages/**

# Build output
dist/**
build/**
out/**
output/**
target/**
bin/**
obj/**
.next/**
.nuxt/**
.svelte-kit/**
_site/**
public/build/**
.turbo/**
.vercel/**
.netlify/**

# Lock files
*.lock
package-lock.json
yarn.lock
pnpm-lock.yaml
Pipfile.lock
poetry.lock
Cargo.lock
go.sum
Gemfile.lock
composer.lock

# Logs
logs/**
*.log
`;

export const BeaconPlugin: Plugin = async ({ client, worktree }) => {
  // Wire the SDK client into the logger FIRST, before any module that uses log.
  initLogger(client);

  let repoRoot: string | null = null;
  let config: ReturnType<typeof loadConfig> | null = null;
  let fileWatcher: FileWatcher | null = null;
  let isInitialized = false;
  let hasAttemptedAutoIndex = false;
  const initMutex = new InitMutex();

  function isGitInitCommand(command: string): boolean {
    return command.includes("git init") && !command.includes("git reinit");
  }

  function isGrepCodeSearch(command: string): boolean {
    // Don't interfere with git grep
    if (command.includes("git grep")) return false;

    // Don't interfere with pipes to grep
    if (/\|\s*grep/.test(command)) return false;

    // Don't interfere with output redirection
    if (command.includes(">")) return false;

    // Check for explicit file extensions or context
    const hasFileExtension =
      /\.(ts|tsx|js|jsx|py|go|rs|java|rb|php|sql|md)$/m.test(command);
    const hasQueryNoFile = /^[^>]*grep\s+[^|]*['"][^'"]+['"][^|]*$/m.test(
      command,
    );

    // Avoid false positives for file operations
    if (command.includes("-l") && !hasFileExtension) {
      return false;
    }

    return hasFileExtension || hasQueryNoFile;
  }

  function extractGrepQuery(command: string): string | null {
    const match = command.match(/grep\s+(?:-[a-zA-Z]+\s+)*["']([^"']+)["']/);
    return match?.[1] || null;
  }

  async function executeGrepReplacement(query: string, pathPrefix?: string): Promise<string> {
    let pooled;
    try {
      pooled = await getCoordinator(worktree);
      const stats = pooled.db.getStats();

      if (stats.total_chunks === 0) {
        return JSON.stringify({
          error: "Index not found. Run 'reindex' tool to create the index.",
          matches: [],
        });
      }

      const queryEmbedding = await pooled.embedder.embedQuery(query);
      const results = pooled.db.search(
        queryEmbedding,
        10,
        0.01,
        query,
        pooled.config,
        pathPrefix,
        false
      );

      return JSON.stringify({
        query,
        mode: "grep-replacement",
        matches: results.map((r) => ({
          file: r.filePath,
          lines: `${r.startLine}-${r.endLine}`,
          similarity: r.similarity.toFixed(3),
          preview: r.chunkText.substring(0, 200),
        })),
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return JSON.stringify({
        error: `Grep replacement failed: ${errorMessage}`,
        matches: [],
      });
    } finally {
      if (pooled) {
        try {
          await releaseCoordinator(worktree);
        } catch (releaseError) {
          // Silent fail
        }
      }
    }
  }

  async function performAutoIndex(sessionID?: string, forceReindex: boolean = false): Promise<void> {
    if (!isInitialized || !config) return;
    if (!config.indexing.auto_index && !forceReindex) return;

    let pooled;
    try {
      pooled = await getCoordinator(worktree);
      const stats = pooled.db.getStats();

      // Skip if already indexed and not forcing reindex
      if (!forceReindex && stats.total_chunks > 0) {
        await releaseCoordinator(worktree);
        return;
      }

      const lastMilestone = { percent: 0, phase: "" };

      if (sessionID) {
        await pooled.coordinator.performFullIndex(async (progress) => {
          if (shouldShowProgress(progress, lastMilestone)) {
            lastMilestone.percent = progress.percent;
            lastMilestone.phase = progress.phase;
            if (progress.phase !== "complete" && progress.phase !== "error") {
              await client.session.prompt({
                path: { id: sessionID },
                body: {
                  noReply: true,
                  parts: [
                    {
                      type: "text",
                      text: formatProgressMessage(progress),
                      synthetic: true,
                    },
                  ],
                },
              });
            }
          }
        });

        await client.session.prompt({
          path: { id: sessionID },
          body: {
            noReply: true,
            parts: [
              {
                type: "text",
                text: "✅ **Beacon Indexing Complete**\nYour codebase is now indexed and ready for semantic search.",
                synthetic: true,
              },
            ],
          },
        });
      } else {
        // Silent indexing for plugin init
        await pooled.coordinator.performFullIndex();
      }
    } catch (error) {
      throw error; // Re-throw so callers can handle it
    } finally {
      if (pooled) {
        try {
          await releaseCoordinator(worktree);
        } catch (releaseError) {
          // Silent fail
        }
      }
    }
  }

  async function checkAndTriggerIndexing(sessionID?: string): Promise<void> {
    if (!isInitialized || !config) return;
    if (!config.indexing.auto_index) return;

    let pooled;
    try {
      pooled = await getCoordinator(worktree);
      const stats = pooled.db.getStats();
      
      // If no index exists, trigger indexing
      if (stats.total_chunks === 0) {
        await releaseCoordinator(worktree);
        pooled = null;
        await performAutoIndex(sessionID, true);
      }
    } catch (error) {
      // Silent fail
    } finally {
      if (pooled) {
        try {
          await releaseCoordinator(worktree);
        } catch (releaseError) {
          // Silent fail
        }
      }
    }
  }

  async function initializePlugin(): Promise<boolean> {
    if (isInitialized) return true;

    const release = await initMutex.acquire();
    try {
      if (isInitialized) {
        release();
        return true;
      }

      // Ensure config exists before trying to load it
      ensureUserConfig(worktree);

      const detectedRoot = getBeaconRoot(worktree);
      if (!detectedRoot) {
        release();
        return false;
      }

      repoRoot = detectedRoot;

      // AUTO-CREATE .beaconignore if it doesn't exist
      const beaconIgnorePath = path.join(repoRoot, ".beaconignore");
      if (!fs.existsSync(beaconIgnorePath)) {
        try {
          fs.writeFileSync(beaconIgnorePath, DEFAULT_BEACONIGNORE, "utf-8");
        } catch {
          // Non-fatal: user might not have write access
        }
      }

      config = loadConfig(repoRoot);
      fileWatcher = (await getOrCreateWatcher(repoRoot, config)) as FileWatcher;

      // Watch for .beaconignore changes and invalidate config cache
      let beaconIgnoreWatcher: ReturnType<typeof fs.watch> | null = null;
      try {
        beaconIgnoreWatcher = fs.watch(beaconIgnorePath, (eventType) => {
          if (eventType === "change" && repoRoot) {
            invalidateConfigCache(repoRoot);
            // Optionally trigger re-index
          }
        });
      } catch {
        // Non-fatal: watch might fail on some filesystems
      }

      fileWatcher.on("add", async (filePath: string) => {
        let pooled;
        try {
          pooled = await getCoordinator(worktree);
          await pooled.coordinator.reembedFile(filePath);
        } catch (error) {
          // Silent fail
        } finally {
          if (pooled) {
            try {
              await releaseCoordinator(worktree);
            } catch (releaseError) {
              // Silent fail
            }
          }
        }
      });

      fileWatcher.on("change", async (filePath: string) => {
        let pooled;
        try {
          pooled = await getCoordinator(worktree);
          await pooled.coordinator.reembedFile(filePath);
        } catch (error) {
          // Silent fail
        } finally {
          if (pooled) {
            try {
              await releaseCoordinator(worktree);
            } catch (releaseError) {
              // Silent fail
            }
          }
        }
      });

      fileWatcher.on("unlink", async (filePath: string) => {
        let pooled;
        try {
          pooled = await getCoordinator(worktree);
          pooled.db.deleteChunks(filePath);
          pooled.coordinator.garbageCollect();
        } catch (error) {
          // Silent fail
        } finally {
          if (pooled) {
            try {
              await releaseCoordinator(worktree);
            } catch (releaseError) {
              // Silent fail
            }
          }
        }
      });

      fileWatcher.on("error", (error: Error) => {
        // Silent fail
      });

      fileWatcher.start();
      isInitialized = true;

      // Perform auto-indexing on initialization if configured
      // FIX: set hasAttemptedAutoIndex to true AFTER performAutoIndex resolves, not before
      if (config.indexing.auto_index && !hasAttemptedAutoIndex) {
        // Run silently in background
        performAutoIndex().then(() => {
          hasAttemptedAutoIndex = true;
        }).catch(() => {
          hasAttemptedAutoIndex = true;
        });
      }

      return true;
    } catch (error) {
      return false;
    } finally {
      release();
    }
  }

  await initializePlugin();

  return {
    event: async ({ event }) => {
      if (event.type === "session.created") {
        const sessionID =
          (event as any).sessionID ??
          (event as any).properties?.sessionID ??
          (event as any).properties?.info?.id ??
          (event as any).id;
        if (!sessionID) return;

        if (!isInitialized) {
          const initialized = await initializePlugin();
          if (!initialized) return;
        }

        if (!hasAttemptedAutoIndex) {
          try {
            await performAutoIndex(sessionID);
          } catch (error) {
            // Silent fail
          }
          hasAttemptedAutoIndex = true;
        } else {
          // Check if indexing is needed and show status
          let pooled;
          try {
            pooled = await getCoordinator(worktree);
            const stats = pooled.db.getStats();

            if (stats.total_chunks === 0 && config?.indexing.auto_index) {
              await releaseCoordinator(worktree);
              pooled = null;
              try {
                await performAutoIndex(sessionID);
              } catch (error) {
                // Silent fail
              }
            }
          } finally {
            if (pooled) {
              try {
                await releaseCoordinator(worktree);
              } catch (releaseError) {
                // Silent fail
              }
            }
          }
        }
      }
    },

    tool: {
      grep: SearchTool,
      grepsearch: SearchTool,
      search: SearchTool,
      index: IndexTool,
      reindex: ReindexTool,
      status: StatusTool,
      config: ConfigTool,
      blacklist: BlacklistTool,
      whitelist: WhitelistTool,
      performance: PerformanceTool,
      terminateIndexer: TerminateIndexerTool,
      downloadModels: DownloadModelTool,
    },

    "tool.execute.before": async (input, output) => {
      const shellTools = ["bash", "shell"];
      if (!shellTools.includes(input.tool)) return;

      const command = output.args?.command || output.args?.cmd || "";
      if (!/\bgrep\b/.test(command) || !isGrepCodeSearch(command)) return;

      const query = extractGrepQuery(command);
      if (!query || query.length <= 2) return;

      const results = await executeGrepReplacement(query);
      const escapedResults = results.replace(/'/g, "'\\''");

      if (!output.args) {
        output.args = {};
      }

      if (typeof output.args.command === "string") {
        output.args.command = `echo '${escapedResults}'`;
      } else if (typeof output.args.cmd === "string") {
        output.args.cmd = `echo '${escapedResults}'`;
      } else {
        output.args.command = `echo '${escapedResults}'`;
      }
    },

    "tool.execute.after": async (input) => {
      const shellTools = ["bash", "shell"];

      if (shellTools.includes(input.tool)) {
        const command = input.args?.command || input.args?.cmd || "";

        if (isGitInitCommand(command)) {
          // Reset state to allow re-detection of git repo
          isInitialized = false;
          hasAttemptedAutoIndex = false;

          // Retry with exponential backoff
          const maxRetries = 5;
          for (let i = 0; i < maxRetries; i++) {
            await new Promise((resolve) => setTimeout(resolve, 100 * (i + 1)));
            const success = await initializePlugin();
            if (success) {
              // Immediately perform auto-indexing for the newly detected repo
              if (config?.indexing.auto_index) {
                try {
                  await performAutoIndex();
                } catch (error) {
                  // Silent fail
                }
              }
              break;
            }
          }
        }
      }

      if (!isInitialized) return;

      const fileTools = ["write_file", "edit_file", "str_replace_editor"];

      if (fileTools.includes(input.tool)) {
        const filePath = extractFilePath(input.args, input.tool);
        if (filePath) {
          let pooled;
          try {
            pooled = await getCoordinator(worktree);
            await pooled.coordinator.reembedFile(filePath);
          } catch (error) {
            // Silent fail
          } finally {
            if (pooled) {
              try {
                await releaseCoordinator(worktree);
              } catch (releaseError) {
                // Silent fail
              }
            }
          }
        }
      } else if (shellTools.includes(input.tool)) {
        const command = input.args?.command || input.args?.cmd || "";
        const deletedFiles = extractDeletedFiles(command);

        if (deletedFiles.length > 0) {
          let pooled;
          try {
            pooled = await getCoordinator(worktree);
            for (const filePath of deletedFiles) {
              await pooled.db.deleteChunks(filePath);
            }
            await pooled.coordinator.garbageCollect();
          } catch (error) {
            // Silent fail
          } finally {
            if (pooled) {
              try {
                await releaseCoordinator(worktree);
              } catch (releaseError) {
                // Silent fail
              }
            }
          }
        }
      }
    },

    "experimental.session.compacting": async (_input, output) => {
      if (!isInitialized) {
        output.context.push(`## Beacon Index Status
Not initialized - no git repository found
Run 'git init' to enable Beacon indexing.`);
        return;
      }

      let statusText = "Not indexed";
      let pooled;
      try {
        pooled = await getCoordinator(worktree);
        const stats = pooled.db.getStats();
        const syncProgress = pooled.db.getSyncProgress();

        if (stats.total_chunks > 0) {
          statusText = `Indexed (${stats.total_chunks} chunks, ${stats.files_indexed} files)`;
          if (syncProgress.sync_status === "in_progress") {
            const filesIndexed = syncProgress.files_indexed || 0;
            const totalFiles = syncProgress.total_files || 0;
            statusText = `Indexing in progress: ${filesIndexed}/${totalFiles} files`;
          }
        }
      } catch (error) {
        // Silent fail
      } finally {
        if (pooled) {
          try {
            await releaseCoordinator(worktree);
          } catch {}
        }
      }

      output.context.push(`## Beacon Index Status
${statusText}
The Beacon search capability is available via the 'search' tool.`);
    },

    "shell.env": async (_input, output) => {
      try {
        output.env.BEACON_HOME = worktree;
      } catch {}
    },
  };
};

export default BeaconPlugin;
