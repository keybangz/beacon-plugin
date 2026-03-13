/**
 * Beacon Terminate Indexer Tool for OpenCode
 * Kills a running sync/index process
 */

import { tool } from "@opencode-ai/plugin";
import { terminateIndexer, isIndexerRunning } from "../src/lib/sync.js";

export default tool({
  description:
    "Terminate a running Beacon index/sync operation immediately",
  args: {},
  async execute(_args: any, _context: any): Promise<string> {
    try {
      if (!isIndexerRunning()) {
        return JSON.stringify({
          status: "idle",
          message: "No indexing operation is currently running.",
        });
      }

      const aborted = terminateIndexer();

      if (aborted) {
        return JSON.stringify({
          status: "terminated",
          message: "Indexing operation has been terminated.",
        });
      }

      return JSON.stringify({
        status: "idle",
        message: "No indexing operation was running.",
      });
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
