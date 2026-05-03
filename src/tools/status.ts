import { tool } from "@opencode-ai/plugin";
import { getBeaconRoot } from "../lib/repo-root.js";
import { loadConfig } from "../lib/config.js";
import { openDatabase } from "../lib/db.js";
import { Embedder } from "../lib/embedder.js";
import { connectionPool } from "../lib/pool.js";
import { getFailedIndexFiles } from "../lib/index-state.js";
import { join } from "path";
import { existsSync } from "fs";

export default tool({
  description:
    "Quick health check of the Beacon index - shows file count, chunk count, last sync time",
  args: {},
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
          status: indexerRunning ? "indexing" : "no_index",
          indexer_running: indexerRunning,
          message: indexerRunning
            ? "Indexer is currently running (auto-index on startup). Wait for it to complete or call terminateIndexer to stop it."
            : "Index not found. Run 'reindex' tool to create the index.",
          files_indexed: 0,
          total_chunks: 0,
          embedding_model: config.embedding.model,
          embedding_endpoint: config.embedding.api_base,
          model_downloaded: modelDownloaded,
          ...(modelDownloaded === false && {
            model_warning: `Model '${config.embedding.model}' is not downloaded. Run the 'downloadModels' tool with model='${config.embedding.model}' before indexing, or search quality will be significantly degraded (BM25-only fallback).`,
          }),
        });
      }

      const db = openDatabase(dbPath, config.embedding.dimensions);

      try {
        const stats = db.getStats();
        const syncProgress = db.getSyncProgress();
        const lastSync = db.getSyncState("last_full_sync");
        const modelCheck = Embedder.checkModelDownloaded(config.embedding, config.storage.path);
        const modelDownloaded = modelCheck ? modelCheck.downloaded : null;

        // Merge in-memory flag with DB state for the most accurate picture.
        const effectivelyRunning = indexerRunning || syncProgress.sync_status === "in_progress";

        const failedFiles = getFailedIndexFiles();

        return JSON.stringify({
          status: "ok",
          indexer_running: effectivelyRunning,
          ...(effectivelyRunning && {
            indexer_message: "An indexing operation is currently in progress. Avoid running reindex until it completes. Call terminateIndexer to stop it early.",
          }),
          files_indexed: stats.files_indexed,
          total_chunks: stats.total_chunks,
          last_sync: lastSync || "never",
          sync_status: syncProgress.sync_status,
          embedding_model: config.embedding.model,
          embedding_endpoint: config.embedding.api_base,
          database_path: config.storage.path,
          model_downloaded: modelDownloaded,
          failed_files: {
            count: failedFiles.length,
            files: failedFiles,
          },
          ...(modelDownloaded === false && {
            model_warning: `Model '${config.embedding.model}' is not downloaded. Run the 'downloadModels' tool with model='${config.embedding.model}' to enable vector search. Current searches fall back to BM25-only.`,
          }),
        });
      } finally {
        db.close();
      }
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return JSON.stringify({
        error: `Status check failed: ${errorMessage}`,
      });
    }
  },
});
