# Changelog

## [2.4.3] - 2026-04-20

### Fixed
- **LRUCache size tracking bug** (`src/lib/cache.ts`): `set()` was incorrectly incrementing size on key updates (not just new keys). Fixed to only increment `this.stats.size` when inserting a new key.
- **repoFilesCache TTL too short** (`src/lib/git.ts`): Cache TTL was 5000ms causing excessive filesystem/git calls. Increased to 30000ms (30s).
- **hydrateChunkText N+1 query problem** (`src/lib/db.ts`): When hydrating multiple search results, each missing chunk triggered a separate database query. Fixed by batching lookups into a single `VALUES` query.
- **Cache invalidation on index changes** (`src/lib/db.ts`): `insertChunks`, `insertChunksBatch`, and `deleteChunks` now call `clearCache()` after mutations to prevent stale cache reads.

### Added
- **HNSW path pre-filter optimization** (`src/lib/hnsw.ts`): Added `searchWithPathFilterIndexed()` method that uses the `fileToChunkIds` map for efficient path prefix filtering instead of scanning all candidates.
- **Persistent identifier cache** (`src/lib/db.ts`): Made `identifierCache` a persistent class field instead of a local Map per call. Caches `extractIdentifiers()` results across searches and clears on cache invalidation.

### Changed
- **searchWithPathFilterIndexed now used** (`src/lib/db.ts`): Switched from `searchWithPathFilter` (scans all candidates) to `searchWithPathFilterIndexed` (uses fileToChunkIds for O(1) path membership check).
- **Removed dead searchWithPathFilter** (`src/lib/hnsw.ts`): Old method that scanned all candidates after search is removed; only the optimized indexed version remains.

### Removed
- **Dead code: garbageCollect** (`src/lib/sync.ts`): Removed unused `garbageCollect()` method and associated tests. The method was never called anywhere in the codebase and `performDiffSync` already handles orphan cleanup inline.

## [2.4.2] - 2026-04-10

### Fixed
- **Vocab file extension for codebert/unixcoder/jina models** (`src/tools/download-model.ts`): The `vocabUrl` fields for `codebert-base`, `unixcoder-base`, and `jina-embeddings-v2-base-code` incorrectly pointed to `vocab.txt` — these models publish `vocab.json` on HuggingFace. Fixed all three URL strings to use `.json`. The download path now derives the local filename from the URL (rather than hardcoding `vocab.txt`), so future models with non-standard vocab filenames will work correctly without code changes.
- **ONNX embedder hardcoded `vocab.txt` lookup** (`src/lib/onnx-embedder.ts`): `initialize()` only searched for `vocab.txt` and returned an error if not found, causing `codebert-base`, `unixcoder-base`, and `jina-embeddings-v2-base-code` to fail at load time even when correctly downloaded. Fixed: now probes for `vocab.txt` first, falls back to `vocab.json`, with a clear error message if neither exists.

## [2.4.1] - 2026-04-06

