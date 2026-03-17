import { vi } from 'vitest';

// Mock external dependencies
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  statSync: vi.fn(),
  promises: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    stat: vi.fn(),
  },
}));

vi.mock('path', () => ({
  join: vi.fn((...args) => args.join('/')),
  resolve: vi.fn((...args) => args.join('/')),
}));

vi.mock('os', () => ({
  homedir: vi.fn(() => '/mock/home'),
}));

vi.mock('onnxruntime-node', () => ({
  InferenceSession: vi.fn().mockImplementation(() => ({
    run: vi.fn(),
    inputNames: vi.fn(),
    outputNames: vi.fn(),
    dispose: vi.fn(),
  })),
}));

vi.mock('bun:sqlite', () => ({
  Database: vi.fn().mockImplementation(() => ({
    prepare: vi.fn(),
    run: vi.fn(),
    all: vi.fn(),
    get: vi.fn(),
    exec: vi.fn(),
  })),
}));

vi.mock('hnswlib-node', async () => {
  const actual = await vi.importActual('hnswlib-node');
  return {
    ...actual,
    HierarchicalNSW: vi.fn().mockImplementation(() => ({
      initIndex: vi.fn(),
      addVector: vi.fn(),
      addVectors: vi.fn(),
      searchKnn: vi.fn(),
      searchBatchKnn: vi.fn(),
      saveIndex: vi.fn(),
      loadIndex: vi.fn(),
      getIndexType: vi.fn(),
      getMaxElements: vi.fn(),
      getCurrentCount: vi.fn(),
      getM: vi.fn(),
      getEfConstruction: vi.fn(),
      getEf: vi.fn(),
      setEf: vi.fn(),
      getIndexFileName: vi.fn(),
    })),
  };
});

vi.mock('picomatch', () => ({
  default: vi.fn((pattern: string, options?: any) => {
    return (path: string) => {
      // Simple mock implementations
      if (pattern === '**/*.ts') return path.endsWith('.ts');
      if (pattern === '**/*.js') return path.endsWith('.js');
      if (pattern === 'node_modules/**') return path.includes('node_modules');
      if (pattern === 'dist/**') return path.includes('dist');
      return true; // Default: match everything
    };
  }),
}));

vi.mock('chokidar', () => ({
  watch: vi.fn(() => ({
    on: vi.fn(),
    close: vi.fn(),
  })),
}));

vi.mock('zod', () => ({
  zod: vi.fn(() => ({
    parse: vi.fn(),
  })),
}));