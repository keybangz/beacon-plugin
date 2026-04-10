import { mkdirSync, existsSync, writeFileSync, statSync, unlinkSync, createReadStream } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { createHash } from "crypto";
import { tool, type ToolDefinition } from "@opencode-ai/plugin";

const MODELS: Record<string, {
  url: string;
  dimensions: number;
  vocabUrl?: string;
  type: "sentence-transformer" | "codebert" | "unixcoder";
  description: string;
  sizeMb: number;
}> = {
  "all-MiniLM-L6-v2": {
    url: "https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/main/onnx/model.onnx",
    dimensions: 384,
    vocabUrl: "https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/main/vocab.txt",
    type: "sentence-transformer",
    description: "Fast general-purpose model. Good baseline for mixed code+text search.",
    sizeMb: 90,
  },
  "all-MiniLM-L12-v2": {
    url: "https://huggingface.co/sentence-transformers/all-MiniLM-L12-v2/resolve/main/onnx/model.onnx",
    dimensions: 384,
    vocabUrl: "https://huggingface.co/sentence-transformers/all-MiniLM-L12-v2/resolve/main/vocab.txt",
    type: "sentence-transformer",
    description: "Deeper variant of MiniLM-L6-v2. Slightly better quality, ~2x slower on CPU.",
    sizeMb: 134,
  },
  "paraphrase-MiniLM-L6-v2": {
    url: "https://huggingface.co/sentence-transformers/paraphrase-MiniLM-L6-v2/resolve/main/onnx/model.onnx",
    dimensions: 384,
    vocabUrl: "https://huggingface.co/sentence-transformers/paraphrase-MiniLM-L6-v2/resolve/main/vocab.txt",
    type: "sentence-transformer",
    description: "Paraphrase-tuned MiniLM. Good for finding semantically similar code patterns.",
    sizeMb: 90,
  },
  "codebert-base": {
    url: "https://huggingface.co/microsoft/codebert-base/resolve/main/onnx/model.onnx",
    dimensions: 768,
    vocabUrl: "https://huggingface.co/microsoft/codebert-base/resolve/main/vocab.json",
    type: "codebert",
    description: "Microsoft CodeBERT. Code-aware NL+PL model, strong for NL→code retrieval.",
    sizeMb: 480,
  },
  "unixcoder-base": {
    url: "https://huggingface.co/microsoft/unixcoder-base/resolve/main/onnx/model.onnx",
    dimensions: 768,
    vocabUrl: "https://huggingface.co/microsoft/unixcoder-base/resolve/main/vocab.json",
    type: "unixcoder",
    description: "Microsoft UniXcoder. Cross-modal code model, great for code clone detection.",
    sizeMb: 470,
  },
  "jina-embeddings-v2-base-code": {
    // Int8-quantized ONNX — 162 MB, runs comfortably on CPU at 256 tokens / batch 32.
    // Trained on GitHub code + 150 M text pairs across 30 programming languages.
    // Best overall quality for NL→code and code→code retrieval.
    url: "https://huggingface.co/jinaai/jina-embeddings-v2-base-code/resolve/main/onnx/model_quantized.onnx",
    dimensions: 768,
    vocabUrl: "https://huggingface.co/jinaai/jina-embeddings-v2-base-code/resolve/main/vocab.json",
    type: "sentence-transformer",
    description: "Jina v2 code model (int8 quantized). Best code-specific quality. 30 PLs. Recommended upgrade from MiniLM.",
    sizeMb: 162,
  },
  "nomic-embed-text-v1.5": {
    // Int8-quantized ONNX — ~137 MB. 8192-token context. Matryoshka dims (768/512/256/128/64).
    // Strong general model with significant code quality gains over MiniLM.
    // NOTE: requires task prefix — the embedder prepends "search_query: " / "search_document: "
    // via config.embedding.query_prefix = "search_query: " when using this model.
    url: "https://huggingface.co/nomic-ai/nomic-embed-text-v1.5/resolve/main/onnx/model_quantized.onnx",
    dimensions: 768,
    vocabUrl: "https://huggingface.co/nomic-ai/nomic-embed-text-v1.5/resolve/main/vocab.txt",
    type: "sentence-transformer",
    description: "Nomic embed v1.5 (int8 quantized). High quality general+code. Set query_prefix to 'search_query: ' in config.",
    sizeMb: 137,
  },
};

