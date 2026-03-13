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
          // TODO: Implement incremental re-embedding for changed files
          // 1. Extract file path from input.args
          // 2. Read content and hash
          // 3. Split into chunks
          // 4. Generate embeddings
          // 5. Update database
        } else if (shellTools.includes(input.tool)) {
          // TODO: Implement garbage collection for deleted files
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
            message: `Post-tool sync failed: ${errorMsg}`,
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
        // Ensure standard Beacon env vars are available
        output.env.BEACON_HOME = worktree;
      } catch (error: unknown) {
        // Silently fail - don't block shell execution
      }
    },
  };
};

export default BeaconPlugin;
