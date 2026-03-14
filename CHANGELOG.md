# Changelog

All notable changes to Beacon will be documented in this file.

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
