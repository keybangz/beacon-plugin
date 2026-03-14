# Setting Up Beacon Plugin for OpenCode

This guide walks you through installing and using the Beacon semantic search plugin with OpenCode.

## Prerequisites

- **Node.js** 18.0.0 or higher
- **OpenCode** installed (latest version)
- **Embedding Model** (optional - ONNX runs locally by default)
  - Default: local ONNX with `all-MiniLM-L6-v2` (384 dimensions)
  - Alternative: Ollama or other OpenAI-compatible API

### Setting Up ONNX (Default - Zero HTTP Latency)

The plugin includes ONNX runtime for local embeddings with zero network latency:

```bash
# ONNX models are bundled/downloaded automatically
# No additional setup required!
```

### Setting Up Ollama (Alternative)

If you prefer Ollama over ONNX:

```bash
# Install Ollama from https://ollama.ai

# Pull the embedding model
ollama pull all-minilm:22m

# Start the server (runs on localhost:11434 by default)
ollama serve
```

The `all-minilm:22m` model is lightweight (~88MB) and perfect for local semantic search. It has a **256-token context limit**, so ensure your `context_limit` configuration matches this value.

## Installation

### Option 1: Install from NPM (Recommended for Users)

```bash
# Install the plugin
npm install beacon-opencode

# OpenCode will auto-detect and load the plugin
```

### Option 2: Development Installation (For Contributors)

```bash
# Clone the repository
git clone https://github.com/keybangz/beacon-plugin.git
cd beacon-plugin

# Install dependencies
npm install

# Build the project
npm run build

# Build outputs to .opencode/src/lib/
ls .opencode/src/lib/
```

## Configuration

### Default Configuration

The plugin uses sensible defaults from `config/beacon.default.json`:

```json
{
  "embedding": {
    "api_base": "local",
    "model": "all-MiniLM-L6-v2",
    "api_key_env": "",
    "dimensions": 384,
    "batch_size": 32,
    "query_prefix": "",
    "context_limit": 256
  },
  "chunking": {
    "strategy": "hybrid",
    "max_tokens": 512,
    "overlap_tokens": 32
  },
  "search": {
    "top_k": 10,
    "similarity_threshold": 0.01,
    "hybrid": {
      "enabled": true,
      "weight_vector": 0.4,
      "weight_bm25": 0.3,
      "weight_rrf": 0.3,
      "doc_penalty": 0.5,
      "identifier_boost": 1.5,
      "debug": false
    }
  }
}
```

#### Safety Margin

Beacon uses an **80% safety margin** (e.g., 256 * 0.8 = 204 tokens = 612 chars) to prevent "input length exceeds context length" errors. The chunker truncates at line boundaries first, then character boundaries if needed.

### Custom Configuration

Create a `.opencode/beacon.json` in your project root to override defaults:

```bash
# View current configuration
config view

# Set a custom value
config set search.top_k 10
```

## Usage in OpenCode

### 1. Initialize Your Project Index

First time in a project? Build the search index:

```bash
opencode reindex
```

This will:
- Scan your codebase for files
- Split code into semantic chunks
- Generate embeddings via local LLM
- Store in `.beacon/embeddings.db`

### 2. Search Your Codebase

Use the semantic search tool:

```bash
# Search for authentication patterns
search "authentication flow"

# Search with custom parameters
search "database operations" --topK 10 --threshold 0.2

# Scope search to a directory
search "error handling" --pathPrefix src/services/

# Use pure vector search (disable BM25)
search "API endpoints" --noHybrid
```

### 3. View Index Status

Check the health of your index:

```bash
# Quick health check
status

# Visual dashboard
index

# Show all indexed files
index --files
```

### 4. Advanced Management

```bash
# Clear the entire index
reindex --confirm

# Add directories to blacklist
blacklist add "vendor/**"

# Remove from blacklist
blacklist remove "vendor/**"

# View blacklist
blacklist list

# Check performance metrics
performance cache
performance metrics
```

## How AI Models Use Beacon

When an AI assistant (like Claude) is working in your OpenCode session, Beacon integrates transparently:

### Automatic Integration

1. **Session Start**: OpenCode loads the Beacon index automatically
2. **Code Context**: When asked to analyze code, the AI can:
   - Use `search` tool for semantic code lookup
   - Find relevant patterns across your entire codebase
   - Reference specific files and line numbers

### Example AI Workflow

