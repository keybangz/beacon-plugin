import path from 'path';
import { openDatabase } from './dist/lib/db.js';
import { loadConfig } from './dist/lib/config.js';
import { Embedder } from './dist/lib/embedder.js';
import { IndexCoordinator } from './dist/lib/sync.js';
import { mkdirSync, existsSync } from 'fs';
import { join } from 'path';

async function testTraceIndex() {
  try {
    const repoRoot = process.cwd();
    const config = loadConfig(repoRoot);
    
    console.log('Config loaded');
    console.log('  Concurrency:', config.indexing.concurrency);
    console.log('  Max file size KB:', config.indexing.max_file_size_kb);
    console.log('  Max tokens per chunk:', config.chunking.max_tokens);
    
    const storagePath = path.join(repoRoot, config.storage.path);
    if (!existsSync(storagePath)) {
      mkdirSync(storagePath, { recursive: true });
    }
    
    const dbPath = path.join(storagePath, 'embeddings.db');
    const db = openDatabase(dbPath, config.embedding.dimensions);
    
    try {
      const embedder = new Embedder(config.embedding);
      
      // Test that embedder works
      const ping = await embedder.ping();
      console.log('Embedder ping:', ping.ok ? 'OK' : ping.error);
      
      if (!ping.ok) {
        console.error('Embedder not available, cannot proceed');
        process.exit(1);
      }
      
      // Try embedding a simple test
      const testEmbed = await embedder.embedDocuments(['test']);
      console.log('Test embedding:', testEmbed[0].length, 'dimensions');
      
      const coordinator = new IndexCoordinator(config, db, embedder, repoRoot);
      console.log('IndexCoordinator created');
      
      console.log('\nStarting full index...');
      const result = await coordinator.performFullIndex();
      
      console.log('Result:', result);
      
      const stats = db.getStats();
      console.log('Final stats:', stats);
      
    } finally {
      db.close();
    }
    
  } catch (error) {
    console.error('Error:', error.message);
    console.error('Stack:', error.stack);
    process.exit(1);
  }
}

testTraceIndex();
