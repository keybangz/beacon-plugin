import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    alias: {
      // Map bun:sqlite to better-sqlite3 for Vitest (Node.js) compatibility
      'bun:sqlite': resolve(__dirname, 'tests/mocks/bun-sqlite.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
    testTimeout: 10000,
    hookTimeout: 10000,
  },
});
