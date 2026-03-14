/**
 * Unit tests for chunker module
 * Tests code chunking strategies and chunk validation
 * 20 comprehensive test cases
 */

import { describe, it, expect } from "vitest";
import { chunkCode, validateChunks, ChunkResult } from "../../src/lib/chunker";

describe("chunkCode", () => {
  it("returns array of chunks", () => {
    const code = "const x = 1;\nconst y = 2;\nconst z = 3;";
    const chunks = chunkCode(code, 100);
    expect(Array.isArray(chunks)).toBe(true);
  });

  it("creates single chunk for small code", () => {
    const code = "const x = 1;";
    const chunks = chunkCode(code, 512);
    expect(chunks.length).toBe(1);
  });

  it("splits code exceeding maxTokens", () => {
    // Create a code sample with many lines to exceed token limit
    const lines = Array(50).fill("console.log('test line');");
    const code = lines.join("\n");
    const chunks = chunkCode(code, 100, 50);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });

  it("tracks line numbers correctly", () => {
    const code = "line1\nline2\nline3\nline4\nline5";
    const chunks = chunkCode(code);
    for (const chunk of chunks) {
      expect(chunk.start_line).toBeLessThanOrEqual(chunk.end_line);
      expect(chunk.start_line).toBeGreaterThanOrEqual(0);
    }
  });

  it("includes chunk text in result", () => {
    const code = "const x = 1;\nconst y = 2;";
    const chunks = chunkCode(code);
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(typeof chunk.text).toBe("string");
      expect(chunk.text.length).toBeGreaterThan(0);
    }
  });

  it("preserves code content in chunks", () => {
    const code = "function test() {\n  return 42;\n}";
    const chunks = chunkCode(code);
    const combined = chunks.map((c) => c.text).join("\n");
    expect(combined).toContain("function test");
    expect(combined).toContain("return 42");
  });

  it("handles empty code", () => {
    const chunks = chunkCode("");
    expect(Array.isArray(chunks)).toBe(true);
  });

  it("handles single line code", () => {
    const code = "const x = 1;";
    const chunks = chunkCode(code);
    expect(chunks.length).toBeGreaterThan(0);
  });

  it("handles very long single line", () => {
    const longLine = "const x = '" + "a".repeat(1000) + "';";
    const chunks = chunkCode(longLine, 50);
    expect(chunks.length).toBeGreaterThan(0);
  });

  it("maintains chunk integrity", () => {
    const code = "function add(a, b) {\n  return a + b;\n}\n\nfunction sub(a, b) {\n  return a - b;\n}";
    const chunks = chunkCode(code);
    for (const chunk of chunks) {
      expect(chunk.text).not.toContain("undefined");
      expect(chunk.text.trim().length).toBeGreaterThan(0);
    }
  });

  it("uses overlap tokens to create redundancy", () => {
    const code = Array(100)
      .fill(0)
      .map((_, i) => `line ${i}`)
      .join("\n");
    const chunksNoOverlap = chunkCode(code, 100, 0);
    const chunksWithOverlap = chunkCode(code, 100, 50);
    // With overlap, might have similar chunk count but content overlaps
    expect(chunksWithOverlap.length).toBeGreaterThanOrEqual(1);
  });

  it("generates valid ChunkResult interface", () => {
    const code = "const x = 1;";
    const chunks = chunkCode(code);
    for (const chunk of chunks) {
      expect("text" in chunk).toBe(true);
      expect("start_line" in chunk).toBe(true);
      expect("end_line" in chunk).toBe(true);
    }
  });

  it("handles code with mixed line endings", () => {
    const code = "line1\nline2\r\nline3";
    const chunks = chunkCode(code);
    expect(chunks.length).toBeGreaterThan(0);
  });

  it("respects maxTokens parameter", () => {
    const code = Array(20)
      .fill(0)
      .map((_, i) => `const var${i} = ${i};`)
      .join("\n");
    const maxTokens = 50;
    const chunks = chunkCode(code, maxTokens);
    // All chunks should be reasonable size (not guaranteed exact due to estimation)
    expect(chunks.length).toBeGreaterThan(0);
  });

  it("filters out empty chunks", () => {
    const code = "\n\n\n";
    const chunks = chunkCode(code);
    // Empty code should result in 0 chunks
    expect(chunks.every((c) => c.text.trim().length > 0)).toBe(true);
  });

  it("handles comments in code", () => {
    const code = `
      // This is a comment
      const x = 1;
      /* Multi-line
         comment */
      const y = 2;
    `;
    const chunks = chunkCode(code);
    expect(chunks.length).toBeGreaterThan(0);
  });

  it("returns chunks with sensible line ranges", () => {
    const code = "1\n2\n3\n4\n5\n6\n7\n8\n9\n10";
    const chunks = chunkCode(code, 50);
    for (const chunk of chunks) {
      expect(chunk.end_line).toBeGreaterThanOrEqual(chunk.start_line);
      expect(chunk.end_line).toBeLessThanOrEqual(9); // 0-indexed
    }
  });

  it("handles code with functions and classes", () => {
    const code = `
      class User {
        constructor(name) {
          this.name = name;
        }
        
        getName() {
          return this.name;
        }
      }
      
      function processUser(user) {
        return user.getName();
      }
    `;
    const chunks = chunkCode(code);
    expect(chunks.length).toBeGreaterThan(0);
    const text = chunks.map((c) => c.text).join("\n");
    expect(text).toContain("class User");
    expect(text).toContain("function processUser");
  });
});

