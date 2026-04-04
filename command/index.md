Use the `index` tool to display the Beacon index dashboard with optional file listing.

## Parameters
- `files` (optional): Set `true` to include the full list of indexed files in the output

## Output
Returns a dashboard including:
- Files indexed count
- Total chunks
- Embedding model and vector dimensions
- Sync status and whether the indexer is running
- Coverage percentage (files indexed / total files)
- When `files=true`: complete list of all indexed file paths

## Examples
- Dashboard only: (no parameters)
- With file list: `files=true`

## Notes
- This tool shows index state — it does NOT trigger indexing
- Use `/reindex` to rebuild the index, `/status` for a quick health check
