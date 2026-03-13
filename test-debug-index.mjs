import path from 'path';
import { execSync } from 'child_process';
import { openDatabase } from './dist/lib/db.js';
import { loadConfig } from './dist/lib/config.js';
import { Embedder } from './dist/lib/embedder.js';
import { IndexCoordinator } from './dist/lib/sync.js';
import { mkdirSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { readFileSync } from 'fs';
import { createHash } from 'crypto';

function getFileHash(content) {
  return createHash('sha256').update(content).digest('hex');
}

async function testDebugIndex() {
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
      // Clear database first
      db.clear();
      console.log('Database cleared');
      
      // Get tracked files
      const result = execSync('git ls-files', { cwd: repoRoot, encoding: 'utf-8' });
      const allFiles = result.trim().split('\n').filter(l => l.length > 0);
      console.log(`Total tracked files: ${allFiles.length}`);
      
      // Test the hash check logic
      const testFile = allFiles.find(f => f.endsWith('.ts'));
      if (testFile) {
        const fullPath = join(repoRoot, testFile);
        const content = readFileSync(fullPath, 'utf-8');
        const newHash = getFileHash(content);
        const storedHash = db.getFileHash(testFile);
        
        console.log(`\nTest file: ${testFile}`);
        console.log(`  Stored hash: ${storedHash}`);
        console.log(`  New hash: ${newHash}`);
        console.log(`  Should index: ${storedHash !== newHash}`);
      }
      
    } finally {
      db.close();
    }
    
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

testDebugIndex();
