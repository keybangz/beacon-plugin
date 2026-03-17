import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { IndexCoordinator, terminateIndexer, isIndexerRunning, shouldTerminate } from '../src/lib/sync.js';
import { BeaconConfig } from '../src/lib/types.js';

vi.mock('../src/lib/git.js', () => ({
  getRepoFiles: vi.fn().mockReturnValue([]),
  getModifiedFilesSince: vi.fn().mockReturnValue([]),
  getFileHash: vi.fn().mockReturnValue('mockhash'),
}));

vi.mock('../src/lib/ignore.js', () => ({
  shouldIndex: vi.fn().mockReturnValue(true),
}));

vi.mock('../src/lib/db.js', () => ({
  BeaconDatabase: vi.fn().mockImplementation(() => ({
    getSyncState: vi.fn().mockReturnValue(null),
    setSyncState: vi.fn(),
    clear: vi.fn().mockResolvedValue(undefined),
    deleteChunks: vi.fn().mockResolvedValue(undefined),
    getIndexedFiles: vi.fn().mockReturnValue([]),
    insertChunks: vi.fn().mockResolvedValue(undefined),
    getFileHash: vi.fn().mockReturnValue(null),
  })),
}));

vi.mock('../src/lib/embedder.js', () => ({
  Embedder: vi.fn().mockImplementation(() => ({
    embedDocuments: vi.fn().mockResolvedValue([[1, 2, 3]]),
    close: vi.fn(),
  })),
}));

vi.mock('../src/lib/hash.js', () => ({
  simpleHash: vi.fn().mockReturnValue(12345),
}));

const { getRepoFiles, getModifiedFilesSince, getFileHash } = await import('../src/lib/git.js');
const { shouldIndex } = await import('../src/lib/ignore.js');
const { BeaconDatabase } = await import('../src/lib/db.js');
const { Embedder } = await import('../src/lib/embedder.js');

