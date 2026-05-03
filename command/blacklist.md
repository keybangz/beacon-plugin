Use the `blacklist` tool to manage file/directory patterns that Beacon will exclude from indexing.

## Parameters
- `action` (required): `"list"` to show current patterns, `"add"` to add a pattern, `"remove"` to remove a pattern
- `path` (optional, required for `add`/`remove`): Glob pattern to add or remove

## Examples
- List current blacklist: `action="list"`
- Exclude a directory: `action="add", path="vendor/**"`
- Exclude file type: `action="add", path="**/*.min.js"`
- Exclude secrets: `action="add", path="**/*.env"`
- Remove exclusion: `action="remove", path="vendor/**"`

## Default Excluded Patterns
The following are excluded by default (via `.beaconignore`):
- `node_modules/`, `dist/`, `build/`, `.git/`
- Binary files: `*.png`, `*.jpg`, `*.zip`, `*.exe`, etc.
- Lock files: `package-lock.json`, `yarn.lock`, `bun.lock`

## Notes
- Patterns use glob syntax (same as `.gitignore`)
- After adding/removing patterns, run `/reindex` to apply changes
- Per-project patterns are stored in `.opencode/blacklist.json` (managed by this tool — do not edit manually)
- Use `/whitelist` to force-include paths that match blacklist patterns
