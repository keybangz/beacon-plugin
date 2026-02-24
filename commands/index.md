---
description: Visual overview of Beacon index — files, chunks, coverage, provider
allowed-tools: [Bash]
---

# /index

Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/index-info.js` and format the JSON output as a rich visual dashboard using Unicode box-drawing characters. This output is ALWAYS viewed in a CLI terminal — never use markdown tables.

## Visual Style

Use **rounded box-drawing characters** (`╭ ╮ ╰ ╯ │ ─`) to frame each section. Content inside boxes is indented with 3 spaces after `│`. Section titles appear inline in the top border: `╭── Title ───────╮`.

CRITICAL: Never use markdown table syntax (`| col | col |` or `|---|---|`). Use box-framed, space-padded aligned columns.

**Box width:** All boxes should be the same width — 55 characters from `╭` to `╮`. Pad the top/bottom borders with `─` and content lines with spaces to fill the width. The last character before `│` on each line should be a space.

**Progress/coverage bars** appear OUTSIDE boxes, indented with 4 spaces.

---

### If `status` is `"no_index"`:

```
╭── 📊 Beacon Index — Not Initialized ─────────────────╮
│   {config.model} · {config.provider_description}      │
│   {config.dimensions} dims                            │
╰───────────────────────────────────────────────────────╯

    No index found. It will be created on next session start.
    Storage: {config.storage_path}
```

---

### Normal output (index exists):

#### 1. Header Box

```
╭── 📊 Beacon Index ────────────────────────────────────╮
│   {config.model} · {config.provider_description}      │
│   {config.dimensions} dims                            │
╰───────────────────────────────────────────────────────╯
```

#### 2. Sync Status (only if NOT idle)

If `sync.status` is `"in_progress"`, show between header and coverage:
```

    Syncing
    ████████████░░░░░░░░  {sync.percent}% ({sync.completed}/{sync.total} files)
    Currently: {sync.current_file}
```

Build the progress bar: 20 chars wide, use `█` for filled and `░` for empty.

If `sync.status` is `"error"`:
```

╭── ⚠ Sync Error ──────────────────────────────────────╮
│   {sync.error}                                        │
│   Last successful sync: {last_sync as relative time}  │
│   Try /reindex to force a fresh sync                  │
╰───────────────────────────────────────────────────────╯
```

If `sync.status` is `"stale"`:
```

╭── ⚠ Sync Stalled ────────────────────────────────────╮
│   Sync appears to have stalled (started over 5m ago)  │
│   Try /reindex to force a fresh sync                  │
╰───────────────────────────────────────────────────────╯
```

#### 3. Coverage Bar (always show, outside boxes)

```

    Coverage
    ████████████████████░░  97%  (36 / 37 files)
```

Build the coverage bar: 20 chars wide using `█` and `░`. If `coverage_percent` is null (no eligible count), show just the file count without a bar.

If coverage < 50%, add on the next line: `    ⚠ Low coverage — consider running /reindex`

#### 4. Statistics Box

```

╭── Statistics ─────────────────────────────────────────╮
│   Indexed files     {files_indexed}                   │
│   Total chunks      {total_chunks}                    │
│   Avg chunks/file   {avg_chunks_per_file}             │
│   DB size           {db_size formatted as KB/MB}      │
│   Last sync         {last_sync as relative time}      │
╰───────────────────────────────────────────────────────╯
```

Format `db_size_bytes`: <1024 → `N bytes`, <1MB → `N.N KB`, else `N.N MB`.
Format timestamps as relative: "2 minutes ago", "3 hours ago", "about 1 day ago". If null, show "never".

#### 5. Files Box

```

╭── Files ──────────────────────────────────────────────╮
│   scripts/lib/db.js            12 chunks    ~2m       │
│   scripts/lib/embedder.js       4 chunks    ~2m       │
│   scripts/lib/chunker.js        6 chunks    ~2m       │
│   src/index.ts                   3 chunks    ~1h      │
╰───────────────────────────────────────────────────────╯
```

Rules:
- Pad columns so chunk counts and timestamps align vertically
- Right-align the chunk count column, left-align the file path
- If ≤ 20 files: show all files sorted by most recently updated
- If > 20 files: show only the top 30 most recently updated, then add `│   ... and {N} more files` as the last row before `╰`
- Format `last_updated` as short relative: `~2m`, `~1h`, `~3d`, `~19h`

#### 6. Extensions Box

```

╭── By extension ───────────────────────────────────────╮
│   .tsx       48 files                                 │
│   .ts        11 files                                 │
│   .sql        3 files                                 │
│   .md         2 files                                 │
│   .py         1 file                                  │
╰───────────────────────────────────────────────────────╯
```

Pad extension and count columns to align. Use "file" (singular) for count of 1.

## Key Rules

- Keep it scannable — no paragraph text, no verbose explanations
- NEVER use markdown pipe tables — only box-drawing characters and space-padded columns
- All boxes are exactly 55 chars wide (from `╭` to `╮`)
- One blank line between each box/section
- Never exceed ~60 lines total
- If sync is idle and healthy, do NOT show the sync section — go straight from header to coverage
