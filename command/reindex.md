Use the `reindex` tool to force a complete rebuild of the Beacon semantic search index from scratch.

## Parameters
- `confirm` (required): Must be set to `true` to proceed — prevents accidental full reindex

## Examples
- Full reindex: `confirm=true`

## When to use
- After adding/removing many files
- After changing the embedding model in config
- If search results seem stale or incorrect
- After upgrading the plugin to a new version
- If the index appears corrupt (use `/status` to check)

## Output
Returns a summary with:
- Files indexed count
- Total chunks created
- Database size in MB
- Duration in seconds
- Current sync status

## Notes
- Deletes the existing index and rebuilds from scratch — can take 10–60 seconds for large repos
- Live progress notifications are sent at 25%, 50%, 75%, and 100% milestones
- Does not require stopping other operations first
