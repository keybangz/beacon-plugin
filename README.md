# Beacon OpenCode Plugin

**Turn OpenCode into Cursor** — Semantic code search that understands your codebase. Find code by meaning, not just string matching.

This is a complete port of the Beacon plugin from Claude Code to OpenCode, featuring hybrid search (semantic embeddings + BM25 keyword matching + identifier boosting).

## Features

- **Hybrid Search** — Combines vector embeddings, BM25 keyword matching, and identifier boosting for best results
- **Smart Indexing** — Full index on first run, diff-based catch-up on subsequent syncs
- **Auto-Sync** — Hooks auto-embed changed files and garbage collect deleted ones
- **Graceful Degradation** — Falls back to keyword-only search if embedding server is down
- **Pluggable Embeddings** — Ollama (local/free), OpenAI, Voyage AI, LiteLLM, or any OpenAI-compatible API
- **Strict TypeScript** — Fully typed with `strict: true` for reliability

## Quick Start

### 1. Install Ollama (for local embeddings)

```bash
brew install ollama
ollama serve &
ollama pull nomic-embed-text
```

### 2. Clone this repository

```bash
git clone https://github.com/sagarmk/beacon-opencode
cd beacon-opencode
```

### 3. Add to OpenCode

Add this to your `.opencode/opencode.json`:

```json
{
  "plugins": ["./beacon-opencode"]
}
```

Or install from npm once published:

```json
{
  "plugins": ["opencode-beacon"]
}
```

### 4. Start OpenCode

```bash
opencode
```

Beacon will automatically:
1. Install dependencies (first run only)
2. Index your codebase in the background
3. Enable semantic search via the `search` tool

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
beacon-opencode/
├── .opencode/
│   ├── opencode.json           # Plugin config
│   ├── package.json            # Dependencies for tools
│   ├── plugins/
│   │   └── beacon.ts           # Main plugin with event hooks
│   └── tools/
│       ├── search.ts           # Search tool
│       ├── index.ts            # Index dashboard
│       ├── status.ts           # Quick status
│       ├── reindex.ts          # Full rebuild
│       ├── config.ts           # Config management
│       ├── blacklist.ts        # Exclude patterns
│       └── whitelist.ts        # Include patterns
├── src/
│   └── lib/
│       ├── types.ts            # TypeScript interfaces
│       ├── db.ts               # SQLite + vector search (TODO)
│       ├── tokenizer.ts        # BM25 + RRF algorithms
│       ├── chunker.ts          # Code chunking
│       ├── embedder.ts         # Embedding API coordination
│       ├── config.ts           # Config loading + merging
│       ├── git.ts              # File discovery
│       ├── ignore.ts           # Pattern matching
│       ├── repo-root.ts        # .git detection
│       └── safety.ts           # Blacklist validation
├── config/
│   └── beacon.default.json     # Default configuration
├── package.json
└── tsconfig.json
```

### Event Hooks

- **`session.created`** — Full or diff-based indexing on session start
- **`file.edited`** — Re-embed changed files
- **`tool.execute.after`** — Garbage collect deleted files (after bash)
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

## Configuration

### Default Configuration

See `config/beacon.default.json`:

```json
{
  "embedding": {
    "api_base": "http://localhost:11434/v1",
    "model": "nomic-embed-text",
    "dimensions": 768,
    "batch_size": 10,
    "query_prefix": "search_query: "
  },
  "chunking": {
    "strategy": "hybrid",
    "max_tokens": 512,
    "overlap_tokens": 50
  },
  "indexing": {
    "include": ["**/*.ts", "**/*.tsx", "**/*.js", ...],
    "exclude": ["node_modules/**", "dist/**", ...],
    "max_file_size_kb": 500,
    "auto_index": true,
    "max_files": 10000,
    "concurrency": 4
  },
  "search": {
    "top_k": 10,
    "similarity_threshold": 0.35,
    "hybrid": {
      "weight_vector": 0.4,
      "weight_bm25": 0.3,
      "weight_rrf": 0.3,
      "identifier_boost": 1.5
    }
  },
  "storage": {
    "path": ".opencode/.beacon"
  }
}
```

### Per-Repo Overrides

Create `.opencode/beacon.json`:

```json
{
  "embedding": {
    "api_base": "https://api.openai.com/v1",
    "model": "text-embedding-3-small",
    "api_key_env": "OPENAI_API_KEY",
    "dimensions": 1536
  },
  "indexing": {
    "include": ["**/*.py"],
    "max_files": 5000
  }
}
```

## Development

### Setup

```bash
npm install
npm run build          # Build TypeScript
npm run type-check    # Check types
npm test              # Run tests
```

### Code Style

- **TypeScript** with `strict: true`
- **Functional programming** — prefer pure functions, immutability
- **Explicit return types** for all public functions
- **No `any` types** — use `unknown` or proper typing
- **Inline comments** for complex logic and business rules

## Implementation Status

- ✅ Type definitions and interfaces
- ✅ Configuration management (loading, merging, validation)
- ✅ File discovery (git integration)
- ✅ Pattern matching (glob support)
- ✅ Code chunking (token-based with overlap)
- ✅ Tokenization (BM25, identifier extraction, RRF)
- ✅ Embedding coordination (with retry logic)
- ✅ Safety checks (blacklist validation)
- ⏳ Database layer (SQLite + vector search) — TODO
- ⏳ Search implementation — TODO
- ⏳ Tool implementations — TODO
- ⏳ Plugin hooks (sync, embedding, GC) — TODO

## Troubleshooting

### Embedding server unreachable

Start Ollama:

```bash
ollama serve &
ollama pull nomic-embed-text
```

### Index corrupted

Force rebuild:

```
reindex
```

### Change embedding model

1. Install new model: `ollama pull mxbai-embed-large`
2. Update config: `.opencode/beacon.json`
3. Rebuild: `reindex`

## License

MIT — See LICENSE file

## Contributing

Contributions welcome! Please ensure:

1. All TypeScript compiles with strict mode
2. No `any` types
3. Tests pass
4. Code follows the functional programming guidelines

## Related

- [Beacon for Claude Code](https://github.com/sagarmk/Claude-Code-Beacon-Plugin) — Original plugin
- [OpenCode Docs](https://opencode.ai/docs) — OpenCode documentation
- [Ollama](https://ollama.com) — Local LLMs and embeddings
