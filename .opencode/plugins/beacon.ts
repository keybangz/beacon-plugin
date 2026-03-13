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

/**
 * Beacon plugin for OpenCode
 * Handles:
 * - Auto-indexing on session start
 * - Re-embedding on file changes
 * - Garbage collection after bash commands
 * - Context injection before compaction
 */
export const BeaconPlugin: Plugin = async ({
  project,
  client,
  $,
  directory,
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
    },

    // Session start hook - initialize indexing
    "session.created": async (input, output) => {
      try {
        // TODO: Implement session start logic
        // 1. Check if .beacon database exists
        // 2. If not, perform full index
        // 3. If yes, perform diff-based catch-up
        await client.app.log({
          body: {
            service: "beacon",
            level: "info",
            message: "Beacon session started",
            extra: { directory, worktree },
          },
        });
      } catch (error: unknown) {
        const errorMsg =
          error instanceof Error ? error.message : String(error);
        await client.app.log({
          body: {
            service: "beacon",
            level: "error",
            message: `Session start failed: ${errorMsg}`,
          },
        });
      }
    },

    // File edit hook - re-embed changed files
    "file.edited": async (input, output) => {
      try {
        // TODO: Implement file re-embedding
        // 1. Get changed file path
        // 2. Read content and hash
        // 3. Split into chunks
        // 4. Generate embeddings
        // 5. Update database
      } catch (error: unknown) {
        const errorMsg =
          error instanceof Error ? error.message : String(error);
        await client.app.log({
          body: {
            service: "beacon",
            level: "warn",
            message: `File embedding failed: ${errorMsg}`,
          },
        });
      }
    },

    // Tool execution hook - handle post-tool cleanup
    "tool.execute.after": async (input, output) => {
      try {
        // If bash command was executed, run garbage collection
        if (input.tool === "bash") {
          // TODO: Implement garbage collection
          // 1. Detect deleted files
          // 2. Remove corresponding chunks from database
        }
      } catch (error: unknown) {
        const errorMsg =
          error instanceof Error ? error.message : String(error);
        await client.app.log({
          body: {
            service: "beacon",
            level: "warn",
            message: `Garbage collection failed: ${errorMsg}`,
          },
        });
      }
    },

    // Compaction hook - inject index status into context
    "experimental.session.compacting": async (input, output) => {
      try {
        // TODO: Implement compaction context injection
        // 1. Get current index status
        // 2. Format as structured context
        // 3. Add to output.context array
        output.context.push(`## Beacon Index Status
The codebase has been indexed for semantic search. The Beacon search capability is available via the 'search' tool.`);
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
        // TODO: Inject any necessary environment variables
        // For now, just ensure standard vars are available
        output.env.BEACON_HOME = worktree;
      } catch (error: unknown) {
        // Silently fail - don't block shell execution
      }
    },
  };
};
