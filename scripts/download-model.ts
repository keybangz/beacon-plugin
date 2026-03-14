#!/usr/bin/env node
/**
 * Download ONNX embedding model for local embeddings
 * Usage: npx beacon-opencode download-model [model-name]
 */

import { mkdirSync, existsSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";

const MODELS: Record<string, { url: string; dimensions: number; vocabUrl?: string }> = {
  "all-MiniLM-L6-v2": {
    url: "https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/main/onnx/model.onnx",
    dimensions: 384,
    vocabUrl: "https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/main/vocab.txt",
  },
  "all-MiniLM-L12-v2": {
    url: "https://huggingface.co/sentence-transformers/all-MiniLM-L12-v2/resolve/main/onnx/model.onnx",
    dimensions: 384,
    vocabUrl: "https://huggingface.co/sentence-transformers/all-MiniLM-L12-v2/resolve/main/vocab.txt",
  },
  "paraphrase-MiniLM-L6-v2": {
    url: "https://huggingface.co/sentence-transformers/paraphrase-MiniLM-L6-v2/resolve/main/onnx/model.onnx",
    dimensions: 384,
    vocabUrl: "https://huggingface.co/sentence-transformers/paraphrase-MiniLM-L6-v2/resolve/main/vocab.txt",
  },
};

async function downloadFile(url: string, destPath: string): Promise<void> {
  console.log(`Downloading: ${url}`);
  console.log(`To: ${destPath}`);
  
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download: ${response.status} ${response.statusText}`);
  }
  
  const buffer = await response.arrayBuffer();
  mkdirSync(dirname(destPath), { recursive: true });
  writeFileSync(destPath, Buffer.from(buffer));
  console.log(`✓ Downloaded ${Math.round(buffer.byteLength / 1024 / 1024 * 100) / 100} MB`);
}

async function main(): Promise<void> {
  const modelName = process.argv[2] || "all-MiniLM-L6-v2";
  const modelInfo = MODELS[modelName];
  
  if (!modelInfo) {
    console.error(`Unknown model: ${modelName}`);
    console.error(`Available models: ${Object.keys(MODELS).join(", ")}`);
    process.exit(1);
  }
  
  const modelsDir = join(homedir(), ".cache", "beacon", "models");
  const modelDir = join(modelsDir, modelName);
  const modelPath = join(modelDir, "model.onnx");
  const vocabPath = join(modelDir, "vocab.txt");
  
  if (existsSync(modelPath)) {
    console.log(`Model already exists at: ${modelPath}`);
    console.log("Delete it first to re-download.");
    return;
  }
  
  mkdirSync(modelDir, { recursive: true });
  
  try {
    await downloadFile(modelInfo.url, modelPath);
    
    if (modelInfo.vocabUrl) {
      await downloadFile(modelInfo.vocabUrl, vocabPath);
      console.log(`✓ Vocabulary downloaded to: ${vocabPath}`);
    }
    
    console.log(`\n✓ Model installed successfully!`);
    console.log(`\nAdd to your .opencode/beacon.json:`);
    console.log(JSON.stringify({
      embedding: {
        api_base: "local",
        model: modelPath,
        dimensions: modelInfo.dimensions,
        enabled: true
      }
    }, null, 2));
  } catch (error) {
    console.error("Failed to download model:", error);
    process.exit(1);
  }
}

main();
