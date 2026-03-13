/**
 * Beacon Index Visual Tool for OpenCode
 * Shows colored dashboard of index status

 */

import { tool } from "@opencode-ai/plugin";
import { getRepoRoot } from "../../src/lib/repo-root.ts";
import { loadConfig } from "../../src/lib/config.ts";
import { openDatabase } from "../../src/lib/db.ts";
import { join } from "path";
import { existsSync } from "fs";

// ANSI color codes for terminal output
const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  red: "\x1b[31m",
};

export default tool({
  description:
    "Visual overview of Beacon index with dashboard - chunks, coverage, provider, file list",
  args: {
    files: tool.schema
      .boolean()
      .optional()
      .describe("Include detailed file list in output"),
  },
  async execute(args: any, context: any): Promise<string> {
    try {
      const repoRoot = getRepoRoot(context.worktree);
      const config = loadConfig(repoRoot);

      const dbPath = join(repoRoot, config.storage.path, "embeddings.db");

      if (!existsSync(dbPath)) {
        return JSON.stringify({
          status: "not_indexed",
          message: "Index not found. Run the reindex tool to create the index.",
          files_indexed: 0,
          total_chunks: 0,
          embedding_model: config.embedding.model,
        });
      }

      const db = openDatabase(dbPath, config.embedding.dimensions);

      try {
        // Get index statistics
        const stats = db.getStats();
        const syncProgress = db.getSyncProgress();

        // Format the dashboard
        const dashboard = [
          `${colors.bright}${colors.cyan}╔════════════════════════════════════════╗${colors.reset}`,
          `${colors.bright}${colors.cyan}║${colors.reset}  ${colors.bright}Beacon Index Dashboard${colors.reset}${" ".repeat(16)}${colors.bright}${colors.cyan}║${colors.reset}`,
          `${colors.bright}${colors.cyan}╠════════════════════════════════════════╣${colors.reset}`,
          `${colors.bright}${colors.cyan}║${colors.reset}  ${colors.green}✓ Files Indexed:${colors.reset} ${stats.files_indexed.toString().padEnd(24)}${colors.bright}${colors.cyan}║${colors.reset}`,
          `${colors.bright}${colors.cyan}║${colors.reset}  ${colors.blue}⊙ Total Chunks:${colors.reset} ${stats.total_chunks.toString().padEnd(24)}${colors.bright}${colors.cyan}║${colors.reset}`,
          `${colors.bright}${colors.cyan}║${colors.reset}  ${colors.yellow}◆ Embedding Model:${colors.reset} ${config.embedding.model.padEnd(20)}${colors.bright}${colors.cyan}║${colors.reset}`,
          `${colors.bright}${colors.cyan}║${colors.reset}  ${colors.blue}◆ Vector Dimensions:${colors.reset} ${config.embedding.dimensions.toString().padEnd(19)}${colors.bright}${colors.cyan}║${colors.reset}`,
        ];

        // Add sync status
        if (syncProgress.sync_status === "in_progress") {
          const filesMsg = syncProgress.files_indexed
            ? `${syncProgress.files_indexed}/${syncProgress.total_files}`
            : "...";
          dashboard.push(
            `${colors.bright}${colors.cyan}║${colors.reset}  ${colors.yellow}⟳ Sync Status:${colors.reset} In Progress (${filesMsg})${" ".repeat(8)}${colors.bright}${colors.cyan}║${colors.reset}`
          );
        } else if (syncProgress.sync_status === "error") {
          dashboard.push(
            `${colors.bright}${colors.cyan}║${colors.reset}  ${colors.red}✗ Sync Status:${colors.reset} Error${" ".repeat(29)}${colors.bright}${colors.cyan}║${colors.reset}`
          );
          if (syncProgress.error) {
            dashboard.push(
              `${colors.bright}${colors.cyan}║${colors.reset}  ${colors.red}Error:${colors.reset} ${syncProgress.error.slice(0, 31).padEnd(31)}${colors.bright}${colors.cyan}║${colors.reset}`
            );
          }
        } else {
          dashboard.push(
            `${colors.bright}${colors.cyan}║${colors.reset}  ${colors.green}✓ Sync Status:${colors.reset} Idle${" ".repeat(31)}${colors.bright}${colors.cyan}║${colors.reset}`
          );
        }

        if (syncProgress.sync_started_at) {
          const date = new Date(syncProgress.sync_started_at);
          const formatted = date.toLocaleString();
          dashboard.push(
            `${colors.bright}${colors.cyan}║${colors.reset}  ${colors.blue}Last Sync:${colors.reset} ${formatted.slice(0, 29).padEnd(29)}${colors.bright}${colors.cyan}║${colors.reset}`
          );
        }

        dashboard.push(
          `${colors.bright}${colors.cyan}╚════════════════════════════════════════╝${colors.reset}`
        );

        // Add file list if requested
        let result: Record<string, unknown> = {
          status: "success",
          statistics: {
            files_indexed: stats.files_indexed,
            total_chunks: stats.total_chunks,
            database_size_mb: stats.database_size_mb,
          },
          configuration: {
            embedding_model: config.embedding.model,
            vector_dimensions: config.embedding.dimensions,
            chunking_strategy: config.chunking.strategy,
            max_chunk_tokens: config.chunking.max_tokens,
          },
          sync: {
            status: syncProgress.sync_status,
            started_at: syncProgress.sync_started_at,
            files_indexed: syncProgress.files_indexed,
            total_files: syncProgress.total_files,
            error: syncProgress.error,
          },
          dashboard: dashboard.join("\n"),
        };

        if (args.files) {
          const indexedFiles = db.getIndexedFiles();
          const fileDetails = indexedFiles.map((file: string) => ({
            path: file,
          }));
          result.files = fileDetails;
        }

        return JSON.stringify(result);
      } finally {
        db.close();
      }
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return JSON.stringify({
        status: "error",
        error: `Index overview failed: ${errorMessage}`,
      });
    }
  },
});
