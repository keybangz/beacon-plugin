/**
 * Beacon OpenCode Plugin
 * Main plugin entry point with event hooks for auto-sync, re-embedding, and garbage collection
 */

import type { Plugin } from "@opencode-ai/plugin";
import SearchTool from "../tools/search.ts";
import IndexTool from "../tools/index.ts";
import ReindexTool from "../tools/reindex.ts";
import StatusTool from "../tools/status.ts";
import ConfigTool from "../tools/config.ts";
import BlacklistTool from "../tools/blacklist.ts";
import WhitelistTool from "../tools/whitelist.ts";
import PerformanceTool from "../tools/performance.ts";
import TerminateIndexerTool from "../tools/terminate-indexer.ts";
import { getRepoRoot } from "../src/lib/repo-root.js";
import { loadConfig } from "../src/lib/config.js";
import { openDatabase } from "../src/lib/db.js";
import { Embedder } from "../src/lib/embedder.js";
import { IndexCoordinator } from "../src/lib/sync.js";
import { join } from "path";
import { existsSync } from "fs";

/**
 * Extract file path from tool arguments
 */
function extractFilePath(args: any, toolName: string): string | null {
  if (!args) return null;
  
  // Handle different tool argument formats
  if (toolName === "write_file" || toolName === "edit_file") {
    return args.file_path || args.path || args.file || null;
  }
  if (toolName === "str_replace_editor") {
    return args.path || args.file_path || null;
  }
  return null;
}

/**
 * Initialize indexing coordinator for a given worktree
 */
function getCoordinator(worktree: string) {
  const repoRoot = getRepoRoot(worktree);
  const config = loadConfig(repoRoot);
  const storagePath = join(repoRoot, config.storage.path);
  const dbPath = join(storagePath, "embeddings.db");
  const db = openDatabase(dbPath, config.embedding.dimensions);
  const embedder = new Embedder(config.embedding, config.embedding.context_limit);
  const coordinator = new IndexCoordinator(config, db, embedder, repoRoot);
  return { coordinator, db, config };
}

/**
 * Beacon plugin for OpenCode
 * Handles:
 * - Garbage collection after bash/file tool calls
 * - Context injection before compaction
 * - Shell environment setup
 */
export const BeaconPlugin: Plugin = async ({
  client,
  worktree,
}) => {
  return {
    // Custom tools
    tool: {
      search: SearchTool,
      index: IndexTool,
      reindex: ReindexTool,
      status: StatusTool,
      config: ConfigTool,
      blacklist: BlacklistTool,
      whitelist: WhitelistTool,
      performance: PerformanceTool,
      "terminate-indexer": TerminateIndexerTool,
    },

    // Tool execution hook - handle post-tool sync and garbage collection
    "tool.execute.after": async (input, output) => {
      try {
        // If a file-modifying tool was executed, re-embed the changed file
        const fileTools = ["write_file", "edit_file", "str_replace_editor"];
        const shellTools = ["bash", "shell"];

        if (fileTools.includes(input.tool)) {
          const filePath = extractFilePath(input.args, input.tool);
          if (filePath) {
            try {
              const { coordinator, db } = getCoordinator(worktree);
              const success = await coordinator.reembedFile(filePath);
              db.close();
              
              if (success) {
                await client.app.log({
                  body: {
                    service: "beacon",
                    level: "info",
                    message: `Auto-reindexed ${filePath}`,
                  },
                });
              }
            } catch (err) {
              // Log but don't fail the hook
              await client.app.log({
                body: {
                  service: "beacon",
                  level: "warn",
                  message: `Auto-reindex failed for ${filePath}: ${err}`,
                },
              });
            }
          }
        } else if (shellTools.includes(input.tool)) {
          // TODO: Implement garbage collection for deleted files
          // Detect rm, mv, git rm operations and clean up orphaned chunks
        }
      } catch (error: unknown) {
        const errorMsg =
          error instanceof Error ? error.message : String(error);
        await client.app.log({
          body: {
            service: "beacon",
            level: "warn",
            message: `Post-tool sync failed: ${errorMsg}`,
          },
        });
      }
    },

    // Compaction hook - inject index status into context
    "experimental.session.compacting": async (input, output) => {
      try {
        let statusText = "Not indexed";
        let statsText = "";
        
        try {
          const { coordinator, db } = getCoordinator(worktree);
          const stats = db.getStats();
          const syncProgress = db.getSyncProgress();
          db.close();
          
          if (stats.total_chunks > 0) {
            statusText = `Indexed (${stats.total_chunks} chunks, ${stats.files_indexed} files)`;
            if (syncProgress.sync_status === "in_progress") {
              const filesIndexed = db.getSyncState("files_indexed") || "0";
              const totalFiles = db.getSyncState("total_files") || "0";
              statusText = `Indexing in progress: ${filesIndexed}/${totalFiles} files`;
            }
          }
        } catch {
          // Database may not exist yet
        }
        
        output.context.push(`## Beacon Index Status
${statusText}
The Beacon search capability is available via the 'search' tool.`);
      } catch (error: unknown) {
        // Silently fail - don't block compaction
        const errorMsg =
          error instanceof Error ? error.message : String(error);
        await client.app.log({
          body: {
            service: "beacon",
            level: "debug",
            message: `Compaction context injection failed: ${errorMsg}`,
          },
        });
      }
    },

    // Shell environment hook - inject necessary variables
    "shell.env": async (input, output) => {
      try {
        // Ensure standard Beacon env vars are available
        output.env.BEACON_HOME = worktree;
      } catch (error: unknown) {
        // Silently fail - don't block shell execution
      }
    },
  };
};

export default BeaconPlugin;
