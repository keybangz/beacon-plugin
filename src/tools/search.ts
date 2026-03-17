import { tool } from "@opencode-ai/plugin";
import { getRepoRoot } from "../lib/repo-root.js";
import { loadConfig } from "../lib/config.js";
import { openDatabase } from "../lib/db.js";
import { Embedder } from "../lib/embedder.js";
import { truncateToTokenLimit } from "../lib/tokenizer.js";
import { SearchCache } from "../lib/cache.js";
import { join } from "path";
import { existsSync } from "fs";

const searchCache = new SearchCache(200, 300);

export default tool({
  description:
    "Search the codebase using Beacon hybrid search (semantic embeddings + BM25 + identifier boosting). This tool should be used instead of grep for all code searches as it provides semantic understanding of queries.",
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

      const cacheOptions = { topK: args.topK, threshold: args.threshold, pathPrefix: args.pathPrefix, noHybrid: args.noHybrid };
      const cachedResults = searchCache.get(args.query, cacheOptions);
      if (cachedResults) {
        return JSON.stringify(cachedResults);
      }

      const db = openDatabase(dbPath, config.embedding.dimensions);
      const useEmbeddings = config.embedding.enabled !== false;
      
      try {
        const dimCheck = db.checkDimensions();
        if (!dimCheck.ok) {
          return JSON.stringify({
            error: `Dimension mismatch: DB has ${dimCheck.stored}d but config specifies ${dimCheck.current}d`,
            matches: [],
          });
        }

        if (!useEmbeddings) {
          const results = db.ftsOnlySearch(
            args.query,
            args.topK ?? 10,
            args.pathPrefix
          );
          
          const output = JSON.stringify({
            query: args.query,
            mode: "bm25-only",
            matches: results.map((r) => ({
              file: r.filePath,
              lines: `${r.startLine}-${r.endLine}`,
              similarity: r.similarity.toFixed(3),
              preview: truncateToTokenLimit(r.chunkText, 150),
            })),
          });
          searchCache.set(args.query, JSON.parse(output), cacheOptions);
          return output;
        }

        const effectiveContextLimit = config.embedding.context_limit ?? config.chunking.max_tokens;
        const storagePath = join(repoRoot, config.storage.path);
        const embedder = new Embedder(config.embedding, effectiveContextLimit, storagePath);
        
        try {
          let results;
          try {
            const queryWithPrefix = (config.embedding.query_prefix || "") + args.query;
            const queryEmbedding = await embedder.embedQuery(queryWithPrefix);
            
            results = db.search(
              queryEmbedding,
              args.topK ?? config.search.top_k ?? 10,
              args.threshold ?? config.search.similarity_threshold ?? 0.01,
              args.query,
              config,
              args.pathPrefix,
              args.noHybrid
            );
          } catch (embedError: unknown) {
            const embedErrorMsg = embedError instanceof Error ? embedError.message : String(embedError);
            
            let ftsResults;
            try {
              ftsResults = db.ftsOnlySearch(
                args.query,
                args.topK ?? 10,
                args.pathPrefix
              );
            } catch (ftsError: unknown) {
              const ftsErrorMsg = ftsError instanceof Error ? ftsError.message : String(ftsError);
              return JSON.stringify({
                error: `Search failed: embedding unavailable (${embedErrorMsg}) and keyword search failed (${ftsErrorMsg})`,
                matches: [],
              });
            }
            
            const output = JSON.stringify({
              warning: `Embedding server unavailable (${embedErrorMsg}), using keyword search`,
              matches: ftsResults.map((r) => ({
                file: r.filePath,
                lines: `${r.startLine}-${r.endLine}`,
                similarity: r.similarity.toFixed(3),
                preview: truncateToTokenLimit(r.chunkText, 150),
                _note: r._note,
              })),
            });
            searchCache.set(args.query, JSON.parse(output), cacheOptions);
            return output;
          }

          const output = JSON.stringify({
            query: args.query,
            mode: "hybrid",
            matches: results.map((r) => ({
              file: r.filePath,
              lines: `${r.startLine}-${r.endLine}`,
              similarity: r.similarity.toFixed(3),
              preview: truncateToTokenLimit(r.chunkText, 150),
            })),
          });
          searchCache.set(args.query, JSON.parse(output), cacheOptions);
          return output;
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
        error: `Search failed: ${errorMessage}`,
      });
    }
  },
});
