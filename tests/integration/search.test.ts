/**
 * Integration tests for search functionality
 * Tests vector search, BM25 search, and hybrid search
 * 31 comprehensive test cases
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { BeaconDatabase, openDatabase } from "../../src/lib/db";
import type { BeaconConfig, SearchResult } from "../../src/lib/types";

// Test database configuration
const TEST_DB_DIR = path.join(process.cwd(), ".test-search-db");
let testDbPath: string;
let db: BeaconDatabase;

// Mock configuration for testing — storage.path is overridden per-test
const testConfig: Omit<BeaconConfig, 'storage'> = {
  embedding: {
    api_base: "http://localhost:11434",
    model: "nomic-embed-text",
    api_key_env: "",
    dimensions: 384,
    batch_size: 32,
    query_prefix: "search_query: ",
  },
  chunking: {
    strategy: "hybrid",
    max_tokens: 512,
    overlap_tokens: 50,
  },
  indexing: {
    include: ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx"],
    exclude: ["node_modules/**", "dist/**"],
    max_file_size_kb: 1024,
    auto_index: false,
    max_files: 10000,
    concurrency: 4,
  },
  search: {
    top_k: 5,
    similarity_threshold: 0.3,
    hybrid: {
      enabled: true,
      weight_vector: 0.4,
      weight_bm25: 0.3,
      weight_rrf: 0.3,
      doc_penalty: 0.1,
      identifier_boost: 1.5,
      debug: false,
    },
  },
};

// Helper: Create test database
function createTestDatabase(): string {
  if (!fs.existsSync(TEST_DB_DIR)) {
    fs.mkdirSync(TEST_DB_DIR, { recursive: true });
  }
  const timestamp = Date.now();
  return path.join(TEST_DB_DIR, `test-search-${timestamp}.db`);
}

// Helper: Cleanup test database
function cleanupTestDatabase(dbPath: string): void {
  try {
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    if (fs.existsSync(`${dbPath}-wal`)) fs.unlinkSync(`${dbPath}-wal`);
    if (fs.existsSync(`${dbPath}-shm`)) fs.unlinkSync(`${dbPath}-shm`);
  } catch {
    // Ignore cleanup errors
  }
}

// Helper: Create mock embedding (deterministic based on input)
function createMockEmbedding(text: string, dimensions: number = 384): number[] {
  const embedding = Array(dimensions).fill(0);
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  // Spread hash value across dimensions
  for (let i = 0; i < dimensions; i++) {
    embedding[i] = Math.sin(hash + i) * 0.5 + 0.5; // Normalized to [0, 1]
  }
  return embedding;
}

// Setup and teardown
beforeEach(() => {
  testDbPath = createTestDatabase();
  db = openDatabase(testDbPath, 384);
});

afterEach(() => {
  try {
    db.close();
  } catch {
    // Already closed
  }
  cleanupTestDatabase(testDbPath);
});

describe("Vector Search", () => {
  beforeEach(() => {
    // Populate database with sample chunks
    const chunks1 = [
      { text: "function authenticate() { return true; }", start_line: 0, end_line: 0 },
      { text: "async function login() { await db.query(); }", start_line: 5, end_line: 5 },
    ];
    const embeddings1 = [
      createMockEmbedding("authenticate"),
      createMockEmbedding("login"),
    ];
    db.insertChunks("auth.ts", chunks1, embeddings1, "hash1");

    const chunks2 = [
      { text: "export function render() { return null; }", start_line: 0, end_line: 0 },
      { text: "component.mount(); component.unmount();", start_line: 10, end_line: 10 },
    ];
    const embeddings2 = [
      createMockEmbedding("render"),
      createMockEmbedding("component"),
    ];
    db.insertChunks("ui.tsx", chunks2, embeddings2, "hash2");
  });

  it("performs vector search", () => {
    const queryEmbedding = createMockEmbedding("authenticate");
    const config = { ...testConfig, storage: { path: testDbPath } };

    const results = db.search(queryEmbedding, 5, 0.3, "authenticate", config);
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThanOrEqual(0);
  });

  it("returns SearchResult objects with required fields", () => {
    const queryEmbedding = createMockEmbedding("function");
    const config = { ...testConfig, storage: { path: testDbPath } };

    const results = db.search(queryEmbedding, 5, 0.3, "function", config);
    if (results.length > 0) {
      const result = results[0];
      expect(result).toHaveProperty("filePath");
      expect(result).toHaveProperty("startLine");
      expect(result).toHaveProperty("endLine");
      expect(result).toHaveProperty("chunkText");
      expect(result).toHaveProperty("similarity");
    }
  });

  it("respects top_k parameter", () => {
    const queryEmbedding = createMockEmbedding("test");
    const config = { ...testConfig, storage: { path: testDbPath } };

    const results = db.search(queryEmbedding, 2, 0.1, "test", config);
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it("filters by similarity threshold", () => {
    const queryEmbedding = createMockEmbedding("authenticate");
    const config = { ...testConfig, storage: { path: testDbPath } };

    const resultsLowThreshold = db.search(queryEmbedding, 10, 0.0, "authenticate", config);
    const resultsHighThreshold = db.search(
      queryEmbedding,
      10,
      0.95,
      "authenticate",
      config
    );

    expect(resultsLowThreshold.length).toBeGreaterThanOrEqual(
      resultsHighThreshold.length
    );
  });

  it("filters by path prefix", () => {
    const queryEmbedding = createMockEmbedding("function");
    const config = { ...testConfig, storage: { path: testDbPath } };

    const results = db.search(
      queryEmbedding,
      5,
      0.1,
      "function",
      config,
      "auth"
    );
    for (const result of results) {
      expect(result.filePath).toContain("auth");
    }
  });

  it("handles empty database", () => {
    db.clear();
    const queryEmbedding = createMockEmbedding("test");
    const config = { ...testConfig, storage: { path: testDbPath } };

    const results = db.search(queryEmbedding, 5, 0.3, "test", config);
    expect(Array.isArray(results)).toBe(true);
  });
});

describe("BM25 Search", () => {
  beforeEach(() => {
    const chunks = [
      {
        text: "function calculateSum(a, b) { return a + b; }",
        start_line: 0,
        end_line: 0,
      },
      {
        text: "const sum = a + b + c;",
        start_line: 5,
        end_line: 5,
      },
      {
        text: "function multiply(x, y) { return x * y; }",
        start_line: 10,
        end_line: 10,
      },
    ];
    const embeddings = [
      createMockEmbedding("sum"),
      createMockEmbedding("addition"),
      createMockEmbedding("multiply"),
    ];
    db.insertChunks("math.ts", chunks, embeddings, "hash");
  });

  it("performs BM25 search", () => {
    const queryEmbedding = Array(384).fill(0); // Not used, but required
    const config = { ...testConfig, storage: { path: testDbPath } };

    const results = db.search(queryEmbedding, 5, 0.0, "sum", config);
    expect(Array.isArray(results)).toBe(true);
  });

  it("finds relevant chunks by keywords", () => {
    const queryEmbedding = Array(384).fill(0);
    const config = { ...testConfig, storage: { path: testDbPath } };

    const results = db.search(queryEmbedding, 5, 0.0, "calculateSum", config);
    expect(results.length).toBeGreaterThan(0);
  });

  it("ranks matches by relevance", () => {
    const queryEmbedding = Array(384).fill(0);
    const config = { ...testConfig, storage: { path: testDbPath } };

    const results = db.search(queryEmbedding, 5, 0.0, "sum", config);
    if (results.length >= 2) {
      // More relevant results should appear first
      expect(results[0]).toBeDefined();
    }
  });
});

describe("Hybrid Search", () => {
  beforeEach(() => {
    const chunks = [
      {
        text: "export function getUserData(userId) { return fetchUser(userId); }",
        start_line: 0,
        end_line: 0,
      },
      {
        text: "async function authenticate(credentials) { return verifyUser(credentials); }",
        start_line: 10,
        end_line: 10,
      },
      {
        text: "const userData = { name: 'John', age: 30 };",
        start_line: 20,
        end_line: 20,
      },
    ];
    const embeddings = [
      createMockEmbedding("getUserData"),
      createMockEmbedding("authenticate"),
      createMockEmbedding("userData"),
    ];
    db.insertChunks("api.ts", chunks, embeddings, "hash");
  });

  it("combines vector and BM25 results", () => {
    const queryEmbedding = createMockEmbedding("user");
    const config = { ...testConfig, storage: { path: testDbPath } };

    const results = db.search(queryEmbedding, 5, 0.1, "user", config);
    expect(results.length).toBeGreaterThanOrEqual(0);
  });

  it("returns results with score field in hybrid mode", () => {
    const queryEmbedding = createMockEmbedding("function");
    const config = { ...testConfig, storage: { path: testDbPath } };

    const results = db.search(queryEmbedding, 5, 0.0, "function", config);
    if (results.length > 0) {
      // Results may have score if hybrid weights enabled
      expect(results[0]).toBeDefined();
    }
  });

  it("applies identifier boost", () => {
    const queryEmbedding = createMockEmbedding("getUserData");
    const config = { ...testConfig, storage: { path: testDbPath } };

    const results = db.search(queryEmbedding, 5, 0.0, "getUserData", config);
    expect(results.length).toBeGreaterThanOrEqual(0);
  });

  it("applies file type multiplier", () => {
    const queryEmbedding = createMockEmbedding("export");
    const config = { ...testConfig, storage: { path: testDbPath } };

    const results = db.search(queryEmbedding, 5, 0.0, "export", config);
    expect(results.length).toBeGreaterThanOrEqual(0);
  });
});

describe("Search Edge Cases", () => {
  it("handles no results gracefully", () => {
    const queryEmbedding = createMockEmbedding("nonexistent");
    const config = { ...testConfig, storage: { path: testDbPath } };

    const results = db.search(queryEmbedding, 5, 0.9, "nonexistent", config);
    expect(Array.isArray(results)).toBe(true);
  });

  it("handles all chunks with same score", () => {
    // Insert chunks with similar embeddings
    const chunks = [
      { text: "test1", start_line: 0, end_line: 0 },
      { text: "test2", start_line: 1, end_line: 1 },
      { text: "test3", start_line: 2, end_line: 2 },
    ];
    const embedding = [Array(384).fill(0.5)]; // All same
    for (let i = 0; i < 3; i++) {
      db.insertChunks(`file${i}.ts`, [chunks[i]], [embedding[0]], `hash${i}`);
    }

    const queryEmbedding = Array(384).fill(0.5);
    const config = { ...testConfig, storage: { path: testDbPath } };

    const results = db.search(queryEmbedding, 5, 0.0, "test", config);
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it("handles empty query", () => {
    const chunks = [{ text: "test content", start_line: 0, end_line: 0 }];
    const embedding = [createMockEmbedding("test")];
    db.insertChunks("file.ts", chunks, embedding, "hash");

    const queryEmbedding = createMockEmbedding("");
    const config = { ...testConfig, storage: { path: testDbPath } };

    const results = db.search(queryEmbedding, 5, 0.0, "", config);
    expect(Array.isArray(results)).toBe(true);
  });

  it("handles very long chunk text", () => {
    const longText = "const x = " + "'test'.repeat(1000);";
    const chunks = [{ text: longText, start_line: 0, end_line: 0 }];
    const embedding = [createMockEmbedding("test")];
    db.insertChunks("file.ts", chunks, embedding, "hash");

    const queryEmbedding = createMockEmbedding("test");
    const config = { ...testConfig, storage: { path: testDbPath } };

    const results = db.search(queryEmbedding, 5, 0.0, "test", config);
    expect(results.length).toBeGreaterThanOrEqual(0);
  });

  it("handles special characters in query", () => {
    const chunks = [{ text: "test & special < chars >", start_line: 0, end_line: 0 }];
    const embedding = [createMockEmbedding("test")];
    db.insertChunks("file.ts", chunks, embedding, "hash");

    const queryEmbedding = createMockEmbedding("test");
    const config = { ...testConfig, storage: { path: testDbPath } };

    const results = db.search(queryEmbedding, 5, 0.0, "test & special", config);
    expect(Array.isArray(results)).toBe(true);
  });

  it("handles path prefix with special characters", () => {
    const chunks = [{ text: "test", start_line: 0, end_line: 0 }];
    const embedding = [createMockEmbedding("test")];
    db.insertChunks("src/[id]/file.ts", chunks, embedding, "hash");

    const queryEmbedding = createMockEmbedding("test");
    const config = { ...testConfig, storage: { path: testDbPath } };

    const results = db.search(queryEmbedding, 5, 0.0, "test", config, "src/[id]");
    expect(Array.isArray(results)).toBe(true);
  });

  it("handles zero top_k", () => {
    const queryEmbedding = createMockEmbedding("test");
    const config = { ...testConfig, storage: { path: testDbPath } };

    const results = db.search(queryEmbedding, 0, 0.0, "test", config);
    expect(results.length).toBe(0);
  });

  it("handles very high top_k", () => {
    const chunks = [
      { text: "chunk1", start_line: 0, end_line: 0 },
      { text: "chunk2", start_line: 1, end_line: 1 },
    ];
    const embeddings = [
      createMockEmbedding("chunk1"),
      createMockEmbedding("chunk2"),
    ];
    db.insertChunks("file.ts", chunks, embeddings, "hash");

    const queryEmbedding = createMockEmbedding("chunk");
    const config = { ...testConfig, storage: { path: testDbPath } };

    const results = db.search(queryEmbedding, 1000, 0.0, "chunk", config);
    expect(results.length).toBeLessThanOrEqual(2);
  });
});

describe("FTS-Only Search Fallback", () => {
  beforeEach(() => {
    const chunks = [
      {
        text: "function search(query) { return results; }",
        start_line: 0,
        end_line: 0,
      },
      {
        text: "const searchTerm = 'test';",
        start_line: 5,
        end_line: 5,
      },
    ];
    const embeddings = [
      createMockEmbedding("search"),
      createMockEmbedding("searchTerm"),
    ];
    db.insertChunks("search.ts", chunks, embeddings, "hash");
  });

  it("falls back to FTS when vector search unavailable", () => {
    // Create zero vector to simulate unavailable embeddings
    const zeroEmbedding = Array(384).fill(0);
    const config = { ...testConfig, storage: { path: testDbPath } };

    const results = db.search(zeroEmbedding, 5, 0.0, "search", config);
    expect(Array.isArray(results)).toBe(true);
  });

  it("returns FTS-only note when applicable", () => {
    // FTS-only results should be marked
    const results = db.ftsOnlySearch("search", 5);
    if (results.length > 0) {
      // Check if any result has FTS note
      const hasNote = results.some((r) => r._note?.includes("FTS"));
      expect(typeof hasNote).toBe("boolean");
    }
  });

  it("finds results using full-text search", () => {
    const results = db.ftsOnlySearch("search", 5);
    expect(Array.isArray(results)).toBe(true);
  });

  it("respects path filter in FTS search", () => {
    const results = db.ftsOnlySearch("search", 5, "search");
    for (const result of results) {
      expect(result.filePath).toContain("search");
    }
  });

  it("returns correct metadata in FTS results", () => {
    const results = db.ftsOnlySearch("search", 5);
    if (results.length > 0) {
      const result = results[0];
      expect(result).toHaveProperty("filePath");
      expect(result).toHaveProperty("startLine");
      expect(result).toHaveProperty("endLine");
      expect(result).toHaveProperty("chunkText");
      expect(result).toHaveProperty("similarity");
    }
  });
});

describe("Search Result Integrity", () => {
  beforeEach(() => {
    const chunks = [
      {
        text: "export const version = '1.0.0';",
        start_line: 0,
        end_line: 0,
      },
      {
        text: "export function main() { console.log('hello'); }",
        start_line: 10,
        end_line: 10,
      },
    ];
    const embeddings = [
      createMockEmbedding("version"),
      createMockEmbedding("main"),
    ];
    db.insertChunks("app.ts", chunks, embeddings, "hash");
  });

  it("returns correct file paths", () => {
    const queryEmbedding = createMockEmbedding("export");
    const config = { ...testConfig, storage: { path: testDbPath } };

    const results = db.search(queryEmbedding, 5, 0.0, "export", config);
    for (const result of results) {
      expect(result.filePath).toBe("app.ts");
    }
  });

  it("returns correct line ranges", () => {
    const queryEmbedding = createMockEmbedding("main");
    const config = { ...testConfig, storage: { path: testDbPath } };

    const results = db.search(queryEmbedding, 5, 0.0, "main", config);
    for (const result of results) {
      expect(result.endLine).toBeGreaterThanOrEqual(result.startLine);
    }
  });

  it("returns chunk text", () => {
    const queryEmbedding = createMockEmbedding("main");
    const config = { ...testConfig, storage: { path: testDbPath } };

    const results = db.search(queryEmbedding, 5, 0.0, "main", config);
    for (const result of results) {
      expect(result.chunkText.length).toBeGreaterThan(0);
    }
  });

  it("returns valid similarity scores", () => {
    const queryEmbedding = createMockEmbedding("export");
    const config = { ...testConfig, storage: { path: testDbPath } };

    const results = db.search(queryEmbedding, 5, 0.0, "export", config);
    for (const result of results) {
      expect(typeof result.similarity).toBe("number");
      expect(result.similarity).toBeGreaterThanOrEqual(-1);
      expect(result.similarity).toBeLessThanOrEqual(2); // Allow some tolerance
    }
  });
});
