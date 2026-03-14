# Changelog

All notable changes to Beacon will be documented in this file.

## [2.1.0] - 2025-03-14

### Added
- **Query Expansion** - Semantic query expansion with code synonyms
  - Maps "auth" → "authentication", "login", "signin", "credential"
  - CamelCase splitting for better identifier matching
  - Extracts code terms (functions, classes, variables)

- **Semantic Chunking** - AST-aware code chunking
  - Detects functions, classes, interfaces at semantic boundaries
  - Falls back to token-based chunking for unstructured code
  - Configurable via `chunking.strategy: "hybrid"`

- **BERT WordPiece Tokenizer** - Proper tokenization for BERT models
  - Loads vocabulary from vocab.txt
  - Accent stripping and punctuation splitting
  - Used by ONNX embedder for better tokenization

- **Code-Specific Models** - Support for CodeBERT and UniXcoder
  - BPE-based tokenizer for code models
  - Different pooling strategies per model type
  - Downloadable models: codebert-base, unixcoder-base

- **Reranking** - Improved result ranking
  - Cross-encoder reranking for top-K results
  - Heuristic reranking (term overlap, identifier matching)
  - Configurable reranking in search config

- **Persistent Cache** - Search results cached in SQLite
  - Survives across OpenCode invocations
  - Tracks hits/misses/statistics
  - 5-minute TTL

- **Performance Metrics** - Track search performance
  - Metrics stored in SQLite (metrics table)
  - Tracks search_time, cached searches
  - Viewable via `performance metrics`

### Changed
- Default threshold changed from 0.35 to 0.01
- Default max_tokens changed from 256 to 512
- Default embedding model: all-MiniLM-L6-v2 (384 dims)
- Default api_base: "local" (ONNX)

## [2.0.0] - 2025-03-14

### Added
- **HNSW Index** - O(log n) approximate nearest neighbor search using hnswlib-node
  - Persistent index stored at `.beacon/hnsw.index`
  - Automatic fallback to brute-force if HNSW fails
  - Configurable via `useHNSW` parameter in database

- **ONNX Local Embeddings** - Zero HTTP latency embeddings
  - Uses onnxruntime-node for local inference
  - No external API calls required
  - Enable via `api_base: "local"` in config
  - Includes SimpleTokenizer for basic tokenization

- **Real-time File Watcher** - Automatic incremental indexing
  - Uses chokidar for file system monitoring
  - Auto-indexes new/changed files
  - Auto-removes deleted files from index
  - Debounced to prevent rapid re-indexing

- **Grep Tool Replacement** - Seamlessly replaces OpenCode's built-in grep
  - Registered as both `grep` and `search` tools
  - Semantic search by default
  - Maintains grep-like interface

### Changed
- Removed `better-sqlite3` dependency (uses Bun's built-in `bun:sqlite`)
- Removed `@types/chokidar` (chokidar v5 has built-in types)
- Updated package.json for NPM publishing with proper `peerDependencies`
- Enhanced README with new features and installation options

### Technical Details
- Database now supports HNSW parameter in `openDatabase()`
- Embedder tracks mode (local vs API) for proper error handling
- Plugin properly handles file watcher lifecycle
- All 182 tests passing

## [1.0.0] - 2024-XX-XX

### Added
- Initial release
- Hybrid search (semantic + BM25 + identifier boosting)
- SQLite with FTS5 for full-text search
- Auto-sync hooks for file changes
- Support for multiple embedding providers (Ollama, OpenAI, Voyage AI, etc.)
- Configuration management
- Blacklist/whitelist support
- Performance metrics
