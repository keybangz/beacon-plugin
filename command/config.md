Use the `config` tool to view, update, or reset Beacon's configuration settings.

## Parameters
- `action` (required): `"view"` to read settings, `"set"` to update a key, `"reset"` to delete the config file and restore defaults
- `key` (optional, required for `set`): Dot-notation config key (e.g. `embedding.model`)
- `value` (optional, required for `set`): New value for the key
- `scope` (optional): `"project"` (default) or `"global"` — which config file to read/write

## Examples
- View all settings: `action="view"`
- View a single key: `action="view", key="embedding.model"`
- View global settings: `action="view", scope="global"`
- Change top-k results: `action="set", key="search.top_k", value="20"`
- Change similarity threshold: `action="set", key="search.similarity_threshold", value="0.5"`
- Switch embedding model: `action="set", key="embedding.model", value="jina-embeddings-v2-base-code"`
- Set concurrency: `action="set", key="indexing.concurrency", value="8"`
- Reset broken project config: `action="reset", scope="project"`
- Reset global config to defaults: `action="reset", scope="global"`

## Common Config Keys
| Key | Default | Description |
|-----|---------|-------------|
| `embedding.model` | `jina-embeddings-v2-base-code` | Embedding model name or path |
| `embedding.dimensions` | `768` | Vector dimensions (must match model output) |
| `embedding.context_limit` | `512` | Max tokens per chunk sent to the model |
| `embedding.batch_size` | `32` | Embedding batch size |
| `embedding.execution_provider` | `cpu` | ONNX provider: `cpu`, `cuda`, `rocm`, `webgpu` |
| `search.top_k` | `10` | Max results per search |
| `search.similarity_threshold` | `0.35` | Minimum score to include a result (0.0–1.0) |
| `search.hybrid.weight_vector` | `0.4` | Weight for semantic vector similarity |
| `search.hybrid.weight_bm25` | `0.3` | Weight for BM25 keyword match |
| `search.hybrid.weight_rrf` | `0.3` | Weight for RRF normalization |
| `search.hybrid.identifier_boost` | `1.5` | Score multiplier for identifier matches |
| `indexing.auto_index` | `true` | Auto-index on session start |
| `indexing.concurrency` | `8` | Parallel indexing workers |
| `indexing.max_files` | `10000` | Max files to index |
| `indexing.max_file_size_kb` | `500` | Skip files larger than this |
| `chunking.max_tokens` | `512` | Max tokens per chunk |
| `chunking.overlap_tokens` | `32` | Token overlap between adjacent chunks |

## Config File Locations
- **Project**: `.opencode/beacon.json` in the current repo root
- **Global**: `~/.config/beacon/config.json` (applies to all projects)
- Project config overrides global; global overrides built-in defaults

## Notes
- After changing `embedding.model` or `embedding.dimensions`, run `/reindex` to rebuild the index
- Use `action="reset"` to recover from a broken or outdated project config without manually deleting files
- Array values (e.g. `indexing.include`) can be set with JSON: `value='["**/*.ts","**/*.py"]'`
