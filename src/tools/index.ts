import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import { getBeaconRoot } from "../lib/repo-root.js";
import { loadConfig } from "../lib/config.js";
import { openDatabase } from "../lib/db.js";
import { Embedder } from "../lib/embedder.js";
import { connectionPool } from "../lib/pool.js";
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

const _export: ToolDefinition = tool({
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
      const repoRoot = getBeaconRoot(context.worktree);
      const config = loadConfig(repoRoot);

      // Check in-memory running flag first — authoritative for this process.
      const indexerRunning = connectionPool.isIndexerRunning(context.worktree);

      const dbPath = join(config.storage.path, "embeddings.db");

      if (!existsSync(dbPath)) {
        const modelCheck = Embedder.checkModelDownloaded(config.embedding, config.storage.path);
        const modelDownloaded = modelCheck ? modelCheck.downloaded : null;
        return JSON.stringify({
          status: indexerRunning ? "indexing" : "not_indexed",
          indexer_running: indexerRunning,
          ...(indexerRunning && {
            indexer_message: "Indexer is currently running (auto-index on startup). The index will be available once it completes.",
          }),
          message: indexerRunning
            ? "Indexing in progress — check back shortly or call status for progress."
            : "Index not found. Run the reindex tool to create the index.",
          files_indexed: 0,
          total_chunks: 0,
          embedding_model: config.embedding.model,
          model_downloaded: modelDownloaded,
          ...(modelDownloaded === false && {
            model_warning: `Model '${config.embedding.model}' is not downloaded. Run the 'downloadModels' tool with model='${config.embedding.model}' before indexing.`,
          }),
        });
      }

      const db = openDatabase(dbPath, config.embedding.dimensions);

      try {
        // Get index statistics
        const stats = db.getStats();
        const syncProgress = db.getSyncProgress();
        const modelCheck = Embedder.checkModelDownloaded(config.embedding, config.storage.path);
        const modelDownloaded = modelCheck ? modelCheck.downloaded : null;

        // Merge in-memory flag with DB state.
        const effectivelyRunning = indexerRunning || syncProgress.sync_status === "in_progress";

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
        if (effectivelyRunning) {
          const filesMsg = syncProgress.files_indexed
            ? `${syncProgress.files_indexed}/${syncProgress.total_files}`
            : "...";
          dashboard.push(
            `${colors.bright}${colors.cyan}║${colors.reset}  ${colors.yellow}⟳ Sync Status:${colors.reset} In Progress (${filesMsg})${" ".repeat(8)}${colors.bright}${colors.cyan}║${colors.reset}`
          );
          dashboard.push(
            `${colors.bright}${colors.cyan}║${colors.reset}  ${colors.yellow}⚠ Indexing — do not reindex!${colors.reset}${" ".repeat(10)}${colors.bright}${colors.cyan}║${colors.reset}`
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

        // Model download status row
        if (modelDownloaded === false) {
          dashboard.push(
            `${colors.bright}${colors.cyan}║${colors.reset}  ${colors.red}✗ Model Not Downloaded:${colors.reset} run downloadModels  ${colors.bright}${colors.cyan}║${colors.reset}`
          );
        } else if (modelDownloaded === true) {
          dashboard.push(
            `${colors.bright}${colors.cyan}║${colors.reset}  ${colors.green}✓ Model Downloaded${colors.reset}${" ".repeat(22)}${colors.bright}${colors.cyan}║${colors.reset}`
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
          model_downloaded: modelDownloaded,
          ...(modelDownloaded === false && {
            model_warning: `Model '${config.embedding.model}' is not downloaded. Run the 'downloadModels' tool with model='${config.embedding.model}' to enable vector search. Current searches fall back to BM25-only.`,
          }),
          sync: {
            status: syncProgress.sync_status,
            indexer_running: effectivelyRunning,
            ...(effectivelyRunning && {
              indexer_message: "An indexing operation is currently in progress. Do not run reindex until it completes. Call terminateIndexer to stop it early.",
            }),
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
export default _export;
