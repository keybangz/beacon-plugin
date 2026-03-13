# Beacon OpenCode Plugin

**Turn OpenCode into Cursor** — Semantic code search that understands your codebase. Find code by meaning, not just string matching.

Beacon is a semantic search plugin for OpenCode, featuring hybrid search (semantic embeddings + BM25 keyword matching + identifier boosting).

## Features

- **Hybrid Search** — Combines vector embeddings, BM25 keyword matching, and identifier boosting for best results
- **Smart Indexing** — Full index on first run, diff-based catch-up on subsequent syncs
- **Auto-Sync** — Hooks auto-embed changed files and garbage collect deleted ones
- **Graceful Degradation** — Falls back to keyword-only search if embedding server is down
- **Pluggable Embeddings** — Ollama (local/free), OpenAI, Voyage AI, LiteLLM, or any OpenAI-compatible API
- **Strict TypeScript** — Fully typed with `strict: true` for reliability
- **Safe Chunking** — 80% safety margin with character-level truncation to prevent context errors
- **Graceful Termination** — Stop indexing operations with `terminate-indexer` tool

## Quick Start

### 1. Install Ollama (for local embeddings)

```bash
brew install ollama
ollama serve &
ollama pull all-minilm:22m
```

> **Tip**: The default `all-minilm:22m` model has a 256-token context limit. Adjust your `context_limit` in config if using a different model.

### 2. Clone this repository

```bash
git clone https://github.com/keybangz/beacon-plugin
cd beacon-plugin
```

### 3. Build the Plugin

```bash
npm install
npm run build
```

### 4. Add to OpenCode

Copy the `.opencode/` directory from this repo into your project root, or add the plugin path to your project's `.opencode/opencode.json`:

```json
{
  "plugin": ["./path/to/beacon-plugin/.opencode/plugins/beacon.ts"]
}
```

### 5. Search Your Code

```bash
# Initialize index
opencode reindex

# Search semantically
opencode search "authentication flow"
```

## Documentation

- **[SETUP_OPENCODE.md](./SETUP_OPENCODE.md)** — Complete setup and usage guide for installing Beacon with OpenCode
- **[EXAMPLES.md](./EXAMPLES.md)** — Real-world usage examples and workflows

## Tools

### Search

```
search "authentication flow"
```

Hybrid search combining semantic similarity, BM25 keyword matching, and identifier boosting.

**Options:**
- `topK` — Number of results (default: 10)
- `threshold` — Minimum score cutoff (default: 0.35)
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
│   ├── src/
│   │   └── lib/              # Compiled JavaScript (output of npm run build)
│   │       ├── chunker.js
│   │       ├── sync.js
│   │       ├── embedder.js
│   │       └── ...
│   ├── tools/                # OpenCode tools (import compiled .js files)
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
├── src/lib/                  # TypeScript source
│   ├── types.ts
│   ├── db.ts
│   ├── tokenizer.ts
│   ├── chunker.ts
│   ├── embedder.ts
│   ├── config.ts
│   ├── git.ts
│   ├── ignore.ts
│   ├── repo-root.ts
│   └── safety.ts
├── config/
│   └── beacon.default.json   # Default configuration
├── package.json
└── tsconfig.json
```

### Event Hooks

- **`tool.execute.after`** — Auto-reindex changed files (write_file, edit_file, str_replace_editor); garbage collect deleted files (rm, rmdir, git rm, git mv)
- **`experimental.session.compacting`** — Inject index status before compaction
- **`shell.env`** — Inject environment variables

### Technology Stack

- **Database** — SQLite with WAL mode
- **Vector Search** — sqlite-vec (cosine distance)
- **Full-Text Search** — FTS5 with porter stemmer
- **Ranking** — RRF combining vector + BM25 + identifier matching
- **Embeddings** — OpenAI-compatible API (Ollama, OpenAI, Voyage AI, etc.)
- **File Scanning** — Git-based (git ls-files)
- **Pattern Matching** — picomatch for glob patterns

## Implementation Status

- ✅ Type definitions and interfaces
- ✅ Configuration management (loading, merging, validation)
- ✅ File discovery (git integration)
- ✅ Pattern matching (glob support)
- ✅ Code chunking (token-based with overlap, 80% safety margin, character-level truncation)
- ✅ Tokenization (BM25, identifier extraction, RRF)
- ✅ Embedding coordination (with retry logic)
- ✅ Safety checks (blacklist validation, terminate-indexer with DB flag)
- ✅ Database layer (SQLite + FTS5)
- ✅ Tool implementations (search, index, status, reindex, config, blacklist, whitelist, performance, terminate-indexer)
- ✅ Auto-sync hooks (incremental re-embedding, garbage collection)
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
