import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import { getBeaconRoot } from "../lib/repo-root.js";
import { loadConfig } from "../lib/config.js";
import { truncateToTokenLimit } from "../lib/tokenizer.js";
import { SearchCache } from "../lib/cache.js";
import { createHeuristicReranker } from "../lib/reranker.js";
import { join } from "path";
import { existsSync } from "fs";
import { getCoordinator, releaseCoordinator } from "../lib/pool.js";

const searchCache = new SearchCache(200, 300_000);
const heuristicReranker = createHeuristicReranker();
const DECLARATION_RE = /^\s*(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|enum)\s+[a-zA-Z_$][\w$]*/;

function buildPreview(chunkText: string): string {
  const firstNonEmpty = chunkText.split("\n").find((l) => l.trim().length > 0) ?? "";
  if (DECLARATION_RE.test(firstNonEmpty)) return truncateToTokenLimit(chunkText, 150);
  const declaration = chunkText.split("\n").find((l) => DECLARATION_RE.test(l));
  if (!declaration) return truncateToTokenLimit(chunkText, 150);
  return truncateToTokenLimit(`${declaration.trim()}\n...\n${chunkText}`, 150);
}

const _export: ToolDefinition = tool({
  description:
    "Search the codebase using Beacon hybrid search (semantic embeddings + BM25 + identifier boosting). This tool should be used instead of grep for all code searches as it provides semantic understanding of queries. Set literal=true for exact substring matching (grep-like) against indexed files.",
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
    literal: tool.schema
      .boolean()
      .optional()
      .describe("Exact substring match against indexed file content (like grep). Skips embeddings. Use for finding specific strings, variable names, or error messages."),
  },
  async execute(args, context): Promise<string> {
    try {
      const repoRoot = getBeaconRoot(context.worktree);
      const config = loadConfig(repoRoot);

      const dbPath = join(config.storage.path, "embeddings.db");

      if (!existsSync(dbPath)) {
        return JSON.stringify({
          error: "Index not found. Run 'reindex' tool to create the index.",
          matches: [],
        });
      }

      const cacheOptions = { topK: args.topK, threshold: args.threshold, pathPrefix: args.pathPrefix, noHybrid: args.noHybrid, literal: args.literal };
      const cachedResults = searchCache.get(args.query, cacheOptions);
      if (cachedResults) {
        return JSON.stringify(cachedResults);
      }

      // Literal / direct string search — bypass embeddings entirely
      if (args.literal) {
        const resources = await getCoordinator(context.worktree);
        try {
          const { db } = resources;
          const results = db.literalSearch(
            args.query,
            args.topK ?? 20,
            args.pathPrefix
          );
          const output = JSON.stringify({
            query: args.query,
            mode: "literal",
            matches: results.map((r) => ({
              file: r.filePath,
              lines: `${r.startLine}-${r.endLine}`,
              preview: r.chunkText,
            })),
          });
          searchCache.set(args.query, JSON.parse(output), cacheOptions);
          return output;
        } finally {
          await releaseCoordinator(context.worktree);
        }
      }

      // Acquire a pooled connection — avoids spinning up a new DB + ONNX session
      // on every search call.
      const resources = await getCoordinator(context.worktree);

      try {
        const { db, embedder } = resources;
        const useEmbeddings = config.embedding.enabled !== false;

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
              preview: buildPreview(r.chunkText),
            })),
          });
          searchCache.set(args.query, JSON.parse(output), cacheOptions);
          return output;
        }

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

          // Apply heuristic reranking to improve result ordering.
          // This is pure CPU, zero overhead compared to embedding, and consistently
          // improves precision by combining term overlap, identifier matching, and
          // exact phrase signals on top of the hybrid vector+BM25 scores.
          if (!args.noHybrid && results.length > 1) {
            results = heuristicReranker.rerank(args.query, results);
          }
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
            query: args.query,
            mode: "bm25-fallback",
            warning: `Embedding server unavailable (${embedErrorMsg}), using keyword search`,
            matches: ftsResults.map((r) => ({
              file: r.filePath,
              lines: `${r.startLine}-${r.endLine}`,
              similarity: r.similarity.toFixed(3),
              preview: buildPreview(r.chunkText),
              _note: (r as any)._note,
            })),
          });
          searchCache.set(args.query, JSON.parse(output), cacheOptions);
          return output;
        }

        const output = JSON.stringify({
          query: args.query,
          mode: args.noHybrid ? "vector-only" : "hybrid",
          matches: results.map((r) => ({
            file: r.filePath,
            lines: `${r.startLine}-${r.endLine}`,
            similarity: r.similarity.toFixed(3),
            preview: buildPreview(r.chunkText),
          })),
        });
        searchCache.set(args.query, JSON.parse(output), cacheOptions);
        return output;
      } finally {
        await releaseCoordinator(context.worktree);
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
export default _export;