describe('Index Coordinator', () => {
  let coordinator: IndexCoordinator;
  let mockConfig: BeaconConfig;
  let mockDb: any;
  let mockEmbedder: any;
  let mockRepoRoot: string;

  beforeEach(() => {
    vi.clearAllMocks();
    
    mockRepoRoot = '/mock/repo';
    
    mockConfig = {
      embedding: {
        api_base: 'https://api.example.com',
        model: 'test-model',
        dimensions: 384,
        batch_size: 10,
        query_prefix: '',
        api_key_env: '',
        enabled: true,
      },
      chunking: {
        strategy: 'hybrid',
        max_tokens: 1000,
        overlap_tokens: 100,
      },
      indexing: {
        include: ['**/*.ts', '**/*.js', '**/*.jsx', '**/*.tsx'],
        exclude: ['**/node_modules/**', '**/dist/**', '**/build/**'],
        max_file_size_kb: 1024,
        auto_index: true,
        max_files: 1000,
        concurrency: 4,
      },
      search: {
        top_k: 10,
        similarity_threshold: 0.7,
        hybrid: {
          enabled: true,
          weight_vector: 0.5,
          weight_bm25: 0.5,
          weight_rrf: 60,
          doc_penalty: 0.1,
          identifier_boost: 2.0,
          debug: false,
        },
      },
      storage: {
        path: '/mock/storage',
      },
    };
    
    mockDb = new BeaconDatabase('/mock/db.sqlite');
    mockEmbedder = new Embedder(mockConfig.embedding);
    
    (getRepoFiles as any).mockReturnValue(['file1.ts', 'file2.ts', 'file3.js']);
    (shouldIndex as any).mockReturnValue(true);
    
    coordinator = new IndexCoordinator(mockConfig, mockDb, mockEmbedder, mockRepoRoot);
  });

  describe('performFullIndex', () => {
    it('should discover files and index them', async () => {
      mockDb.getSyncState = vi.fn().mockReturnValue(null);
      mockDb.clear = vi.fn().mockResolvedValue(undefined);
      mockDb.setSyncState = vi.fn();
      
      (getRepoFiles as any).mockReturnValue(['file1.ts', 'file2.ts', 'file3.js']);
      (shouldIndex as any).mockReturnValue(true);
      
      const progressCallback = vi.fn();
      const result = await coordinator.performFullIndex(progressCallback);

      expect(result.success).toBe(true);
    });

    it('should skip files when shouldIndex returns false', async () => {
      (getRepoFiles as any).mockReturnValue(['file1.ts', 'file2.ts']);
      (shouldIndex as any).mockReturnValue(false);
      
      const result = await coordinator.performFullIndex();
      
      expect(result.success).toBe(true);
      expect(result.filesIndexed).toBe(0);
    });

    it('should handle disabled embeddings', async () => {
      const disabledConfig = { 
        ...mockConfig, 
        embedding: { 
          ...mockConfig.embedding, 
          enabled: false,
          api_base: 'local',
          model: 'test',
          dimensions: 384,
          batch_size: 10,
          query_prefix: '',
          api_key_env: ''
        } 
      };
      const disabledCoordinator = new IndexCoordinator(
        disabledConfig,
        mockDb,
        mockEmbedder,
        mockRepoRoot
      );

      (getRepoFiles as any).mockReturnValue(['file1.ts']);
      (shouldIndex as any).mockReturnValue(true);

      const result = await disabledCoordinator.performFullIndex();
      
      expect(result.success).toBe(true);
    });

    it('should emit progress updates', async () => {
      (getRepoFiles as any).mockReturnValue(['file1.ts', 'file2.ts']);
      (shouldIndex as any).mockReturnValue(true);

      const progressCallback = vi.fn();
      await coordinator.performFullIndex(progressCallback);

      expect(progressCallback).toHaveBeenCalled();
      const phases = progressCallback.mock.calls.map((call: any) => call[0].phase);
      expect(phases).toContain('discovering');
      expect(phases).toContain('complete');
    });
  });

  describe('performDiffSync', () => {
    it('should perform diff sync when last sync exists', async () => {
      mockDb.getSyncState = vi.fn().mockImplementation((key: string) => {
        if (key === 'last_full_sync') return '2023-01-01T00:00:00.000Z';
        if (key === 'sync_status') return 'idle';
        return null;
      });
      
      (getModifiedFilesSince as any).mockReturnValue([{ path: 'file1.ts', modified_at: '2023-01-02T00:00:00.000Z' }]);
      (shouldIndex as any).mockReturnValue(true);

      const result = await coordinator.performDiffSync();
      
      expect(result.success).toBe(true);
    });

    it('should fall back to full sync when no last sync exists', async () => {
      mockDb.getSyncState = vi.fn().mockReturnValue(null);
      (getRepoFiles as any).mockReturnValue(['file1.ts']);
      (shouldIndex as any).mockReturnValue(true);

      const result = await coordinator.performDiffSync();
      
      expect(result.success).toBe(true);
    });
  });

  describe('reembedFile', () => {
    it('should handle reembedFile call', async () => {
      const result = await coordinator.reembedFile('file1.ts');
      
      expect(typeof result).toBe('boolean');
    });
  });

  describe('garbageCollect', () => {
    it('should delete files no longer in repository', async () => {
      (getRepoFiles as any).mockReturnValue(['file1.ts', 'file2.ts']);
      mockDb.getIndexedFiles = vi.fn().mockReturnValue(['file1.ts', 'file2.ts', 'deleted.ts']);
      mockDb.deleteChunks = vi.fn().mockResolvedValue(undefined);

      const result = await coordinator.garbageCollect();
      
      expect(result).toBe(1);
      expect(mockDb.deleteChunks).toHaveBeenCalledWith('deleted.ts');
    });

    it('should return 0 when no files need deletion', async () => {
      (getRepoFiles as any).mockReturnValue(['file1.ts', 'file2.ts']);
      mockDb.getIndexedFiles = vi.fn().mockReturnValue(['file1.ts', 'file2.ts']);

      const result = await coordinator.garbageCollect();
      
      expect(result).toBe(0);
    });
  });

  describe('termination', () => {
    it('should check termination status', () => {
      mockDb.getSyncState = vi.fn().mockReturnValue('in_progress');
      
      const result = isIndexerRunning(mockDb);
      
      expect(result).toBe(true);
    });

    it('should return false when not running', () => {
      mockDb.getSyncState = vi.fn().mockReturnValue('idle');
      
      const result = isIndexerRunning(mockDb);
      
      expect(result).toBe(false);
    });

    it('should terminate indexer when in progress', () => {
      mockDb.getSyncState = vi.fn().mockReturnValue('in_progress');
      mockDb.setSyncState = vi.fn();
      
      const result = terminateIndexer(mockDb);
      
      expect(result).toBe(true);
      expect(mockDb.setSyncState).toHaveBeenCalledWith('sync_status', 'terminating');
    });

    it('should return false when not running', () => {
      mockDb.getSyncState = vi.fn().mockReturnValue('idle');
      
      const result = terminateIndexer(mockDb);
      
      expect(result).toBe(false);
    });

    it('should check shouldTerminate', () => {
      mockDb.getSyncState = vi.fn().mockReturnValue('terminating');
      
      const result = shouldTerminate(mockDb);
      
      expect(result).toBe(true);
    });

    it('should return false for non-terminating status', () => {
      mockDb.getSyncState = vi.fn().mockReturnValue('in_progress');
      
      const result = shouldTerminate(mockDb);
      
      expect(result).toBe(false);
    });
  });

  describe('progress tracking', () => {
    it('should calculate progress percentages correctly', async () => {
      (getRepoFiles as any).mockReturnValue(['file1.ts', 'file2.ts', 'file3.ts', 'file4.ts', 'file5.ts']);
      (shouldIndex as any).mockReturnValue(true);

      const progressUpdates: any[] = [];
      const progressCallback = (progress: any) => {
        progressUpdates.push(progress);
      };

      await coordinator.performFullIndex(progressCallback);

      expect(progressUpdates.length).toBeGreaterThan(0);
      expect(progressUpdates[0].percent).toBe(0);
    });
  });
});
