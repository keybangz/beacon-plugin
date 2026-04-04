# beacon-opencode

Semantic code search plugin for OpenCode using **hybrid retrieval** (vector embeddings + BM25 + identifier boosting + reciprocal rank fusion).

- **npm package**: `beacon-opencode`
- **Repository**: `beacon-plugin`
- **Current version**: `2.3.0`
- **Development runtime**: **Bun**
- **Plugin entry point**: `beacon.ts` (build output: `dist/beacon.js`)

---

## Installation (for end-users)

```bash
# From npm
npm install beacon-opencode
# Then add "beacon-opencode" to plugins array in opencode.json
```

---

## Build from source

```bash
git clone https://github.com/keybangz/beacon-opencode
cd beacon-opencode
bun install
bun run build
npm pack
# Then install the .tgz into your OpenCode config
```

---

## Development commands

```bash
bun run build       # builds dist/beacon.js + dist/embedder-worker.js (external sourcemaps)
bun test            # run test suite
bun run type-check  # TypeScript type checking
```

> Note: Development in this repo uses **Bun** (`bun install`, `bun run ...`), not npm scripts for local dev workflows.

---

## Tools exposed by Beacon

1. `search` — Hybrid semantic search (vector + BM25 + identifier boosting + RRF)
2. `index` — Visual dashboard with coverage stats
3. `reindex` — Force full rebuild from scratch
4. `status` — Quick health check
5. `config` — View/set configuration values
6. `blacklist` — Manage excluded paths
7. `whitelist` — Allow paths within blacklisted dirs
8. `performance` — Track search speed and cache hit rates
9. `terminate-indexer` — Stop a running index operation
10. `download-model` — Download ONNX embedding models

Supported model options via `download-model`:
- `all-MiniLM-L6-v2` (default)
- `all-MiniLM-L12-v2`
- `paraphrase-MiniLM-L6-v2`
- `codebert-base`
- `unixcoder-base`
- `jina-embeddings-v2-base-code`
- `nomic-embed-text-v1.5`

---

## Event hooks

Beacon registers the following plugin lifecycle hooks:

- `session.created` — Initialize watcher, ensure user config, set up resource pool
- `tool.execute.before` — Pre-execution checks
- `tool.execute.after` — Auto-reindex on `write_file` / `edit_file` / `str_replace_editor`; garbage collect on `rm` / `rmdir` / `git rm` / `git mv`
- `experimental.session.compacting` — Inject index status before compaction

---

## Default configuration

```json
{
  "embedding": { "api_base": "local", "model": "all-MiniLM-L6-v2", "dimensions": 384, "batch_size": 32, "context_limit": 256 },
  "chunking": { "strategy": "hybrid", "max_tokens": 512, "overlap_tokens": 32 },
  "indexing": { "max_file_size_kb": 500, "auto_index": true, "max_files": 10000, "concurrency": 4 },
  "search": { "top_k": 10, "similarity_threshold": 0.35 },
  "storage": { "path": ".opencode/.beacon" }
}
```

Default indexed file types:

- `.ts`, `.tsx`, `.js`, `.jsx`, `.py`, `.go`, `.rs`, `.java`, `.rb`, `.php`, `.sql`, `.md`

---

## Embedding models (`download-model`)

| Model | Dims | Size | Best for |
|-------|------|------|----------|
| all-MiniLM-L6-v2 (default) | 384 | ~90MB | Fast general-purpose baseline |
| all-MiniLM-L12-v2 | 384 | ~134MB | Deeper MiniLM, better quality |
| paraphrase-MiniLM-L6-v2 | 384 | ~90MB | Similar code pattern detection |
| jina-embeddings-v2-base-code | 768 | ~162MB | Best code-specific (int8 quantized, 30 PLs) |
| nomic-embed-text-v1.5 | 768 | ~137MB | High quality, 8192-token context, set query_prefix |
| codebert-base | 768 | ~480MB | NL→code retrieval |
| unixcoder-base | 768 | ~470MB | Code clone detection |

---

## Project structure

```text
beacon-plugin/
├── beacon.ts                    # Plugin entry point
├── src/
│   ├── lib/
│   │   ├── types.ts             # Type definitions
│   │   ├── config.ts            # Config loading, merging, validation
│   │   ├── repo-root.ts         # Git repo root detection
│   │   ├── db.ts                # SQLite + FTS5 database layer
│   │   ├── embedder.ts          # Embedding coordination
│   │   ├── embedder-worker.ts   # Worker thread for embeddings
│   │   ├── onnx-embedder.ts     # Local ONNX runtime embedder
│   │   ├── bert-tokenizer.ts    # BERT WordPiece tokenizer
│   │   ├── chunker.ts           # Token-based + AST-aware chunking
│   │   ├── code-tokenizer.ts    # Code-specific tokenization
│   │   ├── tokenizer.ts         # BM25 / identifier tokenizer
│   │   ├── hnsw.ts              # HNSW vector index (hnswlib-node)
│   │   ├── sync.ts              # IndexCoordinator (incremental sync)
│   │   ├── pool.ts              # Resource pool (DB + embedder + coordinator)
│   │   ├── cache.ts             # SQLite-backed search result cache
│   │   ├── reranker.ts          # Cross-encoder + heuristic reranker
│   │   ├── git.ts               # git ls-files file discovery
│   │   ├── fs-glob.ts           # Fallback glob-based file discovery
│   │   ├── ignore.ts            # .beaconignore pattern parsing
│   │   ├── safety.ts            # Blacklist validation
│   │   ├── watcher.ts           # chokidar file watcher
│   │   ├── hash.ts              # DJB2a hash
│   │   ├── benchmark.ts         # Performance benchmarking
│   │   └── logger.ts            # Structured logger
│   └── tools/
│       ├── search.ts
│       ├── index.ts
│       ├── reindex.ts
│       ├── status.ts
│       ├── config.ts
│       ├── blacklist.ts
│       ├── whitelist.ts
│       ├── performance.ts
│       ├── terminate-indexer.ts
│       └── download-model.ts
├── config/
│   └── beacon.default.json      # Shipped default config
├── scripts/
│   └── setup.cjs                # postinstall setup script
├── tsconfig.build.json          # Declaration-only tsc build config
├── dist/
│   ├── beacon.js                # Bundled plugin entry (bun run build)
│   ├── beacon.js.map            # External source map
│   ├── beacon.d.ts              # TypeScript declarations (tsc --emitDeclarationOnly)
│   ├── embedder-worker.js       # ONNX worker thread bundle
│   └── embedder-worker.js.map   # Worker external source map
└── package.json
```

---

## Troubleshooting

- If you are building from source, use:
  - ✅ `bun run build && reindex`
  - ❌ `npm run build && reindex`
- In development context, use:
  - ✅ `bun install`
  - ❌ `npm install`
- TypeScript configuration currently uses `strict: false` (this is expected for this version).

---

## Contributing

- Use Bun for local workflows (`bun install`, `bun run build`, `bun test`, `bun run type-check`).
- TypeScript must compile without type errors (`bun run type-check` passes).
- Keep docs aligned with the current runtime/build pipeline (Bun-based development, npm distribution for users).

---

## License

MIT
