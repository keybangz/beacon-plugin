Use the `whitelist` tool to force-include specific files or directories in the Beacon index, even if they match blacklist patterns.

## Parameters
- `action` (required): `"list"` to show current patterns, `"add"` to add a pattern, `"remove"` to remove a pattern
- `path` (optional, required for `add`/`remove`): Glob pattern to add or remove

## Examples
- List current whitelist: `action="list"`
- Force-include a directory: `action="add", path="vendor/my-custom-lib/**"`
- Include specific file type in excluded dir: `action="add", path="dist/types.d.ts"`
- Remove override: `action="remove", path="vendor/my-custom-lib/**"`

## Notes
- Whitelist takes precedence over blacklist
- After changes, run `/reindex` to apply
- Patterns use glob syntax
