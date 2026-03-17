import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { Embedder } from '../src/lib/embedder.js';
import { EmbeddingConfig } from '../src/lib/types.js';

vi.mock('../src/lib/onnx-embedder.js', () => ({
  ONNXEmbedder: vi.fn().mockImplementation(() => ({
    isInitialized: vi.fn().mockReturnValue(false),
    initialize: vi.fn().mockResolvedValue({ ok: true }),
    embed: vi.fn().mockResolvedValue([1, 2, 3]),
    embedBatch: vi.fn().mockResolvedValue([[1, 2, 3], [4, 5, 6]]),
    close: vi.fn(),
  })),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
  mkdirSync: vi.fn(),
}));

vi.mock('os', () => ({
  homedir: vi.fn().mockReturnValue('/mock/home'),
}));

vi.mock('../src/lib/hash.js', () => ({
  simpleHash: vi.fn().mockReturnValue(12345),
}));

describe('Embedder', () => {
  let embedder: Embedder;
  let mockConfig: EmbeddingConfig;

  beforeEach(() => {
    vi.clearAllMocks();
    
    mockConfig = {
      api_base: 'https://api.example.com',
      model: 'test-model',
      dimensions: 384,
      batch_size: 32,
      query_prefix: '',
      api_key_env: '',
      enabled: true,
    };
  });

  describe('Initialization', () => {
    it('should initialize with API mode', () => {
      const apiEmbedder = new Embedder({ ...mockConfig, api_base: 'https://api.example.com' });
      expect(apiEmbedder.getMode()).toBe('api');
    });

    it('should initialize with disabled mode when enabled is false', () => {
      const disabledEmbedder = new Embedder({ ...mockConfig, enabled: false });
      expect(disabledEmbedder.getMode()).toBe('disabled');
      expect(disabledEmbedder.isEnabled()).toBe(false);
    });
  });

  describe('ping', () => {
    it('should return success for disabled mode', async () => {
      const disabledEmbedder = new Embedder({ ...mockConfig, enabled: false });
      const result = await disabledEmbedder.ping();
      expect(result.ok).toBe(true);
      expect(result.error).toBe('Embeddings disabled - using BM25-only mode');
    });

    it('should return success for API mode', async () => {
      const apiEmbedder = new Embedder({ ...mockConfig, api_base: 'https://api.example.com' });
      
      const originalFetch = global.fetch;
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
      });
      
      const result = await apiEmbedder.ping();
      expect(result.ok).toBe(true);
      
      global.fetch = originalFetch;
    });

    it('should return error for failed API call', async () => {
      const apiEmbedder = new Embedder({ ...mockConfig, api_base: 'https://api.example.com' });
      
      const originalFetch = global.fetch;
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });
      
      const result = await apiEmbedder.ping();
      expect(result.ok).toBe(false);
      expect(result.error).toContain('HTTP 500');
      
      global.fetch = originalFetch;
    });
  });

  describe('embedQuery', () => {
    it('should generate placeholder embedding for disabled mode', async () => {
      const disabledEmbedder = new Embedder({ ...mockConfig, enabled: false });
      const embedding = await disabledEmbedder.embedQuery('test query');
      
      expect(embedding).toBeInstanceOf(Array);
      expect(embedding.length).toBe(384);
      expect(embedding.every(val => typeof val === 'number')).toBe(true);
    });

    it('should cache query embeddings', async () => {
      const apiEmbedder = new Embedder({ ...mockConfig, api_base: 'https://api.example.com' });
      
      const originalFetch = global.fetch;
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: [{ embedding: [1, 2, 3] }] }),
      });
      
      const firstEmbedding = await apiEmbedder.embedQuery('test query');
      const secondEmbedding = await apiEmbedder.embedQuery('test query');
      
      expect(firstEmbedding).toEqual(secondEmbedding);
      
      global.fetch = originalFetch;
    });
  });

  describe('embedDocuments', () => {
    it('should handle empty document array', async () => {
      const embedderInstance = new Embedder(mockConfig);
      const result = await embedderInstance.embedDocuments([]);
      expect(result).toEqual([]);
    });

    it('should generate placeholder embeddings for disabled mode', async () => {
      const disabledEmbedder = new Embedder({ ...mockConfig, enabled: false });
      const documents = ['doc1', 'doc2', 'doc3'];
      const embeddings = await disabledEmbedder.embedDocuments(documents);
      
      expect(embeddings).toHaveLength(3);
      expect(embeddings.every(emb => emb.length === 384)).toBe(true);
    });

    it('should handle API batch embedding', async () => {
      const apiEmbedder = new Embedder({ ...mockConfig, api_base: 'https://api.example.com', batch_size: 2 });
      
      const originalFetch = global.fetch;
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: [{ embedding: [1, 2, 3] }, { embedding: [4, 5, 6] }] }),
      });
      
      const documents = ['doc1', 'doc2'];
      const embeddings = await apiEmbedder.embedDocuments(documents);
      
      expect(embeddings).toHaveLength(2);
      
      global.fetch = originalFetch;
    });
  });

  describe('error handling', () => {
    it('should handle disabled embedder gracefully', async () => {
      const disabledEmbedder = new Embedder({ ...mockConfig, enabled: false });
      
      const embedding = await disabledEmbedder.embedQuery('test');
      
      expect(embedding).toBeInstanceOf(Array);
      expect(embedding.length).toBe(384);
    });
  });
});
