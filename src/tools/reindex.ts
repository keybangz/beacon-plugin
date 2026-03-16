import { tool } from "@opencode-ai/plugin";
import { getRepoRoot } from "../lib/repo-root.js";
import { loadConfig } from "../lib/config.js";
import { openDatabase } from "../lib/db.js";
import { Embedder } from "../lib/embedder.js";
import { IndexCoordinator, type IndexProgress } from "../lib/sync.js";
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

export default tool({
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
      const repoRoot = getRepoRoot(context.worktree);
      const config = loadConfig(repoRoot);

      const storagePath = join(repoRoot, config.storage.path);
      if (!existsSync(storagePath)) {
        mkdirSync(storagePath, { recursive: true });
      }

      const dbPath = join(storagePath, "embeddings.db");

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

        const coordinator = new IndexCoordinator(
          config,
          db,
          embedder,
          repoRoot
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

        const stats = db.getStats();
        const syncProgress = db.getSyncProgress();

        context.metadata({ 
          title: `Beacon Reindex: ${stats.total_chunks} chunks`,
          metadata: { chunks: stats.total_chunks, files: result.filesIndexed }
        });

        return JSON.stringify({
          status: "success",
          message: "Full reindex completed successfully",
          files_indexed: result.filesIndexed,
          total_chunks: stats.total_chunks,
          database_size_mb: stats.database_size_mb,
          duration_seconds: parseFloat(durationSeconds),
          sync_status: syncProgress.sync_status,
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
        db.close();
      }
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      
      context.metadata({ title: `❌ Beacon Reindex Failed` });
      
      return JSON.stringify({
        status: "error",
        error: `Reindex failed: ${errorMessage}`,
      });
    }
  },
});
