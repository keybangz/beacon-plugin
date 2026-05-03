# GPU Acceleration

Enable GPU acceleration for Beacon embedding inference to significantly speed up indexing and search operations.

## Supported Providers

| Provider | Platform | Requirements | Notes |
|----------|----------|--------------|-------|
| `cpu` | All | None | Default, always works |
| `auto` | All | Platform-dependent | Auto-selects best available EP |
| `cuda` | Linux x64 | CUDA 12 + cuDNN | Best for FP32 models; INT8 quantized models may be slower |
| `directml` | Windows | Windows 10+ | Good for AMD/NVIDIA/Intel on Windows |
| `coreml` | macOS | macOS 12+ | Best for Apple Silicon (M1/M2/M3) |
| `webgpu` | Win/Linux/macOS | Vulkan drivers | Experimental — may hang on some drivers |

## Enable GPU

Set the execution provider using the config tool:

```
/config action="set" key="embedding.execution_provider" value="auto"
/config action="set" key="embedding.execution_provider" value="cuda"
/config action="set" key="embedding.execution_provider" value="directml"
/config action="set" key="embedding.execution_provider" value="coreml"
```

Use `scope="global"` to apply GPU settings across all projects:

```
/config action="set" key="embedding.execution_provider" value="auto" scope="global"
```

## Auto-Detection Behavior

When `execution_provider` is set to `"auto"`, Beacon will:

- **macOS**: Use CoreML if available, otherwise CPU
- **Windows**: Use DirectML if available, otherwise CPU  
- **Linux x64**: Use CUDA if available AND the model is NOT INT8 quantized, otherwise CPU

Auto-detection checks `ort.InferenceSession.getAvailableProviders()` at runtime to determine what's installed on your system.

## INT8 Warning

The default model (`jina-embeddings-v2-base-code`) is INT8 quantized. CUDA execution provider has known kernel gaps for INT8 operations in onnxruntime-node, which can cause operations to fall back to CPU and actually slow down inference.

For best GPU performance:
- Use FP32 models like `unixcoder-base` or `codebert-base` for maximum speedup
- Keep INT8 models on CPU, or use CoreML (macOS) / DirectML (Windows) which handle INT8 better

## Verify

Check your current configuration:

```
/config action="view" key="embedding.execution_provider"
```

Or view the full status:

```
/status
```

The execution provider will be logged at startup when auto-detection is used.
