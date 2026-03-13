import path from 'path';
import { execSync } from 'child_process';
import { openDatabase } from './dist/lib/db.js';
import { loadConfig } from './dist/lib/config.js';
import { Embedder } from './dist/lib/embedder.js';
import { chunkCode } from './dist/lib/chunker.js';
import { readFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';

function getFileHash(content) {
  return createHash('sha256').update(content).digest('hex');
}

async function testFullIndex() {
  try {
    const repoRoot = process.cwd();
    const config = loadConfig(repoRoot);
    
    const storagePath = path.join(repoRoot, config.storage.path);
    if (!existsSync(storagePath)) {
      mkdirSync(storagePath, { recursive: true });
    }
    
    const dbPath = path.join(storagePath, 'embeddings.db');
    const db = openDatabase(dbPath, config.embedding.dimensions);
    
    try {
      // Get tracked files
      const result = execSync('git ls-files', { cwd: repoRoot, encoding: 'utf-8' });
      const allFiles = result.trim().split('\n').filter(l => l.length > 0);
      console.log(`Total tracked files: ${allFiles.length}`);
      
      // Filter by file type
      const tsFiles = allFiles.filter(f => f.endsWith('.ts') || f.endsWith('.tsx') || f.endsWith('.md'));
      console.log(`TypeScript/Markdown files: ${tsFiles.length}`);
      console.log('First 5:', tsFiles.slice(0, 5));
      
      // Test reading one file
      if (tsFiles.length > 0) {
        const testFile = tsFiles[0];
        const fullPath = join(repoRoot, testFile);
        const content = readFileSync(fullPath, 'utf-8');
        const chunks = chunkCode(content);
        console.log(`\nFile: ${testFile}`);
        console.log(`  Content length: ${content.length} bytes`);
        console.log(`  Chunks created: ${chunks.length}`);
      }
      
    } finally {
      db.close();
    }
    
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

testFullIndex();
