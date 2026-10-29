import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../server/lib/llm');
const result = await Bun.build({
  entrypoints: [path.join(directory, 'bridge-plugin.js')],
  target: 'bun', format: 'esm', minify: true, sourcemap: 'none',
  outdir: directory, naming: 'bridge-plugin.bundle.js',
});
if (!result.success) throw new Error(result.logs.map(log => log.message).join('\n'));
console.log('Built self-contained Yuri LLM bridge');
