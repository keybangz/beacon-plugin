import { describe, it, expect, beforeEach, beforeAll } from 'bun:test';
import { loadConfig, validateConfig, invalidateConfigCache, _fsAdapter } from '../src/lib/config.js';

// Capture real fs functions via require() — CJS cache is separate from the ESM
// mock.module() registry, so this bypasses embedder.test.ts's mock.module('fs') stub.
let _realExistsSync: (...args: any[]) => any;
let _realReadFileSync: (...args: any[]) => any;

beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const realFs = require('fs');
  _realExistsSync = realFs.existsSync;
  _realReadFileSync = realFs.readFileSync;
});

// A path guaranteed to not be inside any git repo on any CI runner.
// /tmp is outside the checkout directory and has no .git ancestor.
const TEST_REPO_ROOT = '/tmp/beacon-test-no-repo';

describe('Configuration Management', () => {
  describe('loadConfig', () => {
    beforeEach(() => {
      // Restore real fs functions on the adapter before each test
      _fsAdapter.existsSync = _realExistsSync;
      _fsAdapter.readFileSync = _realReadFileSync;
      // Clear any cached config for the test path to prevent cross-test pollution
      invalidateConfigCache(TEST_REPO_ROOT);
    });

    it('should return default config when no repo config exists', () => {
      const config = loadConfig(TEST_REPO_ROOT);

      expect(config).toHaveProperty('embedding');
      expect(config).toHaveProperty('chunking');
      expect(config).toHaveProperty('indexing');
      expect(config).toHaveProperty('search');
      expect(config).toHaveProperty('storage');
      expect(config._merged).toBe(true);
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
  });
});