```
User: "How is authentication handled in this project?"

AI:
  1. Uses: opencode search "authentication flow"
  2. Gets: Ranked list of relevant code chunks
  3. Returns: Implementation patterns from your codebase
  4. References: Specific files and line numbers
```

### Without Writing Test Scripts

You don't need to write test scripts to see AI using the plugin. Here's how it works naturally:

1. **Direct Tool Calls**: The AI automatically invokes the search tool when analyzing code
2. **Transparent Results**: Search results appear in the AI's reasoning and responses
3. **Context Injection**: Beacon context automatically gets added during session compaction

Example command the AI might execute:

```bash
# AI automatically runs this when you ask about patterns
opencode search "database connection pooling"

# Results show:
# 1. src/db/pool.ts:45 (score: 0.87)
#    "const pool = new ConnectionPool({..."
#
# 2. src/config/db.ts:12 (score: 0.82)
#    "poolSize: process.env.DB_POOL_SIZE || 10"
```

### Seeing Live Usage

To see the plugin in action with an AI:

1. **Start OpenCode with Beacon enabled**:
   ```bash
   opencode
   ```

2. **Ask the AI a code question**:
   ```
   "Show me how the API authentication is implemented"
   "Find all database queries that use transactions"
   "What are the error handling patterns in this codebase?"
   ```

3. **Observe the search results**:
   - The AI will automatically invoke `opencode search`
   - Results appear in the AI's response with file paths and line numbers
   - Multiple ranked results show semantic relevance

4. **Try different search strategies**:
   ```
   "Find database-related code (use semantic search)"
   "Show me functions named 'validate*' (use identifier search)"
   "Find error handling that mentions 'timeout' (use keyword search)"
   ```

### Plugin Integration Points

Beacon integrates at these key moments:

| Event | What Happens |
|-------|--------------|
| `tool.execute.after` | Changed files are re-indexed; deleted files are cleaned up |
| `experimental.session.compacting` | Index status added to context |

The AI sees the Beacon context in the system message:
```
## Beacon Index Status
The codebase has been indexed for semantic search. 
The Beacon search capability is available via the 'search' tool.
```

This tells the AI that semantic search is available and ready to use.

## Troubleshooting

### Issue: "Embedding server not reachable"

**Solution**: If using Ollama, make sure it's running:
```bash
ollama serve
```

Check the endpoint:
```bash
config view
# Look for: "api_base": "local" (default)
```

Change if needed:
```bash
config set embedding.api_base http://your-server:11434
```

### Issue: "Dimension mismatch"

This happens if you change embedding models. Rebuild:
```bash
npm run build
reindex --confirm
```

### Issue: "Input length exceeds context length"

This usually means your `context_limit` config exceeds the model's actual context window. For example, ONNX models have a 512-token limit, so set:
```json
{
  "embedding": {
    "context_limit": 256
  }
}
```

Then rebuild and reindex: `npm run build && reindex --confirm`

### Issue: Search returns no results

Try these steps:

1. Check index status:
   ```bash
   status
   ```

2. Rebuild if needed:
   ```bash
   reindex
   ```

3. Lower the threshold:
   ```bash
   search "query" --threshold 0.001
   ```

4. Check with pure vector search:
   ```bash
   search "query" --noHybrid
   ```

### Issue: Slow indexing

For large projects:

1. Use blacklist to exclude files:
   ```bash
   blacklist add "node_modules/**"
   blacklist add "dist/**"
   reindex
   ```

2. Increase batch size:
   ```bash
   config set embedding.batch_size 64
   ```

3. Check system resources:
   ```bash
   performance metrics
   ```

## Performance Tuning

### For Small Projects (< 100 files)

Default settings are optimal.

### For Medium Projects (100-1000 files)

```bash
config set embedding.batch_size 64
config set search.top_k 10
```

### For Large Projects (> 1000 files)

```bash
# Exclude build artifacts
blacklist add "node_modules/**"
blacklist add "dist/**"
blacklist add "build/**"

# Tune search
config set search.top_k 5
config set embedding.batch_size 32

# Rebuild
reindex --confirm
```

## Next Steps

- **Examples**: See [EXAMPLES.md](./EXAMPLES.md) for real-world use cases
- **API Reference**: Review tool signatures in [README.md](./README.md)

## Support

- **Issues**: [GitHub Issues](https://github.com/sagarmk/beacon-opencode/issues)
- **Discussions**: [GitHub Discussions](https://github.com/sagarmk/beacon-opencode/discussions)
- **Docs**: [Full Documentation](https://github.com/sagarmk/beacon-opencode/wiki)
