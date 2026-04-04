Use the `downloadModels` tool to download an ONNX embedding model for local use by Beacon.

## Parameters
- `model` (required): Model name to download. Available models:

| Model | Dimensions | Size | Best For |
|-------|-----------|------|----------|
| `all-MiniLM-L6-v2` | 384 | ~90MB | General purpose, fast |
| `all-MiniLM-L12-v2` | 384 | ~134MB | General purpose, better quality |
| `paraphrase-MiniLM-L6-v2` | 384 | ~90MB | Paraphrase/similarity |
| `jina-embeddings-v2-base-code` | 768 | ~162MB | **Code search (default, recommended)** |
| `nomic-embed-text-v1.5` | 768 | ~137MB | Long-context text |

## Examples
- Download default model: `model="jina-embeddings-v2-base-code"`
- Download smaller model: `model="all-MiniLM-L6-v2"`

## Notes
- Models are saved to `~/.cache/beacon/models/{model-name}/model.onnx`
- The default model (`jina-embeddings-v2-base-code`) is downloaded automatically on first use
- After downloading a new model, update config with `/config action="set", key="embedding.model", value="{model-name}"` and then run `/reindex`
- Internet connection required for download
