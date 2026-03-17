import { describe, it, expect, beforeEach, vi } from 'vitest';
import { loadConfig, validateConfig } from '../src/lib/config.js';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

// Mock fs module
vi.mock('fs');
vi.mock('path');

const mockExistsSync = existsSync as ReturnType<typeof vi.fn>;
const mockReadFileSync = readFileSync as ReturnType<typeof vi.fn>;
const mockJoin = join as ReturnType<typeof vi.fn>;

describe('Configuration Management', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    
    // Setup path mock
    mockJoin.mockImplementation((...args) => args.join('/'));
    
    // Reset all file system mocks
    mockExistsSync.mockReturnValue(false);
    mockReadFileSync.mockImplementation(() => {
      throw new Error('File not found');
    });
  });

  describe('loadConfig', () => {
    it('should return default config when no repo config exists', () => {
      const config = loadConfig('/test/repo');
      
      expect(config).toHaveProperty('embedding');
      expect(config).toHaveProperty('chunking');
      expect(config).toHaveProperty('indexing');
      expect(config).toHaveProperty('search');
      expect(config).toHaveProperty('storage');
      expect(config._merged).toBe(true);
    });

    it('should merge repo config with default config', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('{"embedding":{"model":"custom-model","dimensions":768}}');
      
      const config = loadConfig('/test/repo');
      
      expect(config.embedding.model).toBe('custom-model');
      expect(config.embedding.dimensions).toBe(768);
      expect(config.embedding.api_base).toBe('local'); // from default
    });

    it('should handle invalid repo config gracefully', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('invalid json');
      
      expect(() => loadConfig('/test/repo')).toThrow('Failed to parse repo config');
    });
  });

  describe('validateConfig', () => {
    it('should pass validation for valid config', () => {
      const validConfig = {
        embedding: {
          api_base: 'local',
          model: 'all-MiniLM-L6-v2',
          dimensions: 384,
          batch_size: 32,
          enabled: true,
        },
        chunking: {
          strategy: 'hybrid',
          max_tokens: 512,
          overlap_tokens: 32,
        },
        indexing: {
          include: ['**/*.ts'],
          exclude: ['node_modules/**'],
          max_file_size_kb: 500,
          auto_index: true,
          max_files: 10000,
          concurrency: 4,
        },
        search: {
          top_k: 10,
          similarity_threshold: 0.35,
          hybrid: {
            enabled: true,
            weight_vector: 0.4,
            weight_bm25: 0.3,
            weight_rrf: 0.3,
            doc_penalty: 0.5,
            identifier_boost: 1.5,
            debug: false,
          },
        },
        storage: {
          path: '.opencode/.beacon',
        },
      };

      expect(() => validateConfig(validConfig)).not.toThrow();
    });

    it('should throw for missing required keys', () => {
      const invalidConfig = {
        embedding: {
          api_base: 'local',
          model: 'test',
          dimensions: 384,
          batch_size: 32,
        },
        // Missing other required sections
      };

      expect(() => validateConfig(invalidConfig)).toThrow('Missing required config key');
    });

    it('should throw for invalid embedding config', () => {
      const invalidConfig = {
        embedding: {
          api_base: '', // Invalid
          model: '',
          dimensions: 384,
          batch_size: 32,
        },
        chunking: {
          strategy: 'hybrid',
          max_tokens: 512,
          overlap_tokens: 32,
        },
        indexing: {
          include: ['**/*.ts'],
          exclude: ['node_modules/**'],
          max_file_size_kb: 500,
          auto_index: true,
          max_files: 10000,
          concurrency: 4,
        },
        search: {
          top_k: 10,
          similarity_threshold: 0.35,
          hybrid: {
            enabled: true,
            weight_vector: 0.4,
            weight_bm25: 0.3,
            weight_rrf: 0.3,
            doc_penalty: 0.5,
            identifier_boost: 1.5,
            debug: false,
          },
        },
        storage: {
          path: '.opencode/.beacon',
        },
      };

      expect(() => validateConfig(invalidConfig)).toThrow('api_base and model are required when embeddings are enabled');
    });

    it('should warn when chunking tokens exceed context limit', () => {
      const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      
      const config = {
        embedding: {
          api_base: 'local',
          model: 'test',
          dimensions: 384,
          batch_size: 32,
          context_limit: 100, // Very low
          enabled: true,
        },
        chunking: {
          strategy: 'hybrid',
          max_tokens: 200, // Exceeds context limit
          overlap_tokens: 32,
        },
        indexing: {
          include: ['**/*.ts'],
          exclude: ['node_modules/**'],
          max_file_size_kb: 500,
          auto_index: true,
          max_files: 10000,
          concurrency: 4,
        },
        search: {
          top_k: 10,
          similarity_threshold: 0.35,
          hybrid: {
            enabled: true,
            weight_vector: 0.4,
            weight_bm25: 0.3,
            weight_rrf: 0.3,
            doc_penalty: 0.5,
            identifier_boost: 1.5,
            debug: false,
          },
        },
        storage: {
          path: '.opencode/.beacon',
        },
      };

      validateConfig(config);
      
      expect(consoleWarn).toHaveBeenCalledWith(
        expect.stringContaining('chunking.max_tokens (200) exceeds embedding.context_limit (100)')
      );
      
      consoleWarn.mockRestore();
    });
  });
});