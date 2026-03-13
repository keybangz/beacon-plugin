import { readFileSync, writeFileSync } from 'fs';
import { glob } from 'glob';

const patterns = [
  { regex: /from ['"](\.[^'"]+)(?<!\.js)(['"];)/g, replacement: 'from "$1.js$2' },
];

const files = await glob('src/lib/**/*.ts');

for (const file of files) {
  let content = readFileSync(file, 'utf-8');
  let modified = false;
  
  for (const { regex, replacement } of patterns) {
    const newContent = content.replace(regex, (match, path, quote) => {
      if (!path.endsWith('.js') && !path.endsWith('.json')) {
        modified = true;
        return `from "${path}.js"${quote}`;
      }
      return match;
    });
    content = newContent;
  }
  
  if (modified) {
    writeFileSync(file, content);
    console.log(`Fixed ${file}`);
  }
}
