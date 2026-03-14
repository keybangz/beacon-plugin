import { mkdirSync, existsSync, writeFileSync, statSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { tool } from "@opencode-ai/plugin";

const MODELS: Record<string, { 
  url: string; 
  dimensions: number; 
  vocabUrl?: string;
  type: "sentence-transformer" | "codebert" | "unixcoder";
}> = {
  "all-MiniLM-L6-v2": {
    url: "https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/main/onnx/model.onnx",
    dimensions: 384,
    vocabUrl: "https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/main/vocab.txt",
    type: "sentence-transformer",
  },
  "all-MiniLM-L12-v2": {
    url: "https://huggingface.co/sentence-transformers/all-MiniLM-L12-v2/resolve/main/onnx/model.onnx",
    dimensions: 384,
    vocabUrl: "https://huggingface.co/sentence-transformers/all-MiniLM-L12-v2/resolve/main/vocab.txt",
    type: "sentence-transformer",
  },
  "paraphrase-MiniLM-L6-v2": {
    url: "https://huggingface.co/sentence-transformers/paraphrase-MiniLM-L6-v2/resolve/main/onnx/model.onnx",
    dimensions: 384,
    vocabUrl: "https://huggingface.co/sentence-transformers/paraphrase-MiniLM-L6-v2/resolve/main/vocab.txt",
    type: "sentence-transformer",
  },
  "codebert-base": {
    url: "https://huggingface.co/microsoft/codebert-base/resolve/main/onnx/model.onnx",
    dimensions: 768,
    vocabUrl: "https://huggingface.co/microsoft/codebert-base/resolve/main/vocab.txt",
    type: "codebert",
  },
  "unixcoder-base": {
    url: "https://huggingface.co/microsoft/unixcoder-base/resolve/main/onnx/model.onnx",
    dimensions: 768,
    vocabUrl: "https://huggingface.co/microsoft/unixcoder-base/resolve/main/vocab.txt",
    type: "unixcoder",
  },
};

async function downloadFile(url: string, destPath: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download: ${response.status} ${response.statusText}`);
  }
  
  const buffer = await response.arrayBuffer();
  mkdirSync(dirname(destPath), { recursive: true });
  writeFileSync(destPath, Buffer.from(buffer));
  return;
}

export default tool({
  description: "Download an ONNX embedding model for local use. Available models: all-MiniLM-L6-v2 (default, 384 dims), all-MiniLM-L12-v2 (384 dims), paraphrase-MiniLM-L6-v2 (384 dims), codebert-base (768 dims), unixcoder-base (768 dims)",
  args: {
    model: tool.schema.string().optional().describe("Model name to download (default: all-MiniLM-L6-v2)"),
  },
  async execute({ model = "all-MiniLM-L6-v2" }): Promise<string> {
    const modelInfo = MODELS[model];
    
    if (!modelInfo) {
      return `Unknown model: ${model}. Available models: ${Object.keys(MODELS).join(", ")}`;
    }
    
    const modelsDir = join(homedir(), ".cache", "beacon", "models");
    const modelDir = join(modelsDir, model);
    const modelPath = join(modelDir, "model.onnx");
    const vocabPath = join(modelDir, "vocab.txt");
    
    if (existsSync(modelPath)) {
      const modelStats = statSync(modelPath);
      const modelSize = modelStats.size / 1024 / 1024;
      return `Model already exists at: ${modelPath}\n\nModel: ${model}\nDimensions: ${modelInfo.dimensions}\nSize: ${modelSize.toFixed(2)} MB\nType: ${modelInfo.type}`;
    }
    
    mkdirSync(modelDir, { recursive: true });
    
    try {
      await downloadFile(modelInfo.url, modelPath);
      const modelStats = statSync(modelPath);
      const modelSize = modelStats.size / 1024 / 1024;
      
      if (modelInfo.vocabUrl) {
        await downloadFile(modelInfo.vocabUrl, vocabPath);
      }
      
      const configOutput = JSON.stringify({
        embedding: {
          api_base: "local",
          model: modelPath,
          dimensions: modelInfo.dimensions,
          enabled: true,
        },
      }, null, 2);
      
      return `✓ Model downloaded successfully!\n\nModel: ${model}\nPath: ${modelPath}\nDimensions: ${modelInfo.dimensions}\nSize: ${modelSize.toFixed(2)} MB\nType: ${modelInfo.type}\n\nAdd to your .opencode/beacon.json:\n${configOutput}`;
    } catch (error) {
      return `Failed to download model: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
});