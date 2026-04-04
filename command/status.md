Use the `status` tool to display the current state of the Beacon search index.

## Parameters
None required.

## Output
Returns:
- **Sync status**: `idle`, `indexing`, or `error`
- **Files indexed**: number of files currently in the index
- **Total chunks**: number of semantic chunks stored
- **Database size**: size of the vector database in MB
- **Model info**: active embedding model name and dimensions
- **Last sync time**: when the index was last updated
- **Indexer running**: whether background indexing is active

## Examples
- Check index health: (no parameters needed)

## When to use
- Before running searches to confirm the index is ready
- After a reindex to verify completion
- To diagnose why search results are missing or stale
- To see which embedding model is active
