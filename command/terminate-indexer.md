Use the `terminateIndexer` tool to immediately stop any running background indexing operation.

## Parameters
None required.

## Examples
- Stop indexing: (no parameters needed)

## When to use
- Indexing is taking too long and you need the system resources
- A reindex appears stuck or frozen (check with `/status`)
- You want to cancel an in-progress auto-index before starting a manual one

## Output
Returns confirmation that the indexer was stopped, or a message if no indexer was running.

## Notes
- Safe to run at any time — will not corrupt the existing index
- Partially-indexed files are discarded; the existing index remains intact
- After termination, run `/reindex` to rebuild from a clean state if needed
