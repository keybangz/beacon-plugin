# Beacon OpenCode Plugin

**Semantic grep replacement for OpenCode** — Search code by meaning, not just string matching. Beacon replaces the built-in grep tool with hybrid semantic search (embeddings + BM25 + identifier boosting).

## Features

- **Grep Replacement** — Seamlessly replaces OpenCode's grep with semantic search
- **Hybrid Search** — Combines vector embeddings, BM25 keyword matching, and identifier boosting
- **HNSW Index** — O(log n) approximate nearest neighbor search for fast vector queries
- **Local ONNX Embeddings** — Zero-latency embeddings using onnxruntime-node (no HTTP calls)
- **Query Expansion** — Semantic expansion with code synonyms (e.g., "auth" → "authentication", "login")
- **Semantic Chunking** — AST-aware chunking at function/class boundaries
- **BERT Tokenizer** — Proper WordPiece tokenization for BERT-based models
- **Code-Specific Models** — Support for CodeBERT and UniXcoder models
- **Reranking** — Cross-encoder and heuristic reranking for improved results
- **Real-time Sync** — File watcher auto-indexes changes as you code
- **Auto-Sync Hooks** — Auto-reindex changed files, garbage collect deleted ones
- **Graceful Degradation** — Falls back to keyword-only search if embedding server is down
- **Persistent Cache** — Search results cached in SQLite for instant repeat queries
- **Performance Metrics** — Track search speed and cache hit rates
- **Pluggable Embeddings** — ONNX (local), Ollama (local/free), OpenAI, Voyage AI, LiteLLM, or any OpenAI-compatible API
- **Strict TypeScript** — Fully typed with `strict: true` for reliability
- **Safe Chunking** — 80% safety margin with character-level truncation

## Quick Start

```bash
git clone https://github.com/keybangz/beacon-opencode
cd beacon-opencode
npm install
npm run build
npm pack
```

```bash
cd ~/.config/opencode
npm install ./path-to-packed-plugin.tgz
```

Add `beacon-opencode` to your `plugin` array in `opencode.json`.

### Configure Embeddings

**Option 1: Local ONNX (Zero HTTP latency)** - This is the default, no configuration file needed.
```json
// .opencode/beacon.json
{
  "embedding": {
    "api_base": "local"
  }
}
```

**Option 2: Ollama (Local/Free)**
```bash
brew install ollama
ollama serve &
ollama pull all-minilm:22m
```

**Option 3: OpenAI/Voyage/etc.**
```json
{
  "embedding": {
    "api_base": "https://api.openai.com/v1",
    "api_key": "your-key",
    "model": "text-embedding-3-small"
  }
}
```

### Search Your Code

```
# Initialize index
reindex

# Search semantically (replaces grep)
search "authentication flow"
search "database connection logic"
search "error handling in API"



## Tools

### Search

```
search "authentication flow"
```

Hybrid search combining semantic similarity, BM25 keyword matching, and identifier boosting.

**Options:**
- `topK` — Number of results (default: 10)
- `threshold` — Minimum score cutoff (default: 0.01)
- `pathPrefix` — Scope results to a directory
- `noHybrid` — Use pure vector search only

### Indexing

```
status          # Quick health check
index           # Visual dashboard with coverage
reindex         # Force full rebuild from scratch
terminate-indexer  # Stop a running index operation
```

### Configuration

```
config view                          # View current config
config set embedding.model llama2    # Change embedding model
blacklist list                       # Show blacklisted dirs
 blacklist add ./secrets              # Exclude from indexing
 whitelist add ./vendor/important     # Allow in blacklisted dir