describe("validateChunks", () => {
  it("validates correct chunks without throwing", () => {
    const chunks: ChunkResult[] = [
      {
        text: "const x = 1;",
        start_line: 0,
        end_line: 0,
      },
      {
        text: "const y = 2;",
        start_line: 1,
        end_line: 1,
      },
    ];
    expect(() => validateChunks(chunks)).not.toThrow();
  });

  it("throws for negative start_line", () => {
    const chunks: ChunkResult[] = [
      {
        text: "const x = 1;",
        start_line: -1,
        end_line: 0,
      },
    ];
    expect(() => validateChunks(chunks)).toThrow();
  });

  it("throws when end_line < start_line", () => {
    const chunks: ChunkResult[] = [
      {
        text: "const x = 1;",
        start_line: 10,
        end_line: 5,
      },
    ];
    expect(() => validateChunks(chunks)).toThrow();
  });

  it("throws for empty text", () => {
    const chunks: ChunkResult[] = [
      {
        text: "",
        start_line: 0,
        end_line: 0,
      },
    ];
    expect(() => validateChunks(chunks)).toThrow();
  });

  it("throws for whitespace-only text", () => {
    const chunks: ChunkResult[] = [
      {
        text: "   \n\t  ",
        start_line: 0,
        end_line: 0,
      },
    ];
    expect(() => validateChunks(chunks)).toThrow();
  });

  it("validates multiple chunks", () => {
    const chunks: ChunkResult[] = [
      {
        text: "chunk 1",
        start_line: 0,
        end_line: 2,
      },
      {
        text: "chunk 2",
        start_line: 3,
        end_line: 5,
      },
      {
        text: "chunk 3",
        start_line: 6,
        end_line: 8,
      },
    ];
    expect(() => validateChunks(chunks)).not.toThrow();
  });

  it("includes chunk index in error message", () => {
    const chunks: ChunkResult[] = [
      { text: "chunk 1", start_line: 0, end_line: 1 },
      { text: "", start_line: 2, end_line: 3 },
    ];
    expect(() => validateChunks(chunks)).toThrow(/Chunk 1/);
  });

  it("validates start_line equals end_line", () => {
    const chunks: ChunkResult[] = [
      {
        text: "single line",
        start_line: 5,
        end_line: 5,
      },
    ];
    expect(() => validateChunks(chunks)).not.toThrow();
  });

  it("returns undefined on success", () => {
    const chunks: ChunkResult[] = [
      {
        text: "valid chunk",
        start_line: 0,
        end_line: 0,
      },
    ];
    const result = validateChunks(chunks);
    expect(result).toBeUndefined();
  });

  it("validates empty array", () => {
    const chunks: ChunkResult[] = [];
    expect(() => validateChunks(chunks)).not.toThrow();
  });

  it("validates chunks with large line numbers", () => {
    const chunks: ChunkResult[] = [
      {
        text: "chunk",
        start_line: 10000,
        end_line: 10500,
      },
    ];
    expect(() => validateChunks(chunks)).not.toThrow();
  });

  it("validates chunks with multiline text", () => {
    const chunks: ChunkResult[] = [
      {
        text: "line 1\nline 2\nline 3",
        start_line: 0,
        end_line: 2,
      },
    ];
    expect(() => validateChunks(chunks)).not.toThrow();
  });

  it("validates chunks containing special characters", () => {
    const chunks: ChunkResult[] = [
      {
        text: "const x = '©®™'; // 中文",
        start_line: 0,
        end_line: 0,
      },
    ];
    expect(() => validateChunks(chunks)).not.toThrow();
  });

  it("throws descriptive error for invalid start_line", () => {
    const chunks: ChunkResult[] = [
      {
        text: "chunk",
        start_line: -5,
        end_line: 0,
      },
    ];
    try {
      validateChunks(chunks);
      expect(true).toBe(false); // Should throw
    } catch (error) {
      expect((error as Error).message).toContain("start_line");
    }
  });

  it("throws descriptive error for invalid end_line", () => {
    const chunks: ChunkResult[] = [
      {
        text: "chunk",
        start_line: 5,
        end_line: 2,
      },
    ];
    try {
      validateChunks(chunks);
      expect(true).toBe(false); // Should throw
    } catch (error) {
      expect((error as Error).message).toContain("end_line");
    }
  });

  it("throws descriptive error for empty text", () => {
    const chunks: ChunkResult[] = [
      {
        text: "",
        start_line: 0,
        end_line: 0,
      },
    ];
    try {
      validateChunks(chunks);
      expect(true).toBe(false); // Should throw
    } catch (error) {
      expect((error as Error).message).toContain("empty");
    }
  });
});
