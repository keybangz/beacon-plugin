# Quick Reference - Beacon Plugin

## For Users

```bash
# Setup
npm install beacon-opencode
ollama pull nomic-embed-text

# Initialize
opencode reindex

# Search
opencode search "what are you looking for?"

# Management
opencode status        # Check index health
opencode index        # View dashboard
opencode config       # Manage settings
opencode blacklist    # Exclude directories
```

## For AI Models

No special setup needed! The AI automatically:

1. Sees "Beacon index available" in system message
2. Calls `search` tool when analyzing code
3. Gets ranked results with file references
4. Includes results in its responses

### What the AI Searches For

- **"Describe the authentication flow"** → Searches for auth patterns
- **"Add validation like the rest of the code"** → Finds existing validators
- **"How do we handle errors?"** → Finds error handling patterns
- **"Show me similar database queries"** → Finds DB code examples

## Installation Paths

### Users
```bash
npm install beacon-opencode
# Then use: opencode search, opencode reindex, etc.
```

### Developers
```bash
git clone https://github.com/sagarmk/beacon-opencode
npm install
npm run build
npm link
```

## Documentation Map

| Document | Purpose | Audience |
|----------|---------|----------|
| README.md | Overview & quick start | Everyone |
| SETUP_OPENCODE.md | Complete setup guide | Users & developers |
| AI_MODELS_USING_BEACON.md | How AI uses the plugin | AI developers, curious users |
| RELEASE_CHECKLIST.md | Release verification | Maintainers |

## Core Concepts

### Hybrid Search (40% + 30% + 30%)

```
Query → Vector Search (40%) + BM25 Keywords (30%) + Identifier Boost (30%)
    ↓
Combined Ranking (RRF)
    ↓
Filtered Results (threshold + top_k)
```

### Database Structure

```
.beacon/
├── embeddings.db        (SQLite with vectors)
├── chunks               (Code segments)
├── embeddings           (384-dim vectors)
├── full_text_search     (BM25 index)
└── sync_state           (Index metadata)
```

### File Processing Pipeline

```
Code Files
    ↓
Chunking (512 tokens, 50 overlap)
    ↓
Tokenization & Identifier Extraction
    ↓
Embedding Generation (nomic-embed-text)
    ↓
Database Storage
    ↓
Ready for Search
```

## Configuration

### Key Settings

```json
{
  "embedding": {
    "api_base": "http://localhost:11434",
    "model": "nomic-embed-text",
    "dimensions": 384
  },
  "search": {
    "top_k": 5,
    "similarity_threshold": 0.3
  }
}
```

### Common Overrides

```bash
# More results
opencode config --set search.top_k 10

# Lower threshold (more results)
opencode config --set search.similarity_threshold 0.2

# Different embedding API
opencode config --set embedding.api_base http://your-server:11434
```

## Testing

```bash
# All tests
npm test

# Type check
npm run type-check

# Build
npm run build
```

## Troubleshooting

| Issue | Fix |
|-------|-----|
| "Embedding server not reachable" | `ollama serve` |
| "Dimension mismatch" | `opencode reindex --confirm` |
| "No results" | Lower threshold or use `--noHybrid` |
| "Slow performance" | Use blacklist to exclude directories |

## File Structure

```
beacon-plugin/
├── src/lib/              # Core library
├── .opencode/            # OpenCode integration
│   ├── plugins/          # Plugin entry point
│   └── tools/            # Tool implementations
├── tests/                # Test suites
├── config/               # Default config
├── README.md             # Overview
├── SETUP_OPENCODE.md     # Setup guide
└── AI_MODELS_USING_BEACON.md  # AI guide
```

## Release Info

- **Version**: 2.0.0-opencode
- **Branch**: opencode-port
- **Status**: Ready for public release
- **Tests**: 171/171 passing
- **NPM**: `npm install beacon-opencode`

## Support

- **GitHub**: https://github.com/sagarmk/beacon-opencode
- **Issues**: Report at GitHub Issues
- **Docs**: Check SETUP_OPENCODE.md for detailed help