```

## Architecture

### Project Structure

```
beacon-plugin/
├── .opencode/
│   ├── tools/                # OpenCode tools
│   │   ├── search.ts
│   │   ├── index.ts
│   │   ├── status.ts
│   │   ├── reindex.ts
│   │   ├── config.ts
│   │   ├── blacklist.ts
│   │   ├── whitelist.ts
│   │   ├── performance.ts
│   │   └── terminate-indexer.ts
│   └── plugins/
│       └── beacon.ts         # Plugin entry point with event hooks
├── src/
│   └── lib/                  # TypeScript source
│       ├── types.ts
│       ├── db.ts
│       ├── config.ts
│       ├── repo-root.ts
│       ├── chunker.ts
│       ├── embedder.ts
│       ├── hnsw.ts
│       ├── cache.ts
│       ├── reranker.ts
│       ├── tokenizer.ts
│       ├── git.ts
│       ├── ignore.ts
│       ├── safety.ts
│       └── watcher.ts
├── dist/                     # Bundled plugin (output of npm run build)
│   └── index.js
├── package.json
└── README.md
```

### Event Hooks

- **`tool.execute.after`** — Auto-reindex changed files (write_file, edit_file, str_replace_editor); garbage collect deleted files (rm, rmdir, git rm, git mv)
- **`experimental.session.compacting`** — Inject index status before compaction
- **`shell.env`** — Inject environment variables

### Technology Stack

- **Database** — SQLite with WAL mode
- **Vector Search** — HNSW (hnswlib-node) for O(log n) approximate nearest neighbor
- **Full-Text Search** — FTS5 with porter stemmer
- **Ranking** — RRF combining vector + BM25 + identifier matching
- **Embeddings** — ONNX local (default), OpenAI-compatible API (Ollama, OpenAI, Voyage AI, etc.)
- **File Scanning** — Git-based (git ls-files)
- **Pattern Matching** — picomatch for glob patterns

## Implementation Status

- ✅ Type definitions and interfaces
- ✅ Configuration management (loading, merging, validation)
- ✅ File discovery (git integration)
- ✅ Pattern matching (glob support)
- ✅ Code chunking (token-based with overlap, 80% safety margin, character-level truncation)
- ✅ Semantic chunking (AST-aware at function/class boundaries)
- ✅ Tokenization (BM25, identifier extraction, RRF)
- ✅ Query expansion (code synonyms, camelCase splitting)
- ✅ Embedding coordination (with retry logic)
- ✅ ONNX local embeddings (zero HTTP latency)
- ✅ BERT WordPiece tokenizer
- ✅ CodeBERT/UniXcoder support
- ✅ Reranking (cross-encoder + heuristic)
- ✅ Safety checks (blacklist validation, terminate-indexer with DB flag)
- ✅ Database layer (SQLite + FTS5)
- ✅ HNSW vector index
- ✅ Persistent search cache
- ✅ Performance metrics tracking
- ✅ Tool implementations (search, index, status, reindex, config, blacklist, whitelist, performance, terminate-indexer)
- ✅ Auto-sync hooks (incremental re-embedding, garbage collection)
- ✅ File watcher for real-time indexing
- ✅ Progress reporting with DB state tracking

## Troubleshooting

### Embedding server unreachable

Start Ollama:

```bash
ollama serve &
ollama pull all-minilm:22m
```

### "Input length exceeds context length" errors

This usually means `context_limit` in config exceeds the model's actual context window:

1. Check model context: `ollama show <model_name> | grep context_length`
2. Set `context_limit` in `.opencode/beacon.json` to match (e.g., 256 for all-minilm:22m)
3. Rebuild and reindex: `npm run build && reindex`

Beacon automatically applies an 80% safety margin, so set `context_limit` to the model's max, not the desired chunk size.

### Index corrupted

Force rebuild:

```
reindex
```

### Change embedding model

1. Install new model: `ollama pull mxbai-embed-large`
2. Update config: `.opencode/beacon.json` with correct dimensions
3. Rebuild: `npm run build && reindex`

## License

MIT — See LICENSE file

## Contributing

Contributions welcome! Please ensure:

1. All TypeScript compiles with strict mode
2. No `any` types
3. Tests pass
4. Code follows the functional programming guidelines

## Related

- [OpenCode Docs](https://opencode.ai/docs) — OpenCode documentation
- [Ollama](https://ollama.com) — Local LLMs and embeddings
