Use the `downloadModels` tool to download an ONNX embedding model for local use by Beacon.

## Parameters
- `model` (optional): Model name to download. Defaults to `jina-embeddings-v2-base-code` (recommended).

## Available Models
| Model | Dims | Size | Best For |
|-------|------|------|----------|
| `jina-embeddings-v2-base-code` | 768 | ~162MB | **Code search — default & recommended** (30 PLs, 8192-token context, int8-quantized) |
| `nomic-embed-text-v1.5` | 768 | ~137MB | Long-context text + code (requires `query_prefix`/`document_prefix` in config) |
| `all-MiniLM-L12-v2` | 384 | ~134MB | General purpose, better quality, slower |
| `all-MiniLM-L6-v2` | 384 | ~90MB | General purpose, fastest, smallest |
| `paraphrase-MiniLM-L6-v2` | 384 | ~90MB | Paraphrase/similarity tasks |
| `codebert-base` | 768 | ~480MB | NL→code retrieval (Microsoft CodeBERT) |
| `unixcoder-base` | 768 | ~470MB | Code clone detection (Microsoft UniXcoder) |

## Examples
- Download default (recommended): (no parameters needed, or `model="jina-embeddings-v2-base-code"`)
- Download smaller fallback: `model="all-MiniLM-L6-v2"`
- Download for long-context: `model="nomic-embed-text-v1.5"`

## After Downloading a New Model
1. Update config: `action="set", key="embedding.model", value="{model-name}"`
2. Update dimensions if changed: `action="set", key="embedding.dimensions", value="{dims}"`
3. For `nomic-embed-text-v1.5` only — set prefixes:
   - `action="set", key="embedding.query_prefix", value="search_query: "`
   - `action="set", key="embedding.document_prefix", value="search_document: "`
4. Rebuild index: `/reindex confirm=true`

## Notes
- Models are saved to `~/.cache/beacon/models/{model-name}/model.onnx`
- The default model (`jina-embeddings-v2-base-code`) is downloaded automatically on first use if not present
- SHA-256 integrity verification is performed after download
- Internet connection required; download timeout is 5 minutes
- To use GPU acceleration, set `embedding.execution_provider` to `cuda` (NVIDIA), `rocm` (AMD), or `webgpu` (experimental)
