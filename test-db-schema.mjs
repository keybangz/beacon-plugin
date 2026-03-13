import path from 'path';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { mkdirSync, existsSync } from 'fs';
import { join } from 'path';

const repoRoot = process.cwd();
const storagePath = join(repoRoot, '.opencode/.beacon');
if (!existsSync(storagePath)) {
  mkdirSync(storagePath, { recursive: true });
}

const dbPath = join(storagePath, 'test-schema.db');
const db = new Database(dbPath);

// Load sqlite-vec extension
try {
  sqliteVec.load(db);
  console.log('sqlite-vec loaded successfully');
} catch (e) {
  console.log('sqlite-vec load error:', e.message);
}

// Try creating the chunks_vec table
try {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
      chunk_id INTEGER PRIMARY KEY,
      embedding float[768] distance_metric=cosine
    )
  `);
  console.log('chunks_vec table created');
} catch (e) {
  console.log('chunks_vec error:', e.message);
}

// Check what tables exist
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log('Tables:', tables.map(t => t.name));

db.close();
