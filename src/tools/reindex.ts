import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import { getBeaconRoot } from "../lib/repo-root.js";
import { loadConfig } from "../lib/config.js";
import { openDatabase } from "../lib/db.js";
import { Embedder } from "../lib/embedder.js";
import { IndexCoordinator, type IndexProgress } from "../lib/sync.js";
import { connectionPool } from "../lib/pool.js";
import { clearSearchCache } from "./search.js";
import { clearFailedIndexFiles } from "../lib/index-state.js";
import { join } from "path";
import { mkdirSync, existsSync, unlinkSync } from "fs";

function formatProgressTitle(progress: IndexProgress): string {
  const phaseEmoji: Record<string, string> = {
    discovering: "🔍",
    chunking: "📦",
    embedding: "🧠",
    storing: "💾",
    complete: "✅",
    error: "❌",
  };

  const emoji = phaseEmoji[progress.phase] || "⚡";
  return `${emoji} Beacon Reindex: ${progress.percent}% - ${progress.phase}`;
}

function shouldShowProgress(percent: number, phase: string, lastMilestone: { percent: number; phase: string }): boolean {
  if (phase === "error" || phase === "complete") return true;
  if (phase !== lastMilestone.phase) return true;
  const milestones = [10, 25, 50, 75, 90, 100];
  for (const m of milestones) {
    if (percent >= m && lastMilestone.percent < m) return true;
  }
  return false;
}

const _export: ToolDefinition = tool({
  description:
    "Force full re-index from scratch - deletes existing embeddings and rebuilds the entire database",
  args: {
    confirm: tool.schema
      .boolean()
      .optional()
      .describe("Skip confirmation prompt"),
  },
  async execute(args: any, context: any): Promise<string> {
    try {
      if (!args.confirm) {
        return JSON.stringify({
          status: "error",
          error: "Reindex requires explicit confirmation. Pass confirm=true to proceed. WARNING: this will delete all existing embeddings and rebuild the index from scratch.",
        });
      }

      // Safety net: block reindex if an indexer is already running in this process.
      // This prevents accidentally deleting the DB mid-index and corrupting the run.
      if (connectionPool.isIndexerRunning(context.worktree)) {
        return JSON.stringify({
          status: "blocked",
          error: "An indexing operation is currently in progress. Running reindex now would delete the DB mid-index and corrupt it. Wait for the current index to complete, or call terminateIndexer first, then retry.",
          suggestion: "Call the terminateIndexer tool to stop the current operation, then call reindex again.",
        });
      }

      const repoRoot = getBeaconRoot(context.worktree);
      const config = loadConfig(repoRoot);

      // Warn early if the embedding model isn't downloaded — indexing will still
      // proceed but semantic search will be unavailable (BM25-only fallback).
      const modelCheck = Embedder.checkModelDownloaded(config.embedding, config.storage.path);
      const modelWarning = modelCheck && !modelCheck.downloaded
        ? `WARNING: Model '${config.embedding.model}' is not downloaded. Vector embeddings will be skipped and search quality will be degraded (BM25-only). Run the 'downloadModels' tool with model='${config.embedding.model}' first, then reindex again.`
        : undefined;

      const storagePath = config.storage.path;
      if (!existsSync(storagePath)) {
        mkdirSync(storagePath, { recursive: true });
      }

      // Clear failed index files tracking at start of reindex
      clearFailedIndexFiles();

      const dbPath = join(storagePath, "embeddings.db");

      // Close any pooled connection for this repo before deleting DB files to
      // avoid leaving a stale open file handle / in-memory state behind.
      await connectionPool.close(context.worktree);

      for (const suffix of ["", "-wal", "-shm"]) {
        const f = dbPath + suffix;
        if (existsSync(f)) unlinkSync(f);
      }

      const hnswIndexFile = join(storagePath, "hnsw.index");
      const hnswEntriesFile = join(storagePath, "hnsw.entries.json");
      if (existsSync(hnswIndexFile)) unlinkSync(hnswIndexFile);
      if (existsSync(hnswEntriesFile)) unlinkSync(hnswEntriesFile);

      const db = openDatabase(dbPath, config.embedding.dimensions);

      try {
        const effectiveContextLimit = config.embedding.context_limit ?? config.chunking.max_tokens;
        const embedder = new Embedder(config.embedding, effectiveContextLimit, storagePath);

        try {
          const coordinator = new IndexCoordinator(
            config,
            db,
            embedder,
            repoRoot,
            (running) => {
              if (running) {
                connectionPool.markIndexerRunning(repoRoot);
              } else {
                connectionPool.markIndexerDone(repoRoot);
              }
            }
          );

          const lastMilestone = { percent: 0, phase: "" };

          const onProgress = (progress: IndexProgress) => {
            if (shouldShowProgress(progress.percent, progress.phase, lastMilestone)) {
              lastMilestone.percent = progress.percent;
              lastMilestone.phase = progress.phase;
            }
          };

          const startTime = Date.now();
          const result = await coordinator.performFullIndex(onProgress);
          const endTime = Date.now();
          const durationSeconds = ((endTime - startTime) / 1000).toFixed(2);

          // Clear search cache after successful reindex to avoid stale results
          clearSearchCache();

          const stats = db.getStats();
          const syncProgress = db.getSyncProgress();

          return JSON.stringify({
            status: "success",
            message: "Full reindex completed successfully",
            files_indexed: result.filesIndexed,
            total_chunks: stats.total_chunks,
            database_size_mb: stats.database_size_mb,
            duration_seconds: parseFloat(durationSeconds),
            sync_status: syncProgress.sync_status,
            model_downloaded: modelCheck ? modelCheck.downloaded : null,
            ...(modelWarning && { model_warning: modelWarning }),
            statistics: {
              files_processed: result.filesIndexed,
              chunks_created: stats.total_chunks,
              average_chunks_per_file:
                result.filesIndexed > 0
                  ? (stats.total_chunks / result.filesIndexed).toFixed(2)
                  : "0",
            },
          });
        } finally {
          await embedder.close();
        }
      } finally {
        db.close();
      }
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      return JSON.stringify({
        status: "error",
        error: `Reindex failed: ${errorMessage}`,
      });
    }
  },
});
export default _export;
