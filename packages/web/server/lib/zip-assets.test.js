import { afterEach, expect, test } from 'vitest';
import AdmZip from 'adm-zip';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { extractAssetZip } from './zip-assets.js';

const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function directory() {
  const dir = await mkdtemp(path.join(tmpdir(), 'asset-zip-'));
  roots.push(dir);
  return dir;
}

test('extracts nested web assets and rejects case-colliding filenames', async () => {
  const dir = await directory();
  const zip = new AdmZip();
  zip.addFile('assets/main.js', Buffer.from('document.body.textContent="ready"'));
  await extractAssetZip(zip.toBuffer(), dir);
  expect(await readFile(path.join(dir, 'assets/main.js'), 'utf8')).toContain('ready');
  zip.addFile('assets/MAIN.js', Buffer.from('collision'));
  await expect(extractAssetZip(zip.toBuffer(), await directory())).rejects.toThrow('Unsafe');
});

test('rejects traversal before extracting any files', async () => {
  const zip = new AdmZip();
  zip.addFile('safe-file.txt', Buffer.from('bad'));
  const bytes = zip.toBuffer();
  // Replace equal-length local and central-directory names, bypassing the
  // writer's own path normalization to exercise the untrusted archive reader.
  for (let index = bytes.indexOf('safe-file.txt'); index !== -1; index = bytes.indexOf('safe-file.txt', index + 1)) {
    bytes.write('../escape.txt', index);
  }
  await expect(extractAssetZip(bytes, await directory())).rejects.toThrow('Unsafe');
});
