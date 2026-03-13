/**
 * Beacon Index Status Tool for OpenCode
 * Shows quick numeric summary of index health

 */

import { tool } from "@opencode-ai/plugin";
import { getRepoRoot } from "../../src/lib/repo-root.ts";
import { loadConfig } from "../../src/lib/config.ts";
import { openDatabase } from "../../src/lib/db.ts";
import { join } from "path";
import { existsSync } from "fs";

export default tool({
  description:
    "Quick health check of the Beacon index - shows file count, chunk count, last sync time",
  args: {},
  async execute(args, context): Promise<string> {
    try {
      const repoRoot = getRepoRoot(context.worktree);
      const config = loadConfig(repoRoot);
      
      const dbPath = join(repoRoot, config.storage.path, "embeddings.db");
      
      if (!existsSync(dbPath)) {
        return JSON.stringify({
          status: "no_index",
          message: "Index not found. Run 'reindex' tool to create the index.",
          files_indexed: 0,
          total_chunks: 0,
          embedding_model: config.embedding.model,
          embedding_endpoint: config.embedding.api_base,
        });
      }

      const db = openDatabase(dbPath, config.embedding.dimensions);
      
      try {
        const stats = db.getStats();
        const syncProgress = db.getSyncProgress();
        const lastSync = db.getSyncState("last_full_sync");

        return JSON.stringify({
          status: "ok",
          files_indexed: stats.files_indexed,
          total_chunks: stats.total_chunks,
          last_sync: lastSync || "never",
          sync_status: syncProgress.sync_status,
          embedding_model: config.embedding.model,
          embedding_endpoint: config.embedding.api_base,
          database_path: config.storage.path,
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
