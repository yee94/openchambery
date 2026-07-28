import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skippedDirectories = new Set([
  '.git',
  '.turbo',
  '.vite',
  '.cache',
  'build',
  'coverage',
  'dist',
  'dist-assistant-preview',
  'dist-bundle',
  'dist-preview',
  'node_modules',
  'opencode-cli',
  'Pods',
  'release',
  'sidecar',
  'web-dist',
]);
const prohibitedValues = [
  { label: 'private domain', value: ['yee', '.wang'].join('') },
  { label: 'private domain', value: ['yee', 'e.wang'].join('') },
  { label: 'personal Docker namespace', value: ['xiao', 'be/'].join('') },
  { label: 'personal machine path', value: ['/users/', 'yee/'].join('') },
  { label: 'personal fork name', value: ['openchamber-', 'yee'].join('') },
];

const filesIn = async (directory) => {
  const files = [];
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!skippedDirectories.has(entry.name)) files.push(...await filesIn(absolutePath));
      continue;
    }
    if (entry.isFile()) files.push(absolutePath);
  }
  return files;
};

const violations = [];
const files = await filesIn(repositoryRoot);
let nextFileIndex = 0;
const scanNextFile = async () => {
  const absolutePath = files[nextFileIndex];
  nextFileIndex += 1;
  if (!absolutePath) return;
  const buffer = await fs.readFile(absolutePath);
  if (!buffer.includes(0)) {
    const text = buffer.toString('utf8');
    const normalized = text.toLowerCase();
    for (const prohibited of prohibitedValues) {
      let offset = normalized.indexOf(prohibited.value);
      while (offset !== -1) {
        const line = text.slice(0, offset).split('\n').length;
        violations.push({
          file: path.relative(repositoryRoot, absolutePath),
          line,
          label: prohibited.label,
        });
        offset = normalized.indexOf(prohibited.value, offset + prohibited.value.length);
      }
    }
  }
  await scanNextFile();
};
const workerCount = Math.min(32, files.length);
await Promise.all(Array.from({ length: workerCount }, () => scanNextFile()));

if (violations.length > 0) {
  console.error('Repository neutrality check failed:');
  for (const violation of violations) {
    console.error(`- ${violation.file}:${violation.line}: ${violation.label}`);
  }
  process.exitCode = 1;
} else {
  console.log('Repository neutrality check passed.');
}
