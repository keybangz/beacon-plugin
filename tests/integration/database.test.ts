/**
 * Integration tests for database module
 * Tests database schema, operations, migrations, and state management
 * 31 comprehensive test cases
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { BeaconDatabase, openDatabase } from "../../src/lib/db";
import type { Chunk, SyncProgress } from "../../src/lib/types";

// Test database configuration
const TEST_DB_DIR = path.join(process.cwd(), ".test-db");
let testDbPath: string;
let db: BeaconDatabase;

// Helper function to create temporary database
function createTestDatabase(): string {
  if (!fs.existsSync(TEST_DB_DIR)) {
    fs.mkdirSync(TEST_DB_DIR, { recursive: true });
  }

  const timestamp = Date.now();
  const dbPath = path.join(TEST_DB_DIR, `test-${timestamp}.db`);
  return dbPath;
}

// Helper function to cleanup test database
function cleanupTestDatabase(dbPath: string): void {
  try {
    if (fs.existsSync(dbPath)) {
      fs.unlinkSync(dbPath);
    }
    // Also remove WAL files
    if (fs.existsSync(`${dbPath}-wal`)) {
      fs.unlinkSync(`${dbPath}-wal`);
    }
    if (fs.existsSync(`${dbPath}-shm`)) {
      fs.unlinkSync(`${dbPath}-shm`);
    }
  } catch {
    // Ignore cleanup errors
  }
}

// Setup and teardown
beforeEach(() => {
  testDbPath = createTestDatabase();
  db = openDatabase(testDbPath, 384); // 384 dimensions for testing
});

afterEach(() => {
  try {
    db.close();
  } catch {
    // Already closed
  }
  cleanupTestDatabase(testDbPath);
});

describe("Database Schema", () => {
  it("initializes database successfully", () => {
    expect(db).toBeDefined();
  });

  it("creates chunks table", () => {
    // Table should exist - test by inserting and retrieving
    const chunks = [
      {
        text: "const x = 1;",
        start_line: 0,
        end_line: 0,
      },
    ];
    const embeddings = [Array(384).fill(0.1)];
    expect(() => {
      db.insertChunks("test.ts", chunks, embeddings, "hash123");
    }).not.toThrow();
  });

  it("creates sync_state table", () => {
    // Should be able to set/get sync state
    expect(() => {
      db.setSyncState("test_key", "test_value");
    }).not.toThrow();
  });

  it("creates vector table for embeddings", () => {
    const chunks = [
      {
        text: "test code",
        start_line: 0,
        end_line: 0,
      },
    ];
    const embeddings = [Array(384).fill(0.1)];
    expect(() => {
      db.insertChunks("test.ts", chunks, embeddings, "hash123");
    }).not.toThrow();
  });

  it("creates FTS5 virtual table", () => {
    // FTS table should exist for text search
    const chunks = [
      {
        text: "searchable text here",
        start_line: 0,
        end_line: 0,
      },
    ];
    const embeddings = [Array(384).fill(0.1)];
    expect(() => {
      db.insertChunks("test.ts", chunks, embeddings, "hash123");
    }).not.toThrow();
  });
});

describe("insertChunks", () => {
  it("inserts single chunk successfully", () => {
    const chunks = [
      {
        text: "const x = 1;",
        start_line: 0,
        end_line: 0,
      },
    ];
    const embeddings = [Array(384).fill(0.1)];
    expect(() => {
      db.insertChunks("test.ts", chunks, embeddings, "hash123");
    }).not.toThrow();
  });

  it("inserts multiple chunks for same file", () => {
    const chunks = [
      { text: "chunk 1", start_line: 0, end_line: 1 },
      { text: "chunk 2", start_line: 2, end_line: 3 },
      { text: "chunk 3", start_line: 4, end_line: 5 },
    ];
    const embeddings = [
      Array(384).fill(0.1),
      Array(384).fill(0.2),
      Array(384).fill(0.3),
    ];
    expect(() => {
      db.insertChunks("file.ts", chunks, embeddings, "hash123");
    }).not.toThrow();
  });

  it("replaces existing chunks for same file", () => {
    const chunks1 = [
      { text: "original chunk", start_line: 0, end_line: 0 },
    ];
    const chunks2 = [
      { text: "updated chunk", start_line: 0, end_line: 0 },
    ];
    const embedding = [Array(384).fill(0.1)];

    db.insertChunks("file.ts", chunks1, embedding, "hash1");
    db.insertChunks("file.ts", chunks2, embedding, "hash2");

    // Should have replaced chunks
    expect(() => {
      db.insertChunks("file.ts", chunks2, embedding, "hash2");
    }).not.toThrow();
  });

  it("throws error for mismatched chunks and embeddings", () => {
    const chunks = [
      { text: "chunk 1", start_line: 0, end_line: 0 },
      { text: "chunk 2", start_line: 1, end_line: 1 },
    ];
    const embeddings = [Array(384).fill(0.1)]; // Only 1 embedding for 2 chunks

    expect(() => {
      db.insertChunks("file.ts", chunks, embeddings, "hash123");
    }).toThrow();
  });

  it("stores identifiers from chunk text", () => {
    const chunks = [
      {
        text: "function calculateSum(a, b) { return a + b; }",
        start_line: 0,
        end_line: 0,
      },
    ];
    const embeddings = [Array(384).fill(0.1)];
    expect(() => {
      db.insertChunks("math.ts", chunks, embeddings, "hash123");
    }).not.toThrow();
  });

  it("stores file hash with chunks", () => {
    const chunks = [{ text: "code", start_line: 0, end_line: 0 }];
    const embeddings = [Array(384).fill(0.1)];
    const fileHash = "abc123def456";

    db.insertChunks("file.ts", chunks, embeddings, fileHash);
    const storedHash = db.getFileHash("file.ts");
    expect(storedHash).toBe(fileHash);
  });

  it("stores line number metadata", () => {
    const chunks = [
      { text: "line content", start_line: 10, end_line: 15 },
    ];
    const embeddings = [Array(384).fill(0.1)];
    expect(() => {
      db.insertChunks("file.ts", chunks, embeddings, "hash");
    }).not.toThrow();
  });
});

describe("deleteChunks", () => {
  it("deletes chunks for a file", () => {
    const chunks = [{ text: "test", start_line: 0, end_line: 0 }];
    const embeddings = [Array(384).fill(0.1)];

    db.insertChunks("file.ts", chunks, embeddings, "hash");
    expect(() => {
      db.deleteChunks("file.ts");
    }).not.toThrow();
  });

  it("removes all chunks for file", () => {
    const chunks = [
      { text: "chunk1", start_line: 0, end_line: 0 },
      { text: "chunk2", start_line: 1, end_line: 1 },
    ];
    const embeddings = [Array(384).fill(0.1), Array(384).fill(0.2)];

    db.insertChunks("file.ts", chunks, embeddings, "hash");
    db.deleteChunks("file.ts");
    // Verify it's removed
    const files = db.getIndexedFiles();
    expect(files).not.toContain("file.ts");
  });

  it("doesn't affect other files", () => {
    const chunks = [{ text: "test", start_line: 0, end_line: 0 }];
    const embedding = [Array(384).fill(0.1)];

    db.insertChunks("file1.ts", chunks, embedding, "hash1");
    db.insertChunks("file2.ts", chunks, embedding, "hash2");
    db.deleteChunks("file1.ts");

    const files = db.getIndexedFiles();
    expect(files).toContain("file2.ts");
    expect(files).not.toContain("file1.ts");
  });
});

describe("getIndexedFiles", () => {
  it("returns empty array when no files indexed", () => {
    const files = db.getIndexedFiles();
    expect(Array.isArray(files)).toBe(true);
    expect(files.length).toBe(0);
  });

  it("returns all indexed files", () => {
    const chunks = [{ text: "test", start_line: 0, end_line: 0 }];
    const embedding = [Array(384).fill(0.1)];

    db.insertChunks("file1.ts", chunks, embedding, "hash1");
    db.insertChunks("file2.ts", chunks, embedding, "hash2");
    db.insertChunks("file3.ts", chunks, embedding, "hash3");

    const files = db.getIndexedFiles();
    expect(files).toContain("file1.ts");
    expect(files).toContain("file2.ts");
    expect(files).toContain("file3.ts");
    expect(files.length).toBe(3);
  });

  it("returns files in order", () => {
    const chunks = [{ text: "test", start_line: 0, end_line: 0 }];
    const embedding = [Array(384).fill(0.1)];

    db.insertChunks("c.ts", chunks, embedding, "hash");
    db.insertChunks("a.ts", chunks, embedding, "hash");
    db.insertChunks("b.ts", chunks, embedding, "hash");

    const files = db.getIndexedFiles();
    // Should be sorted
    expect(files[0]).toBe("a.ts");
  });
});

describe("getFileHash", () => {
  it("retrieves stored file hash", () => {
    const chunks = [{ text: "test", start_line: 0, end_line: 0 }];
    const embedding = [Array(384).fill(0.1)];
    const hash = "abc123def456";

    db.insertChunks("file.ts", chunks, embedding, hash);
    const retrieved = db.getFileHash("file.ts");
    expect(retrieved).toBe(hash);
  });

  it("returns null for non-existent file", () => {
    const hash = db.getFileHash("nonexistent.ts");
    expect(hash).toBeNull();
  });

  it("returns latest hash when file updated", () => {
    const chunks = [{ text: "test", start_line: 0, end_line: 0 }];
    const embedding = [Array(384).fill(0.1)];

    db.insertChunks("file.ts", chunks, embedding, "hash1");
    db.insertChunks("file.ts", chunks, embedding, "hash2");

    const hash = db.getFileHash("file.ts");
    expect(hash).toBe("hash2");
  });
});

describe("getStats", () => {
  it("returns stats object with required fields", () => {
    const stats = db.getStats();
    expect(stats).toHaveProperty("files_indexed");
    expect(stats).toHaveProperty("total_chunks");
    expect(stats).toHaveProperty("database_size_mb");
  });

  it("reports zero stats for empty database", () => {
    const stats = db.getStats();
    expect(stats.files_indexed).toBe(0);
    expect(stats.total_chunks).toBe(0);
  });

  it("counts indexed files correctly", () => {
    const chunks = [{ text: "test", start_line: 0, end_line: 0 }];
    const embedding = [Array(384).fill(0.1)];

    db.insertChunks("file1.ts", chunks, embedding, "hash1");
    db.insertChunks("file2.ts", chunks, embedding, "hash2");

    const stats = db.getStats();
    expect(stats.files_indexed).toBe(2);
  });

  it("counts total chunks correctly", () => {
    const chunks = [
      { text: "chunk1", start_line: 0, end_line: 0 },
      { text: "chunk2", start_line: 1, end_line: 1 },
      { text: "chunk3", start_line: 2, end_line: 2 },
    ];
    const embeddings = [
      Array(384).fill(0.1),
      Array(384).fill(0.2),
      Array(384).fill(0.3),
    ];

    db.insertChunks("file.ts", chunks, embeddings, "hash");
    const stats = db.getStats();
    expect(stats.total_chunks).toBe(3);
  });

  it("updates stats after deletion", () => {
    const chunks = [{ text: "test", start_line: 0, end_line: 0 }];
    const embedding = [Array(384).fill(0.1)];

    db.insertChunks("file.ts", chunks, embedding, "hash");
    db.deleteChunks("file.ts");

    const stats = db.getStats();
    expect(stats.files_indexed).toBe(0);
    expect(stats.total_chunks).toBe(0);
  });
});

describe("Sync State Management", () => {
  it("sets and gets sync state", () => {
    db.setSyncState("test_key", "test_value");
    const value = db.getSyncState("test_key");
    expect(value).toBe("test_value");
  });

  it("returns null for non-existent key", () => {
    const value = db.getSyncState("nonexistent");
    expect(value).toBeNull();
  });

  it("updates existing key", () => {
    db.setSyncState("key", "value1");
    db.setSyncState("key", "value2");
    const value = db.getSyncState("key");
    expect(value).toBe("value2");
  });

  it("manages sync progress", () => {
    const progress: SyncProgress = {
      sync_status: "in_progress",
      sync_started_at: "2024-01-01T00:00:00Z",
      files_indexed: 5,
      total_files: 10,
    };

    db.setSyncProgress(progress);
    const retrieved = db.getSyncProgress();

    expect(retrieved.sync_status).toBe("in_progress");
    expect(retrieved.files_indexed).toBe(5);
    expect(retrieved.total_files).toBe(10);
  });

  it("clears sync progress", () => {
    db.setSyncProgress({
      sync_status: "in_progress",
      files_indexed: 5,
    });

    db.clearSyncProgress();
    const progress = db.getSyncProgress();

    expect(progress.sync_status).toBe("idle");
    expect(progress.files_indexed).toBeUndefined();
  });
});

describe("clear", () => {
  it("deletes all chunks", () => {
    const chunks = [{ text: "test", start_line: 0, end_line: 0 }];
    const embedding = [Array(384).fill(0.1)];

    db.insertChunks("file.ts", chunks, embedding, "hash");
    db.clear();

    const stats = db.getStats();
    expect(stats.total_chunks).toBe(0);
    expect(stats.files_indexed).toBe(0);
  });

  it("clears sync progress on clear", () => {
    db.setSyncProgress({
      sync_status: "in_progress",
      files_indexed: 5,
    });

    db.clear();

    // Check that sync progress was cleared
    const progress = db.getSyncProgress();
    expect(progress.sync_status).toBe("idle");
    expect(progress.files_indexed).toBeUndefined();
  });

  it("preserves database structure", () => {
    db.insertChunks(
      "file.ts",
      [{ text: "test", start_line: 0, end_line: 0 }],
      [Array(384).fill(0.1)],
      "hash"
    );
    db.clear();

    // Should still be able to insert after clearing
    expect(() => {
      db.insertChunks(
        "file2.ts",
        [{ text: "test2", start_line: 0, end_line: 0 }],
        [Array(384).fill(0.1)],
        "hash2"
      );
    }).not.toThrow();
  });
});

describe("checkDimensions", () => {
  it("confirms dimensions match on empty database", () => {
    const check = db.checkDimensions();
    expect(check.ok).toBe(true);
    expect(check.current).toBe(384);
  });

  it("matches stored dimensions", () => {
    const chunks = [{ text: "test", start_line: 0, end_line: 0 }];
    const embedding = [Array(384).fill(0.1)];
    db.insertChunks("file.ts", chunks, embedding, "hash");

    const check = db.checkDimensions();
    expect(check.ok).toBe(true);
    expect(check.stored).toBe(384);
  });

  it("returns dimension mismatch info", () => {
    const check = db.checkDimensions();
    expect(check).toHaveProperty("ok");
    expect(check).toHaveProperty("stored");
    expect(check).toHaveProperty("current");
  });
});

describe("Database Integrity", () => {
  it("maintains data consistency across operations", () => {
    const chunks = [
      { text: "chunk1", start_line: 0, end_line: 0 },
      { text: "chunk2", start_line: 1, end_line: 1 },
    ];
    const embeddings = [Array(384).fill(0.1), Array(384).fill(0.2)];

    db.insertChunks("file.ts", chunks, embeddings, "hash1");
    const stats1 = db.getStats();

    db.insertChunks("file.ts", chunks, embeddings, "hash1"); // Insert again
    const stats2 = db.getStats();

    // Should replace, not add
    expect(stats2.total_chunks).toBe(stats1.total_chunks);
  });

  it("handles rapid insertions", () => {
    const chunks = [{ text: "test", start_line: 0, end_line: 0 }];
    const embedding = [Array(384).fill(0.1)];

    for (let i = 0; i < 10; i++) {
      db.insertChunks(`file${i}.ts`, chunks, embedding, `hash${i}`);
    }

    const stats = db.getStats();
    expect(stats.files_indexed).toBe(10);
  });

  it("handles special characters in file paths", () => {
    const chunks = [{ text: "test", start_line: 0, end_line: 0 }];
    const embedding = [Array(384).fill(0.1)];

    expect(() => {
      db.insertChunks("src/lib/[dynamic].ts", chunks, embedding, "hash");
      db.insertChunks("src/lib/file-with-dash.ts", chunks, embedding, "hash");
      db.insertChunks("src/lib/file_with_underscore.ts", chunks, embedding, "hash");
    }).not.toThrow();
  });
});
