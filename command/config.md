Use the `config` tool to view or update Beacon's configuration settings.

## Parameters
- `action` (required): `"view"` to read settings, `"set"` to update a setting
- `key` (optional, required for `set`): Dot-notation config key to update (e.g. `embedding.model`)
- `value` (optional, required for `set`): New value for the key
- `scope` (optional): `"project"` (default) or `"global"` — which config file to read/write

## Examples
- View all settings: `action="view"`
- View global settings: `action="view", scope="global"`
- Change top-k results: `action="set", key="search.top_k", value="20"`
- Change similarity threshold: `action="set", key="search.similarity_threshold", value="0.5"`
- Switch embedding model: `action="set", key="embedding.model", value="all-MiniLM-L6-v2"`
- Set concurrency: `action="set", key="indexing.concurrency", value="8"`

## Common Config Keys
| Key | Default | Description |
|-----|---------|-------------|
| `embedding.model` | `jina-embeddings-v2-base-code` | Embedding model name |
| `embedding.dimensions` | `768` | Vector dimensions (must match model) |
| `search.top_k` | `10` | Max results per search |
| `search.similarity_threshold` | `0.35` | Minimum score to include result |
| `search.hybrid.vector_weight` | `0.6` | Weight for semantic similarity |
| `search.hybrid.bm25_weight` | `0.3` | Weight for keyword match |
| `indexing.auto_index` | `true` | Auto-index on session start |
| `indexing.concurrency` | `4` | Parallel indexing workers |
| `indexing.max_files` | `10000` | Max files to index |

## Notes
- Project config is stored at `.opencode/beacon.json` in the current worktree
- Global config is at `~/.config/opencode/beacon.json`
- After changing `embedding.model` or `dimensions`, run `/reindex` to rebuild
