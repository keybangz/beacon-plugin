import { mock } from 'bun:test';

// Mock external dependencies for tests
mock.module('fs', () => ({
  existsSync: mock(() => false),
  mkdirSync: mock(() => undefined),
  readFileSync: mock(() => '{}'),
  writeFileSync: mock(() => undefined),
  statSync: mock(() => ({ size: 0, mtimeMs: 0 })),
  promises: {
    readFile: mock(() => Promise.resolve('')),
    writeFile: mock(() => Promise.resolve()),
    stat: mock(() => Promise.resolve({ size: 0, mtimeMs: 0 })),
  },
}));

mock.module('path', () => ({
  join: mock((...args: string[]) => args.join('/')),
  resolve: mock((...args: string[]) => args.join('/')),
  dirname: mock((p: string) => p.split('/').slice(0, -1).join('/')),
  basename: mock((p: string) => p.split('/').pop() ?? ''),
}));

mock.module('os', () => ({
  homedir: mock(() => '/mock/home'),
  cpus: mock(() => [{ model: 'mock', speed: 0, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } }]),
}));

mock.module('onnxruntime-node', () => ({
  InferenceSession: {
    create: mock(() => Promise.resolve({
      run: mock(() => Promise.resolve({})),
      inputNames: [],
      outputNames: [],
      dispose: mock(() => Promise.resolve()),
    })),
  },
  Tensor: mock((type: string, data: any, dims: number[]) => ({ type, data, dims })),
}));

mock.module('hnswlib-node', () => ({
  HierarchicalNSW: mock(() => ({
    initIndex: mock(() => undefined),
    addVector: mock(() => undefined),
    addVectors: mock(() => undefined),
    searchKnn: mock(() => ({ neighbors: [], distances: [] })),
    searchBatchKnn: mock(() => []),
    saveIndex: mock(() => undefined),
    loadIndex: mock(() => undefined),
    getIndexType: mock(() => 'l2'),
    getMaxElements: mock(() => 0),
    getCurrentCount: mock(() => 0),
    getM: mock(() => 16),
    getEfConstruction: mock(() => 200),
    getEf: mock(() => 10),
    setEf: mock(() => undefined),
    getIndexFileName: mock(() => ''),
  })),
}));

mock.module('picomatch', () => ({
  default: mock((pattern: string) => {
    return (path: string) => {
      if (pattern === '**/*.ts') return path.endsWith('.ts');
      if (pattern === '**/*.js') return path.endsWith('.js');
      if (pattern === 'node_modules/**') return path.includes('node_modules');
      if (pattern === 'dist/**') return path.includes('dist');
      return true;
    };
  }),
}));

mock.module('chokidar', () => ({
  watch: mock(() => ({
    on: mock(() => undefined),
    close: mock(() => Promise.resolve()),
  })),
}));

mock.module('zod', () => ({
  z: {
    object: mock(() => ({ parse: mock(() => ({})) })),
    string: mock(() => ({ optional: mock(() => ({})) })),
    number: mock(() => ({ optional: mock(() => ({})) })),
    boolean: mock(() => ({ optional: mock(() => ({})) })),
    array: mock(() => ({ optional: mock(() => ({})) })),
    enum: mock(() => ({ optional: mock(() => ({})) })),
  },
}));