// SHA-256 checksums for downloaded artifacts.
// These are verified post-download. A null entry means unverified (hash not yet published).
// Hashes will be updated in each release. Verify against: https://github.com/keybangz/beacon-opencode/releases
const KNOWN_HASHES: Record<string, { model: string | null; vocab: string | null }> = {
  "all-MiniLM-L6-v2":              { model: null, vocab: null },
  "all-MiniLM-L12-v2":             { model: null, vocab: null },
  "paraphrase-MiniLM-L6-v2":       { model: null, vocab: null },
  "codebert-base":                  { model: null, vocab: null },
  "unixcoder-base":                 { model: null, vocab: null },
  "jina-embeddings-v2-base-code":   { model: null, vocab: null },
  "nomic-embed-text-v1.5":          { model: null, vocab: null },
};

const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

function computeSHA256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

async function downloadFile(url: string, destPath: string): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new Error(`Failed to download: ${response.status} ${response.statusText}`);
  }

  const buffer = await response.arrayBuffer();
  mkdirSync(dirname(destPath), { recursive: true });
  writeFileSync(destPath, Buffer.from(buffer));
}

const _export: ToolDefinition = tool({
  description: "Download an ONNX embedding model for local use. Available models: all-MiniLM-L6-v2 (default, 384 dims, ~90MB), all-MiniLM-L12-v2 (384 dims, ~134MB), paraphrase-MiniLM-L6-v2 (384 dims, ~90MB), codebert-base (768 dims, ~480MB), unixcoder-base (768 dims, ~470MB), jina-embeddings-v2-base-code (768 dims, ~162MB, best for code), nomic-embed-text-v1.5 (768 dims, ~137MB, requires query_prefix and document_prefix)",
  args: {
    model: tool.schema.string().optional().describe("Model name to download (default: all-MiniLM-L6-v2)"),
  },
  async execute({ model = "all-MiniLM-L6-v2" }): Promise<string> {
    const modelInfo = MODELS[model];

    if (!modelInfo) {
      const modelList = Object.entries(MODELS)
        .map(([name, info]) => `  ${name} — ${info.description} (~${info.sizeMb}MB, ${info.dimensions} dims)`)
        .join("\n");
      return `Unknown model: ${model}\n\nAvailable models:\n${modelList}`;
    }

    const modelsDir = join(homedir(), ".cache", "beacon", "models");
    const modelDir = join(modelsDir, model);
    const modelPath = join(modelDir, "model.onnx");

    // Derive vocab filename from URL (e.g., vocab.txt or vocab.json)
    const vocabFilename = modelInfo.vocabUrl
      ? modelInfo.vocabUrl.split("/").pop()!.split("?")[0]
      : "vocab.txt";
    const vocabPath = join(modelDir, vocabFilename);

    // Only skip download if both model and vocab exist
    const vocabExists = modelInfo.vocabUrl ? existsSync(vocabPath) : true;
    if (existsSync(modelPath) && vocabExists) {
      const modelStats = statSync(modelPath);
      const modelSize = modelStats.size / 1024 / 1024;
      const notes = model === "nomic-embed-text-v1.5"
        ? '\n\nNote: Set embedding.query_prefix to "search_query: " and embedding.document_prefix to "search_document: " in your beacon config for best results.'
        : "";
      return `Model already exists at: ${modelPath}\n\nModel: ${model}\nDimensions: ${modelInfo.dimensions}\nSize: ${modelSize.toFixed(2)} MB\nType: ${modelInfo.type}\nDescription: ${modelInfo.description}${notes}`;
    }

    mkdirSync(modelDir, { recursive: true });

    try {
      await downloadFile(modelInfo.url, modelPath);

      let modelSize: number;
      let modelHash: string;
      let vocabHash: string | null = null;
      try {
        modelSize = statSync(modelPath).size / 1024 / 1024;
      } catch {
        // statSync failed — remove the partial file so a retry starts clean.
        try { unlinkSync(modelPath); } catch {}
        throw new Error("Downloaded model file could not be read; the file may be corrupt.");
      }

      // Compute and verify SHA-256 of downloaded model
      modelHash = await computeSHA256(modelPath);
      const knownHash = KNOWN_HASHES[model];
      if (knownHash?.model !== null && knownHash?.model !== undefined) {
        if (modelHash !== knownHash.model) {
          unlinkSync(modelPath);
          throw new Error(
            `SHA-256 mismatch for model file!\n` +
            `  Expected: ${knownHash.model}\n` +
            `  Got:      ${modelHash}\n` +
            `Download aborted. This may indicate a compromised file. Do not use this model.`
          );
        }
      }

      if (modelInfo.vocabUrl) {
        try {
          await downloadFile(modelInfo.vocabUrl, vocabPath);

          vocabHash = await computeSHA256(vocabPath);
          if (knownHash?.vocab !== null && knownHash?.vocab !== undefined) {
            if (vocabHash !== knownHash.vocab) {
              try { unlinkSync(modelPath); } catch {}
              try { unlinkSync(vocabPath); } catch {}
              throw new Error(
                `SHA-256 mismatch for vocab file!\n` +
                `  Expected: ${knownHash.vocab}\n` +
                `  Got:      ${vocabHash}\n` +
                `Download aborted. This may indicate a compromised file.`
              );
            }
          }
        } catch (vocabError) {
          // Vocab download failed — remove the model file to avoid a corrupt partial state
          try { unlinkSync(modelPath); } catch {}
          throw vocabError;
        }
      }

      // Build suggested config snippet
      const configSnippet: Record<string, unknown> = {
        embedding: {
          api_base: "local",
          model: modelPath,
          dimensions: modelInfo.dimensions,
          enabled: true,
        },
      };
      // Nomic requires a query prefix for best performance AND a document prefix for indexing
      if (model === "nomic-embed-text-v1.5") {
        (configSnippet.embedding as Record<string, unknown>).query_prefix = "search_query: ";
        (configSnippet.embedding as Record<string, unknown>).document_prefix = "search_document: ";
      }
      // For GPU users, show how to enable acceleration
      const gpuNote = `\nTo use GPU acceleration add "execution_provider": "cuda" (NVIDIA), "rocm" (AMD via ROCm), or "webgpu" (AMD/NVIDIA/Intel via Vulkan, experimental) to the embedding section.`;

      const globalConfigPath = join(homedir(), ".config", "beacon", "config.json");
      const configOutput = JSON.stringify(configSnippet, null, 2);

      return [
        `✓ Model downloaded successfully!`,
        ``,
        `Model: ${model}`,
        `Path: ${modelPath}`,
        `Dimensions: ${modelInfo.dimensions}`,
        `Size: ${modelSize.toFixed(2)} MB`,
        `Type: ${modelInfo.type}`,
        `Description: ${modelInfo.description}`,
        `Integrity:`,
        `  model.onnx SHA-256: ${modelHash}`,
        modelInfo.vocabUrl ? `  ${vocabFilename}  SHA-256: ${vocabHash}` : null,
        `  Tip: Verify these hashes against the checksums published at https://github.com/keybangz/beacon-opencode/releases`,
        ``,
        `To apply globally (all projects), add to ${globalConfigPath}:`,
        configOutput,
        ``,
        `To apply to this project only, add to .opencode/beacon.json instead.`,
        gpuNote,
      ].filter(Boolean).join("\n");
    } catch (error) {
      return `Failed to download model: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
});
export default _export;
