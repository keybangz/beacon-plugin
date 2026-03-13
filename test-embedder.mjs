import { Embedder } from './dist/lib/embedder.js';
import { loadConfig } from './dist/lib/config.js';

const config = loadConfig(process.cwd());
const embedder = new Embedder(config.embedding);

console.log('Testing embedder...');
const pingResult = await embedder.ping();
console.log('Ping:', pingResult);

if (pingResult.ok) {
  const texts = ['function definition', 'class method', 'variable declaration'];
  const embeddings = await embedder.embedDocuments(texts);
  console.log(`Successfully embedded ${embeddings.length} texts`);
  console.log(`Embedding dimensions: ${embeddings[0].length}`);
}
