/**
 * Beacon Reindex Tool for OpenCode
 * Forces full rebuild from scratch

 */

import { tool } from "@opencode-ai/plugin";
import { getRepoRoot } from "../../src/lib/repo-root.ts";
import { loadConfig } from "../../src/lib/config.ts";
import { openDatabase } from "../../src/lib/db.ts";
import { Embedder } from "../../src/lib/embedder.ts";
import { IndexCoordinator } from "../../src/lib/sync.ts";
import { join } from "path";
import { mkdirSync, existsSync, unlinkSync, rmSync } from "fs";

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

      // Ensure storage directory exists
      const storagePath = join(repoRoot, config.storage.path);
      if (!existsSync(storagePath)) {
        mkdirSync(storagePath, { recursive: true });
      }

      const dbPath = join(storagePath, "embeddings.db");

      // Delete existing database files to guarantee a truly clean slate.
      // Relying on db.clear() (DELETE FROM chunks) is not sufficient when
      // config parameters like max_tokens or dimensions have changed between runs.
      for (const suffix of ["", "-wal", "-shm"]) {
        const f = dbPath + suffix;
        if (existsSync(f)) unlinkSync(f);
      }

      // Initialize database
      const db = openDatabase(dbPath, config.embedding.dimensions);

      try {
        // Initialize embedder - use context_limit if set, otherwise chunking max_tokens
        const effectiveContextLimit = config.embedding.context_limit ?? config.chunking.max_tokens;
        const embedder = new Embedder(config.embedding, effectiveContextLimit);

        // Create index coordinator
        const coordinator = new IndexCoordinator(
          config,
          db,
          embedder,
          repoRoot
        );

        // Perform full index
        const startTime = Date.now();
        const result = await coordinator.performFullIndex();
        const endTime = Date.now();
        const durationSeconds = ((endTime - startTime) / 1000).toFixed(2);

        // Get final statistics
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
      return JSON.stringify({
        status: "error",
        error: `Reindex failed: ${errorMessage}`,
      });
    }
  },
});
