/**
 * Beacon Search Tool for OpenCode
 * Performs hybrid semantic + keyword + identifier-boosted search
 */

import { tool } from "@opencode-ai/plugin";
import { getRepoRoot } from "../../src/lib/repo-root.ts";
import { loadConfig } from "../../src/lib/config.ts";
import { openDatabase } from "../../src/lib/db.ts";
import { Embedder } from "../../src/lib/embedder.ts";
import { truncateToTokenLimit } from "../../src/lib/tokenizer.ts";
import { join } from "path";
import { existsSync } from "fs";

export default tool({
  description:
    "Search the codebase using Beacon hybrid search (semantic embeddings + BM25 + identifier boosting)",
  args: {
    query: tool.schema.string().describe("Search query (e.g., 'authentication flow')"),
    topK: tool.schema
      .number()
      .optional()
      .describe("Maximum number of results (default: 10)"),
    threshold: tool.schema
      .number()
      .optional()
      .describe("Minimum score threshold (default: 0.35)"),
    pathPrefix: tool.schema
      .string()
      .optional()
      .describe("Scope results to a directory (e.g., 'src/auth/')"),
    noHybrid: tool.schema
      .boolean()
      .optional()
      .describe("Use pure vector search (disable BM25 and identifier boosting)"),
  },
  async execute(args, context): Promise<string> {
    try {
      const repoRoot = getRepoRoot(context.worktree);
      const config = loadConfig(repoRoot);
      
      const dbPath = join(repoRoot, config.storage.path, "embeddings.db");
      
      if (!existsSync(dbPath)) {
        return JSON.stringify({
          error: "Index not found. Run 'reindex' tool to create the index.",
          matches: [],
        });
      }

      const db = openDatabase(dbPath, config.embedding.dimensions);
      
      try {
        // Check dimensions match
        const dimCheck = db.checkDimensions();
        if (!dimCheck.ok) {
          return JSON.stringify({
            error: `Dimension mismatch: DB has ${dimCheck.stored}d but config specifies ${dimCheck.current}d`,
            matches: [],
          });
        }

        const embedder = new Embedder(config.embedding);
        
        // Try to embed the query (uses LRU cache — repeated/identical queries skip the HTTP round-trip)
        let results;
        try {
          const queryWithPrefix = (config.embedding.query_prefix || "") + args.query;
          const queryEmbedding = await embedder.embedQuery(queryWithPrefix);
          
          results = db.search(
            queryEmbedding,
            args.topK ?? 10,
            args.threshold ?? 0.35,
            args.query,
            config,
            args.pathPrefix,
            args.noHybrid
          );
        } catch (embedError: unknown) {
          // Fallback to FTS-only search
          const embedErrorMsg = embedError instanceof Error ? embedError.message : String(embedError);
          results = db.ftsOnlySearch(
            args.query,
            args.topK ?? 10,
            args.pathPrefix
          );
          
          return JSON.stringify({
            warning: `Embedding server unavailable (${embedErrorMsg}), using keyword search`,
            matches: results.map((r) => ({
              file: r.filePath,
              lines: `${r.startLine}-${r.endLine}`,
              similarity: r.similarity.toFixed(3),
              preview: truncateToTokenLimit(r.chunkText, 150),
              _note: r._note,
            })),
          });
        }

        return JSON.stringify({
          query: args.query,
          matches: results.map((r) => ({
            file: r.filePath,
            lines: `${r.startLine}-${r.endLine}`,
            similarity: r.similarity.toFixed(3),
            preview: truncateToTokenLimit(r.chunkText, 150),
          })),
        });
      } finally {
        db.close();
      }
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return JSON.stringify({
        error: `Search failed: ${errorMessage}`,
      });
    }
  },
});
