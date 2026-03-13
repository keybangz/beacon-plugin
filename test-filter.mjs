import { shouldIndex } from './dist/lib/ignore.js';
import { loadConfig } from './dist/lib/config.js';

const config = loadConfig(process.cwd());
const testFiles = [
  'src/lib/db.ts',
  '.opencode/tools/search.ts',
  'README.md',
  'node_modules/something.js',
  'package-lock.json'
];

console.log('Include patterns:', config.indexing.include);
console.log('Exclude patterns:', config.indexing.exclude);
console.log();

for (const file of testFiles) {
  const result = shouldIndex(file, config.indexing.include, config.indexing.exclude);
  console.log(`${file}: ${result ? 'YES' : 'NO'}`);
}
