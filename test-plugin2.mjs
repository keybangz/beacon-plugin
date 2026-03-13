import { getRepoFiles, shouldIndex } from './dist/lib/sync.js';
import { loadConfig } from './dist/lib/config.js';

const repoRoot = process.cwd();
const config = loadConfig(repoRoot);

const allFiles = getRepoFiles(repoRoot);
console.log(`Found ${allFiles.length} total files`);

const filesToIndex = allFiles.filter((file) =>
  shouldIndex(
    file,
    config.indexing.include,
    config.indexing.exclude
  )
);

console.log(`Files to index: ${filesToIndex.length}`);
console.log('First 10 files:');
filesToIndex.slice(0, 10).forEach(f => console.log('  ' + f));
