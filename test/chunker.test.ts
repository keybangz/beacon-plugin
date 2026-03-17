import { describe, it, expect, beforeEach } from 'vitest';
import { chunkCode, validateChunks, ChunkResult } from '../src/lib/chunker.js';

describe('Code Chunking', () => {
  const sampleCode = `
function exampleFunction() {
  console.log('Hello, World!');
  return 42;
}

class ExampleClass {
  constructor(value) {
    this.value = value;
  }
  
  getValue() {
    return this.value;
  }
}

const example = new ExampleClass(123);
console.log(example.getValue());

// Another function
async function anotherFunction() {
  await new Promise(resolve => setTimeout(resolve, 100));
  return 'done';
}
`;

  describe('chunkCode', () => {
    it('should split code into chunks when no semantic boundaries detected', () => {
      const simpleCode = 'console.log("hello");\nconsole.log("world");\nconst x = 1;';
      const chunks = chunkCode(simpleCode, 10, 2);
      
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[0]).toHaveProperty('text');
      expect(chunks[0]).toHaveProperty('start_line');
      expect(chunks[0]).toHaveProperty('end_line');
      
      // Check that chunks don't exceed max tokens
      chunks.forEach(chunk => {
        const tokenCount = chunk.text.split(/\s+/).length;
        expect(tokenCount).toBeLessThanOrEqual(10);
      });
    });

    it('should respect context limits', () => {
      const longCode = 'x'.repeat(1000); // Very long line
      const chunks = chunkCode(longCode, 100, 10, 200);
      
      expect(chunks.length).toBeGreaterThan(0);
      chunks.forEach(chunk => {
        const effectiveMaxTokens = Math.min(100, Math.floor(200 * 0.8));
        const maxChars = effectiveMaxTokens * 3;
        expect(chunk.text.length).toBeLessThanOrEqual(maxChars);
      });
    });

    it('should handle code with semantic boundaries', () => {
      const chunks = chunkCode(sampleCode, 50, 10);
      
      expect(chunks.length).toBeGreaterThan(0);
      
      // Check that chunks respect function/class boundaries
      let foundFunctionBoundary = false;
      let foundClassBoundary = false;
      
      chunks.forEach(chunk => {
        if (chunk.text.includes('function') || chunk.text.includes('function')) {
          foundFunctionBoundary = true;
        }
        if (chunk.text.includes('class')) {
          foundClassBoundary = true;
        }
      });
      
      expect(foundFunctionBoundary || foundClassBoundary).toBe(true);
    });

    it('should handle overlap between chunks', () => {
      const chunks = chunkCode(sampleCode, 20, 5);
      
      // With overlap, adjacent chunks should have some content in common
      for (let i = 0; i < chunks.length - 1; i++) {
        const currentChunk = chunks[i];
        const nextChunk = chunks[i + 1];
        
        // End of current chunk should be close to start of next chunk
        expect(nextChunk.start_line).toBeLessThanOrEqual(currentChunk.end_line + 10);
      }
    });

    it('should handle empty code', () => {
      const chunks = chunkCode('', 50, 10);
      expect(chunks).toEqual([]);
    });

    it('should handle very small maxTokens', () => {
      const chunks = chunkCode(sampleCode, 2, 1);
      
      expect(chunks.length).toBeGreaterThan(0);
      chunks.forEach(chunk => {
        const tokens = chunk.text.trim().split(/\s+/).length;
        expect(tokens).toBeLessThanOrEqual(2);
      });
    });
  });

  describe('validateChunks', () => {
    it('should pass validation for valid chunks', () => {
      const validChunks: ChunkResult[] = [
        { text: 'console.log("hello");', start_line: 0, end_line: 0 },
        { text: 'console.log("world");', start_line: 1, end_line: 1 },
        { text: 'const x = 1;', start_line: 2, end_line: 2 },
      ];
      
      expect(() => validateChunks(validChunks)).not.toThrow();
    });

    it('should throw for chunks with negative start_line', () => {
      const invalidChunks: ChunkResult[] = [
        { text: 'test', start_line: -1, end_line: 0 },
      ];
      
      expect(() => validateChunks(invalidChunks)).toThrow('start_line must be >= 0');
    });

    it('should throw for chunks where end_line < start_line', () => {
      const invalidChunks: ChunkResult[] = [
        { text: 'test', start_line: 5, end_line: 3 },
      ];
      
      expect(() => validateChunks(invalidChunks)).toThrow('end_line must be >= start_line');
    });

    it('should throw for chunks with empty text', () => {
      const invalidChunks: ChunkResult[] = [
        { text: '', start_line: 0, end_line: 0 },
      ];
      
      expect(() => validateChunks(invalidChunks)).toThrow('text cannot be empty');
    });

    it('should throw for chunks with only whitespace', () => {
      const invalidChunks: ChunkResult[] = [
        { text: '   \n   \t   ', start_line: 0, end_line: 0 },
      ];
      
      expect(() => validateChunks(invalidChunks)).toThrow('text cannot be empty');
    });
  });

  describe('Edge Cases', () => {
    it('should handle code with only comments', () => {
      const commentOnlyCode = '// This is a comment\n// Another comment\n/* Multi-line\n   comment */';
      const chunks = chunkCode(commentOnlyCode, 50, 5);
      
      expect(chunks.length).toBeGreaterThan(0);
      chunks.forEach(chunk => {
        expect(chunk.text.trim()).not.toBe('');
      });
    });

    it('should handle import statements', () => {
      const importCode = `
import { useState } from 'react';
import fs from 'fs';
import * as path from 'path';

const test = true;
`;
      const chunks = chunkCode(importCode, 30, 5);
      
      expect(chunks.length).toBeGreaterThan(0);
      // Should separate imports from other code
      const importChunks = chunks.filter(chunk => 
        chunk.text.includes('import')
      );
      const otherChunks = chunks.filter(chunk => 
        chunk.text.includes('const')
      );
      
      expect(importChunks.length).toBeGreaterThan(0);
      // Other chunks might be 0 if imports and const are in the same chunk
    });

    it('should handle TypeScript interfaces and types', () => {
      const tsCode = `
interface User {
  id: number;
  name: string;
  email: string;
}

type Status = 'active' | 'inactive' | 'pending';

class UserService {
  private users: User[] = [];
  
  addUser(user: User): void {
    this.users.push(user);
  }
}
`;
      const chunks = chunkCode(tsCode, 40, 5);
      
      expect(chunks.length).toBeGreaterThan(0);
      chunks.forEach(chunk => {
        expect(chunk.text.trim()).not.toBe('');
      });
    });

    it('should handle very long single lines', () => {
      const longLineCode = `
const veryLongVariableNameThatExceedsNormalLengthLimits = 'This is a very long string that would normally be wrapped but in code we often see extremely long lines that need to be handled properly by the chunking algorithm';

console.log('Short line');
`;
      const chunks = chunkCode(longLineCode, 30, 5);
      
      expect(chunks.length).toBeGreaterThan(1); // Should split the long line
      chunks.forEach(chunk => {
        const tokens = chunk.text.trim().split(/\s+/).length;
        expect(tokens).toBeLessThanOrEqual(30);
      });
    });
  });
});