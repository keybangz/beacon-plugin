import path from 'path';
import { openDatabase } from './dist/lib/db.js';
import { loadConfig } from './dist/lib/config.js';
import { Embedder } from './dist/lib/embedder.js';
import { IndexCoordinator } from './dist/lib/sync.js';
import { mkdirSync, existsSync } from 'fs';

async function testPlugin() {
  try {
    const repoRoot = process.cwd();
    const config = loadConfig(repoRoot);
    
    const storagePath = path.join(repoRoot, config.storage.path);
    if (!existsSync(storagePath)) {
      mkdirSync(storagePath, { recursive: true });
    }
    
    const dbPath = path.join(storagePath, 'embeddings.db');
    
    // Initialize database
    const db = openDatabase(dbPath, config.embedding.dimensions);
    
    try {
      // Initialize embedder
      const embedder = new Embedder(config.embedding);
      
      // Create index coordinator
      const coordinator = new IndexCoordinator(config, db, embedder, repoRoot);
      
      // Perform full index
      console.log('Starting full index...');
      const startTime = Date.now();
      const result = await coordinator.performFullIndex();
      const endTime = Date.now();
      
      console.log('✓ Indexing complete!');
      console.log('Files indexed:', result.filesIndexed);
      console.log('Duration:', ((endTime - startTime) / 1000).toFixed(2), 'seconds');
      
      const stats = db.getStats();
      console.log('Database stats:', stats);
      
      // Now try searching with Beacon
      if (stats.total_chunks > 0) {
        console.log('\n--- Testing Beacon Search ---');
        try {
          const queryEmbedding = await embedder.embedDocuments(['function']);
          const results = db.search(queryEmbedding[0], 5, 0.35, 'function', config);
          console.log('Search results for "function":', results.length, 'matches');
          results.slice(0, 2).forEach((r, i) => {
            console.log(`  ${i+1}. ${r.filePath}:${r.startLine}-${r.endLine} (score: ${r.similarity.toFixed(3)})`);
          });
        } catch (searchError) {
          console.log('Search error (expected if no embedding server):', searchError.message);
        }
      }
      
    } finally {
      db.close();
    }
    
  } catch (error) {
    console.error('Error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

testPlugin();