### Fixed
- **`[BEACON_NOTIFICATION]` suppression system removed** (`beacon.ts`): The suppression context injected via `client.session.prompt()` on `session.created` was causing all subagent delegations to use the "Build" profile model — `noReply: true` is still broken upstream (GitHub issue #6513, affects `@opencode-ai/sdk` ≤1.3.2) and resets the session model on every call. Removed the entire suppression injection block. Beacon progress messages are sent as plain prompts; the AI may respond to them, which is acceptable.
- **Default embedding model corrected** (`config/beacon.default.json`, `beacon.ts`): Default config and hardcoded fallback both referenced `jina-embeddings-v2-base-code` (768d) — a model that fails to download (404 on the ONNX file). Changed default to `all-MiniLM-L6-v2` (384d), which is reliably available. This prevents dimension mismatch between a freshly-created DB and a new install's config.

## [2.4.0] - 2026-04-06

### Fixed
- **File watcher silent drop** (`src/lib/watcher.ts`, `beacon.ts`): The chokidar file watcher batches events and emits a single `"batch"` event — but `beacon.ts` was registered on individual `"add"`, `"change"`, and `"unlink"` events which the `FileWatcher` class never emits. All file changes were silently dropped. Fixed: replaced three dead individual event listeners with a single `.on("batch", async (eventType, filePaths) => { ... })` handler using `Promise.allSettled` for parallel processing.
- **Path normalization in watcher** (`src/lib/watcher.ts`): chokidar may emit paths with a `./` prefix or as absolute paths. `shouldIndex()` expects repo-relative paths without leading separators. Added normalization in `handleBatchEvent()`: strips `./` prefix and converts absolute paths via `relative(repoRoot, filePath)` before calling `shouldIndex()`.
- **Connection pool double-release** (`beacon.ts`): In `performAutoIndex()` and `checkModelChanged()`, early-return paths inside `try/finally` blocks released the coordinator and returned — but the `finally` guard (`if (pooled)`) fired a second release on the same handle. Fixed by setting `pooled = null` immediately after release in each early-return path.

### Added
- **Automatic embedding model change detection** (`beacon.ts`, `src/lib/sync.ts`): On each new session, Beacon now checks whether the embedding model and dimensions stored in the index (`indexed_model`, `indexed_dimensions` in DB sync_state) match the current config. If they differ, Beacon notifies the user and automatically triggers a forced full reindex so the index stays coherent with the active model. The `indexed_model` and `indexed_dimensions` keys are written to sync_state after every successful full index or diff sync.
- **`[BEACON_NOTIFICATION]` suppression system** (`beacon.ts`): Beacon sends automated progress messages via `client.session.prompt()`. Since OpenCode's `noReply: true` flag does not suppress AI responses (known upstream issue), all Beacon-originated messages are now prefixed with `[BEACON_NOTIFICATION]` and a suppression instruction is injected into the session context at startup. This prevents the AI from responding to indexing status messages.

All notable changes to Beacon will be documented in this file.

## [2.3.2] - 2026-04-04

### Fixed
- **Auto-index race condition** (`beacon.ts`): `initializePlugin()` was calling `performAutoIndex()` in the background before any session existed — the silent-indexing branch ran, set `hasAttemptedAutoIndex = true`, and by the time `session.created` fired the flag was already set so no user-facing progress messages were shown. Removed auto-index from `initializePlugin()`; indexing now triggers exclusively from `session.created` where a valid session ID is available.
- **Session ID extraction order** (`beacon.ts`): Primary extraction path was wrong — now correctly uses `properties?.info?.id` first (per OpenCode SDK), with `properties?.sessionID`, `sessionID`, and `id` as fallbacks.
- **Silent bail on missing session ID** (`beacon.ts`): When session ID could not be extracted, the handler silently returned with no diagnostic. Now logs a structured `warn` via `client.app.log()` before returning.
- **`hasAttemptedAutoIndex` flag timing** (`beacon.ts`): Flag was set to `true` after `await performAutoIndex()` resolved — a second `session.created` event (e.g. user opens new session mid-index) could trigger a duplicate index run. Flag is now set before the async call.
- **Non-standard `synthetic: true` on message parts** (`beacon.ts`): `synthetic: true` is not in the `@opencode-ai/plugin` SDK schema and was silently dropped or caused failures. Removed from all `client.session.prompt()` parts.

### Improved
- **Plugin load visibility** (`beacon.ts`): Added structured `info` log via `client.app.log()` after plugin initialisation completes, showing whether auto-index is armed or disabled (no git repo detected). Visible in OpenCode structured logs.

## [2.3.1] - 2026-04-04

### Fixed
- **HNSW entries persistence** (`src/lib/hnsw.ts`): `saveToDisk()` was writing the JSON entries data to `hnsw.index.tmp` then renaming it over the binary index file — causing `hnsw.index` to be corrupted with JSON content and `hnsw.entries.json` to never be written. Fixed: binary index is written directly via `writeIndex()`, JSON entries are written to `hnsw.entries.json.tmp` then atomically renamed to `hnsw.entries.json`. HNSW index now persists across restarts correctly.
- **Similarity scores clamped to 1.000** (`src/lib/db.ts`): `hybridSearch()` normalised scores against a per-result theoretical ceiling that did not account for `fileTypeMultiplier` (1.2× for `.ts` files) or `identifierBoost` — every `.ts` result exceeded the ceiling and was clamped to 1.0. Fixed: two-pass normalization, `similarity = rrfScore / maxRrf`, correctly spans the full [0,1] range.

### Packaging
- **postinstall** (`scripts/setup.cjs`): postinstall script now runs `npm install` for `hnswlib-node` and `onnxruntime-node` if their native binaries are not present in the install location — ensures native deps are available regardless of how the package is installed.
- **GitHub release** (`.github/workflows/release.yml`): packed `.tgz` tarball is now attached as a release asset on every GitHub release.

## [2.3.0] - 2026-04-04

### Fixed
- **Grep interception** (`beacon.ts`): `tool.execute.before` grep replacement was dead code — now properly wired to run semantic search and rewrite shell command output
- **Zero-vector search** (`beacon.ts`): `executeGrepReplacement` was passing an all-zeros embedding to `db.search()` instead of a real query embedding; now calls `embedder.embedQuery(query)`
- **Garbage collection** (`beacon.ts`): Per-file chunk deletion now calls `db.deleteChunks(filePath)` for each removed file before running `coordinator.garbageCollect()` once
- **Session ID extraction** (`beacon.ts`): Defensive fallback chain handles varied OpenCode event shapes
- **Invalid SDK field** (`beacon.ts`): Removed `ignored: true` from `session.prompt()` parts — not in OpenCode SDK schema, was silently dropped
- **Config asset path** (`beacon.ts`): Default config now correctly resolved relative to package root, not `dist/`
- **Type errors** (`src/lib/db.ts`): Fixed TS2345 spread-args cast for `bun:sqlite` `stmt.all()` calls

### Improved
- **Search accuracy** (`src/lib/hnsw.ts`): Dynamic ef_search tuning per query (`ef = max(k×4, 50)`) with save/restore in `finally` to prevent state leak between searches
- **Query expansion** (`src/lib/tokenizer.ts`): CamelCase splitting, identifier variant generation, auth/error/config synonym expansion; FTS5 input sanitized and terms double-quoted to prevent syntax errors
- **Search result previews** (`src/tools/search.ts`): `buildPreview` helper prepends nearest declaration context line to mid-block chunks

### Packaging
- **Worker thread ONNX** (`package.json`): `embedder-worker.ts` now built as a separate entry to `dist/embedder-worker.js` — worker-thread ONNX path was previously non-functional in installed packages
- **Source maps** (`package.json`): Switched from `--sourcemap=inline` to `--sourcemap=external`; bundle size reduced ~50%, source no longer embedded in published artifact
- **Type declarations** (`tsconfig.build.json`, `package.json`): `dist/beacon.d.ts` now generated via `tsc --emitDeclarationOnly` and published — TypeScript consumers get proper types
- **Runtime engine** (`package.json`): Removed misleading `engines.node` — package requires Bun at runtime (uses `bun:sqlite`)

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
