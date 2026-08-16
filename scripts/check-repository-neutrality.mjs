import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skippedDirectories = new Set([
  '.git',
  '.turbo',
  '.vite',
  '.cache',
  'build',
  'coverage',
  'data',
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

/**
 * Files git can actually carry: tracked, plus untracked that are not ignored.
 *
 * This is the real boundary of a repository artifact. Walking the filesystem
 * instead also picks up ignored local files — IDE and language-server state
 * holding a developer's machine path — which can never reach the repository,
 * so failing on them only breaks lint on that one machine.
 *
 * Returns null when git cannot answer (archive export, no git binary) so the
 * caller falls back to the filesystem walk.
 */
const repositoryFiles = async () => {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      { cwd: repositoryRoot, maxBuffer: 256 * 1024 * 1024 },
    );
    const relativePaths = stdout.split('\0').filter(Boolean);
    if (relativePaths.length === 0) return null;
    return relativePaths.map((relativePath) => path.join(repositoryRoot, relativePath));
  } catch {
    return null;
  }
};

const violations = [];
const files = await repositoryFiles() ?? await filesIn(repositoryRoot);
let nextFileIndex = 0;
const scanNextFile = async () => {
  const absolutePath = files[nextFileIndex];
  nextFileIndex += 1;
  if (!absolutePath) return;
  // git can list entries that are not readable files here: staged deletions
  // and submodule roots. Neither is content this gate can inspect.
  let buffer;
  try {
    buffer = await fs.readFile(absolutePath);
  } catch {
    await scanNextFile();
    return;
  }
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
