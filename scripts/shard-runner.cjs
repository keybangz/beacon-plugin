/**
 * Shard test runner for distributed test execution
 * Prevents system freezing by splitting tests across multiple processes
 */
const { spawnSync } = require('child_process');
const { resolve } = require('path');
const glob = require('glob');

// Get shard configuration from environment
const SHARD_INDEX = parseInt(process.env.SHARD_INDEX || '0');
const SHARD_TOTAL = parseInt(process.env.SHARD_TOTAL || '1');
const MAX_WORKERS = parseInt(process.env.VITEST_MAX_WORKERS || '2');
const TEST_TIMEOUT = parseInt(process.env.VITEST_TEST_TIMEOUT || '30000');

// Find all test files
const testFiles = glob.sync('test/**/*.test.ts', {
  absolute: true
});

// Sort files to ensure consistent sharding across runs
testFiles.sort();

// Calculate which files this shard should run
const shardFiles = testFiles.filter((_, index) => {
  return index % SHARD_TOTAL === SHARD_INDEX;
});

if (shardFiles.length === 0) {
  console.log('No test files assigned to this shard');
  process.exit(0);
}

console.log(`\n📋 Shard ${SHARD_INDEX + 1}/${SHARD_TOTAL}`);
console.log(`📁 ${shardFiles.length} test files assigned:`);
shardFiles.forEach(file => {
  console.log(`   ${file.replace(process.cwd(), '.')}`);
});

// Build Vitest command with optimized settings
const vitestArgs = [
  'node_modules/vitest/vitest.mjs',
  'run',
  '--config', 'vitest.config.ts',
  '--maxWorkers', MAX_WORKERS,
  '--minWorkers', MAX_WORKERS,
  '--testTimeout', TEST_TIMEOUT,
  '--poolOptions.threads.isolate', 'false',
  ...shardFiles
];

console.log(`\n🚀 Running tests with ${MAX_WORKERS} workers...`);

// Execute Vitest with the assigned files
const result = spawnSync('node', vitestArgs, {
  stdio: 'inherit',
  shell: true,
  env: process.env
});

// Exit with the same code as the test run
process.exit(result.status || 0);
