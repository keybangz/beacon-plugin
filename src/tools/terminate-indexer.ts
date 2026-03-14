/**
 * Beacon Terminate Indexer Tool for OpenCode
 * Kills a running sync/index process using database flag
 */

import { tool } from "@opencode-ai/plugin";
import { getRepoRoot } from "../lib/repo-root.js";
import { loadConfig } from "../lib/config.js";
import { openDatabase } from "../lib/db.js";
import { terminateIndexer, isIndexerRunning } from "../lib/sync.js";
import { join } from "path";

export default tool({
  description:
    "Terminate a running Beacon index/sync operation immediately",
  args: {},
  async execute(_args: any, context: any): Promise<string> {
    try {
      const repoRoot = getRepoRoot(context.worktree);
      const config = loadConfig(repoRoot);
      const storagePath = join(repoRoot, config.storage.path);
      const dbPath = join(storagePath, "embeddings.db");
      
      // Open database to check/set termination flag
      const db = openDatabase(dbPath, config.embedding.dimensions);
      
      try {
        if (!isIndexerRunning(db)) {
          return JSON.stringify({
            status: "idle",
            message: "No indexing operation is currently running.",
          });
        }

        const aborted = terminateIndexer(db);

        if (aborted) {
          return JSON.stringify({
            status: "terminated",
            message: "Indexing operation has been terminated. The current batch will complete before stopping.",
          });
        }

        return JSON.stringify({
          status: "idle",
          message: "No indexing operation was running.",
        });
      } finally {
        db.close();
      }
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return JSON.stringify({
        status: "error",
        error: `Failed to terminate indexer: ${errorMessage}`,
      });
    }
  },
});
