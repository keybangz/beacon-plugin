import { describe, it, expect, beforeEach, vi } from 'vitest';
import { simpleHash } from '../src/lib/hash.js';

describe('Hash Functions', () => {
  describe('simpleHash', () => {
    it('should generate consistent hash for same input', () => {
      const input = 'test string';
      const hash1 = simpleHash(input);
      const hash2 = simpleHash(input);
      
      expect(hash1).toBe(hash2);
      expect(typeof hash1).toBe('number');
    });

    it('should generate different hashes for different inputs', () => {
      const input1 = 'hello world';
      const input2 = 'hello universe';
      
      const hash1 = simpleHash(input1);
      const hash2 = simpleHash(input2);
      
      expect(hash1).not.toBe(hash2);
    });

    it('should handle empty string', () => {
      const hash = simpleHash('');
      expect(typeof hash).toBe('number');
      expect(hash).toBeGreaterThan(0);
    });

    it('should handle very long strings', () => {
      const longString = 'a'.repeat(1000);
      const hash1 = simpleHash(longString);
      const hash2 = simpleHash(longString);
      
      expect(hash1).toBe(hash2);
      expect(hash1).not.toBe(0);
    });

    it('should handle special characters', () => {
      const inputs = [
        '!@#$%^&*()',
        'special chars: áéíóú',
        'unicode: 🚀',
        'newlines\nand\ttabs',
        JSON.stringify({ complex: 'object', array: [1, 2, 3] }),
      ];
      
      inputs.forEach(input => {
        const hash = simpleHash(input);
        expect(typeof hash).toBe('number');
        expect(hash).toBeGreaterThan(0);
      });
    });

    it('should generate different case-sensitive hashes', () => {
      const input1 = 'TestString';
      const input2 = 'teststring';
      
      const hash1 = simpleHash(input1);
      const hash2 = simpleHash(input2);
      
      expect(hash1).not.toBe(hash2);
    });

    it('should handle numeric inputs', () => {
      const inputs = [0, 1, 42, 1000, 3.14159];
      
      inputs.forEach(input => {
        const hash = simpleHash(String(input));
        expect(typeof hash).toBe('number');
        expect(hash).toBeGreaterThan(0);
      });
    });

    it('should be deterministic', () => {
      const inputs = [
        '',
        'test',
        'long string for testing consistency',
        'a',
        'b',
        'c',
      ];
      
      // Run hash generation multiple times and ensure consistency
      const runs = 10;
      const results: Record<string, number[]> = {};
      
      inputs.forEach(input => {
        results[input] = [];
        for (let i = 0; i < runs; i++) {
          results[input].push(simpleHash(input));
        }
      });
      
      // Check that all runs for the same input produce the same hash
      Object.keys(results).forEach(input => {
        const hashes = results[input];
        const firstHash = hashes[0];
        
        hashes.forEach(hash => {
          expect(hash).toBe(firstHash);
        });
      });
    });

    it('should produce reasonable hash values', () => {
      // Test with common inputs to ensure hash values are within expected range
      const commonInputs = [
        'package.json',
        'src/index.ts',
        'README.md',
        'test.spec.ts',
        '.gitignore',
      ];
      
      commonInputs.forEach(input => {
        const hash = simpleHash(input);
        expect(hash).toBeGreaterThan(0);
        expect(hash).toBeLessThan(Number.MAX_SAFE_INTEGER);
      });
    });

    it('should handle repeated identical inputs efficiently', () => {
      const input = 'repeated input';
      const iterations = 1000;
      
      // This should not take too long
      const startTime = Date.now();
      const hashes = [];
      
      for (let i = 0; i < iterations; i++) {
        hashes.push(simpleHash(input));
      }
      
      const endTime = Date.now();
      const duration = endTime - startTime;
      
      // Should complete quickly (under 100ms for 1000 iterations)
      expect(duration).toBeLessThan(100);
      
      // All hashes should be identical
      const firstHash = hashes[0];
      hashes.forEach(hash => {
        expect(hash).toBe(firstHash);
      });
    });
  });
});