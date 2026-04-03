/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./test/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'dist/',
        'test/',
        '**/*.d.ts',
        '**/*.test.ts',
        '**/*.spec.ts',
      ],
    },
    maxConcurrency: 4,
    testTimeout: 30000,
    hookTimeout: 10000,
    teardownTimeout: 10000,
    pool: 'threads',
    poolOptions: {
      threads: {
        singleThread: false,
        isolate: false,
      },
    },
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
});
