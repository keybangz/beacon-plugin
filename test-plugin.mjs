import path from 'path';
import { openDatabase } from './dist/lib/db.js';
import { loadConfig } from './dist/lib/config.js';
import { Embedder } from './dist/lib/embedder.js';
import { getRepoRoot } from './dist/lib/repo-root.js';
import { IndexCoordinator } from './dist/lib/sync.js';
import { mkdirSync, existsSync } from 'fs';

async function testPlugin() {
  try {
    console.log('Testing Beacon Plugin...\n');
    
    const repoRoot = process.cwd();
    console.log('Repo root:', repoRoot);
    
    const config = loadConfig(repoRoot);
    console.log('Config loaded:', {
      embedding_model: config.embedding.model,
      storage_path: config.storage.path
    });
    
    const storagePath = path.join(repoRoot, config.storage.path);
    if (!existsSync(storagePath)) {
      mkdirSync(storagePath, { recursive: true });
    }
    
    const dbPath = path.join(storagePath, 'embeddings.db');
    console.log('Database path:', dbPath);
    
    // Initialize database
    const db = openDatabase(dbPath, config.embedding.dimensions);
    console.log('Database opened\n');
    
    try {
      // Initialize embedder
      const embedder = new Embedder(config.embedding);
      console.log('Embedder initialized');
      
      // Test embedder ping
      const pingResult = await embedder.ping();
      console.log('Embedder ping:', pingResult);
      
      if (!pingResult.ok) {
        console.log('WARNING: Embedding server not available');
        console.log('Error:', pingResult.error);
      }
      
      // Create index coordinator
      const coordinator = new IndexCoordinator(config, db, embedder, repoRoot);
      console.log('IndexCoordinator created\n');
      
      // Perform full index
      console.log('Starting full index...');
      const startTime = Date.now();
      const result = await coordinator.performFullIndex();
      const endTime = Date.now();
      const durationSeconds = ((endTime - startTime) / 1000).toFixed(2);
      
      console.log('\n✓ Indexing complete!');
      console.log('Results:', {
        files_indexed: result.filesIndexed,
        duration_seconds: parseFloat(durationSeconds),
        errors: result.errors?.length || 0
      });
      
      const stats = db.getStats();
      console.log('Database stats:', {
        total_chunks: stats.total_chunks,
        database_size_mb: stats.database_size_mb,
        files_indexed: stats.files_indexed
      });
      
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
