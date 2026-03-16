#!/usr/bin/env node

/**
 * Beacon Plugin Setup Script
 * 
 * This script runs after plugin installation to:
 * 1. Ensure .opencode directory exists in the current working directory
 * 2. Create default configuration if not present
 * 3. Ensure the plugin is ready for auto-indexing
 */

const { mkdirSync, existsSync, writeFileSync, readFileSync } = require('fs');
const { join } = require('path');

const DEFAULT_CONFIG = {
  embedding: {
    api_base: "local",
    model: "all-MiniLM-L6-v2",
    dimensions: 384,
    batch_size: 32,
    context_limit: 256,
    query_prefix: "",
    api_key_env: "",
    enabled: true
  },
  chunking: {
    strategy: "hybrid",
    max_tokens: 512,
    overlap_tokens: 32
  },
  indexing: {
    include: [
      "**/*.ts",
      "**/*.tsx",
      "**/*.js",
      "**/*.jsx",
      "**/*.py",
      "**/*.go",
      "**/*.rs",
      "**/*.java",
      "**/*.rb",
      "**/*.php",
      "**/*.sql",
      "**/*.md"
    ],
    exclude: [
      "node_modules/**",
      "dist/**",
      "build/**",
      ".next/**",
      "*.lock",
      "*.min.js",
      ".git/**",
      ".env*"
    ],
    max_file_size_kb: 500,
    auto_index: true,
    max_files: 10000,
    concurrency: 4
  },
  search: {
    top_k: 10,
    similarity_threshold: 0.35,
    hybrid: {
      enabled: true,
      weight_vector: 0.4,
      weight_bm25: 0.3,
      weight_rrf: 0.3,
      doc_penalty: 0.5,
      identifier_boost: 1.5,
      debug: false
    }
  },
  storage: {
    path: ".opencode/.beacon"
  }
};

function setupPlugin() {
  try {
    console.log('🔧 Setting up Beacon plugin...');
    
    // Get current working directory (where OpenCode is running)
    const cwd = process.cwd();
    const opencodeDir = join(cwd, '.opencode');
    
    // Create .opencode directory if it doesn't exist
    if (!existsSync(opencodeDir)) {
      console.log(`📁 Creating .opencode directory at: ${opencodeDir}`);
      mkdirSync(opencodeDir, { recursive: true });
    } else {
      console.log(`📁 .opencode directory already exists at: ${opencodeDir}`);
    }
    
    // Create beacon.json configuration if it doesn't exist
    const configPath = join(opencodeDir, 'beacon.json');
    if (!existsSync(configPath)) {
      console.log(`📝 Creating default beacon.json configuration at: ${configPath}`);
      writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf-8');
      console.log('✅ Default configuration created with auto_index: true');
    } else {
      console.log(`📝 beacon.json already exists at: ${configPath}`);
      
      // Read existing config to check auto_index setting
      try {
        const existingConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
        if (existingConfig.indexing?.auto_index === undefined) {
          console.log('⚠️  Existing config missing auto_index setting, updating...');
          const updatedConfig = { ...DEFAULT_CONFIG, ...existingConfig };
          if (updatedConfig.indexing) {
            updatedConfig.indexing.auto_index = true;
          }
          writeFileSync(configPath, JSON.stringify(updatedConfig, null, 2), 'utf-8');
          console.log('✅ Updated configuration with auto_index: true');
        } else {
          console.log(`✅ Configuration already has auto_index: ${existingConfig.indexing.auto_index}`);
        }
      } catch (err) {
        console.error('❌ Error reading existing config:', err.message);
      }
    }
    
    // Create .beacon directory for storage
    const beaconStorageDir = join(opencodeDir, '.beacon');
    if (!existsSync(beaconStorageDir)) {
      console.log(`📁 Creating beacon storage directory at: ${beaconStorageDir}`);
      mkdirSync(beaconStorageDir, { recursive: true });
    }
    
    console.log('🎉 Beacon plugin setup complete!');
    console.log('📋 Next steps:');
    console.log('   1. OpenCode will automatically index your codebase when you open a project');
    console.log('   2. Use the "search" command for semantic code search');
    console.log('   3. Use the "index" command to manually trigger indexing');
    
  } catch (error) {
    console.error('❌ Error during Beacon plugin setup:', error.message);
    process.exit(1);
  }
}

setupPlugin();