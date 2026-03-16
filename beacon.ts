import type { Plugin } from "@opencode-ai/plugin";
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
import { findRepoRoot } from "./src/lib/repo-root.js";
import { loadConfig } from "./src/lib/config.js";
import { getOrCreateWatcher } from "./src/lib/watcher.js";
import type { FileWatcher } from "./src/lib/watcher.js";
import { getCoordinator, releaseCoordinator } from "./src/lib/pool.js";
import type { IndexProgress } from "./src/lib/sync.js";

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

export const BeaconPlugin: Plugin = async ({ client, worktree }) => {
  let repoRoot: string | null = null;
  let config: ReturnType<typeof loadConfig> | null = null;
  let fileWatcher: FileWatcher | null = null;
  let isInitialized = false;
  let hasAttemptedAutoIndex = false;

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
    const hasFileExtension = /\.(ts|tsx|js|jsx|py|go|rs|java|rb|php|sql|md)$/m.test(command);
    const hasQueryNoFile = /^[^>]*grep\s+[^|]*['"][^'"]+['"][^|]*$/m.test(command);
    
    // Avoid false positives for file operations
    if (command.includes("-l") && !hasFileExtension) {
      // List-only mode, likely checking for existence
      return false;
    }
    
    return hasFileExtension || hasQueryNoFile;
  }

  function extractGrepQuery(command: string): string | null {
    const match = command.match(/grep\s+(?:-[a-zA-Z]+\s+)*["']([^"']+)["']/);
    return match?.[1] || null;
  }

  async function performAutoIndex(sessionID?: string): Promise<void> {
    if (!isInitialized || !config) return;
    if (!config.indexing.auto_index) return;
    
    const pooled = await getCoordinator(worktree);
    const stats = pooled.db.getStats();
    
    if (stats.total_chunks > 0) {
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
                    ignored: true,
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
              ignored: true,
            },
          ],
        },
      });
    } else {
      // Silent indexing for plugin init
      await pooled.coordinator.performFullIndex();
    }
    
    await releaseCoordinator(worktree);
  }

  async function initializePlugin(): Promise<boolean> {
    if (isInitialized) return true;

    const detectedRoot = findRepoRoot(worktree);
    if (!detectedRoot) return false;

    try {
      repoRoot = detectedRoot;
      config = loadConfig(repoRoot);
      fileWatcher = (await getOrCreateWatcher(repoRoot, config)) as FileWatcher;

      fileWatcher.on("add", async (filePath: string) => {
        let pooled;
        try {
          pooled = await getCoordinator(worktree);
          await pooled.coordinator.reembedFile(filePath);
        } catch (error) {
          console.error(`[Beacon] Error adding file ${filePath}:`, error);
        } finally {
          if (pooled) {
            try {
              await releaseCoordinator(worktree);
            } catch {}
          }
        }
      });

      fileWatcher.on("change", async (filePath: string) => {
        let pooled;
        try {
          pooled = await getCoordinator(worktree);
          await pooled.coordinator.reembedFile(filePath);
        } catch (error) {
          console.error(`[Beacon] Error reembedding file ${filePath}:`, error);
        } finally {
          if (pooled) {
            try {
              await releaseCoordinator(worktree);
            } catch {}
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
          console.error(`[Beacon] Error deleting file ${filePath}:`, error);
        } finally {
          if (pooled) {
            try {
              await releaseCoordinator(worktree);
            } catch {}
          }
        }
      });

      fileWatcher.on("error", (error: Error) => {
        console.error(`[Beacon] File watcher error:`, error);
      });

      fileWatcher.start();
      isInitialized = true;

      // Perform auto-indexing on initialization if configured
      if (config.indexing.auto_index && !hasAttemptedAutoIndex) {
        hasAttemptedAutoIndex = true;
        // Run silently in background
        performAutoIndex().catch((error) => {
          console.error(`[Beacon] Auto-indexing error:`, error);
        });
      }

      return true;
    } catch (error) {
      console.error(`[Beacon] Plugin initialization error:`, error);
      return false;
    }
  }

  await initializePlugin();

  return {
    event: async ({ event }) => {
      if (event.type === "session.created") {
        const sessionID = (event as any).properties?.info?.id;
        if (!sessionID) return;

        if (!isInitialized) {
          const initialized = await initializePlugin();
          if (!initialized) return;
        }

        if (!hasAttemptedAutoIndex) {
          hasAttemptedAutoIndex = true;
          await performAutoIndex(sessionID);
        } else {
          // Check if indexing is needed and show status
          const pooled = await getCoordinator(worktree);
          const stats = pooled.db.getStats();
          
          if (stats.total_chunks === 0 && config?.indexing.auto_index) {
            await releaseCoordinator(worktree);
            await performAutoIndex(sessionID);
          } else {
            await releaseCoordinator(worktree);
          }
        }
      }
    },

    tool: {
      grep: SearchTool,
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
      if (!/\bgrep\b/.test(command) || command.includes("git grep")) return;

      // Check if this is a code search pattern (file extensions or no explicit file)
      const isLikelyCodeSearch = 
        !command.includes(">") && 
        !/\|\s*grep/.test(command) &&
        (/\.(ts|tsx|js|jsx|py|go|rs|java|rb|php|sql|md)$/m.test(command) || 
         /^[^>]*grep\s+[^|]*['"][^'"]+['"][^|]*$/m.test(command));

      if (isLikelyCodeSearch) {
        const grepMatch = command.match(/grep\s+(?:-[a-zA-Z]+\s+)*["']([^"']+)["']/);
        const query = grepMatch?.[1];

        if (query && query.length > 2) {
          // Log a suggestion but don't block execution
          console.warn(
            `💡 Beacon Tip: For code searches, consider using the 'search' tool:\n` +
            `   search(query="${query}")\n` +
            `   (This provides semantic matching and better results)\n` +
            `   Proceeding with grep as requested...`
          );
          // Don't throw - allow execution to continue
          return;
        }
      }
      
      // For pipeline operations, file searches, or explicit non-code use cases, allow grep
      // No warning needed - grep is appropriate here
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
            await new Promise(resolve => setTimeout(resolve, 100 * (i + 1)));
            const success = await initializePlugin();
            if (success) {
              // Immediately perform auto-indexing for the newly detected repo
              if (config?.indexing.auto_index) {
                await performAutoIndex();
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
            console.error(`[Beacon] Error reembedding file ${filePath}:`, error);
          } finally {
            if (pooled) {
              try {
                await releaseCoordinator(worktree);
              } catch {}
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
            for (const _ of deletedFiles) {
              pooled.coordinator.garbageCollect();
            }
          } catch (error) {
            console.error(`[Beacon] Error garbage collecting:`, error);
          } finally {
            if (pooled) {
              try {
                await releaseCoordinator(worktree);
              } catch {}
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
        console.error(`[Beacon] Error getting status:`, error);
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
