import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { deflateSync, crc32 } from 'node:zlib';
import { createRequire } from 'node:module';
import { build } from 'vite';
import { expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const chunk = (name, content) => {
  const type = Buffer.from(name); const length = Buffer.alloc(4); length.writeUInt32BE(content.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(Buffer.concat([type, content])));
  return Buffer.concat([length, type, content, checksum]);
};
test('real Electron protocol: four 5 MiB images, preview and ten session revisits', { timeout: 120000 }, async () => {
  const work = await mkdtemp(join(process.env.OPENCHAMBER_TEST_EVIDENCE_DIR || tmpdir(), 'oc-image-bench-'));
  const src = resolve('packages/ui/src');
  try {
    const header = Buffer.alloc(13); header.writeUInt32BE(1024); header.writeUInt32BE(1280, 4); header[8] = 8; header[9] = 6;
    const pixels = Buffer.alloc((1024 * 4 + 1) * 1280, 160);
    for (let row = 0; row < 1280; row++) pixels[row * (1024 * 4 + 1)] = 0;
    await writeFile(join(work, 'image.png'), Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'),
      chunk('IHDR', header), chunk('IDAT', deflateSync(pixels, { level: 0 })), chunk('IEND', Buffer.alloc(0))]));
    const boundary = join(src, 'lib/runtime-image-cache.electron.boundary.ts');
    await build({ configFile: false, mode: 'production', root: resolve('packages/ui'), publicDir: false,
      esbuild: { jsxDev: false },
      resolve: { alias: [
        { find: /^@\/(lib\/(runtime-switch|runtime-auth|runtime-fetch|queryRuntime)|contexts\/runtimeAPIRegistry|queries\/fileQueries)$/, replacement: boundary },
        { find: /^\.\/(runtime-switch|runtime-auth|runtime-fetch)$/, replacement: boundary },
        { find: '@', replacement: src },
      ] },
      build: { outDir: work, emptyOutDir: false, minify: false, lib: { entry: join(src, 'lib/runtime-image-cache.electron.fixture.tsx'), formats: ['iife'], name: 'ImageCacheEvidence', fileName: () => 'fixture.js' } },
    });
    await new Promise((done, reject) => {
      const env = { ...process.env, OC_IMAGE_EVIDENCE_DIR: work }; delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(require('electron'), [resolve('packages/electron/scripts/image-cache-evidence.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let errors = '';
      child.stderr.on('data', (data) => { errors += data; });
      const timeout = setTimeout(() => { child.kill(); reject(new Error(`Evidence timeout: ${errors.slice(-3000)}`)); }, 90000);
      child.on('error', reject);
      child.on('exit', (code) => { clearTimeout(timeout); code === 0 ? done() : reject(new Error(errors.slice(-3000))); });
    });
    const result = JSON.parse(await readFile(join(work, 'result.json'), 'utf8'));
    expect(result.baseline.downloads).toBe(48);
    expect(result.cached.downloads).toBe(4);
    expect(result.cached.bytes).toBe(result.imageBytes * 4);
    expect(result.cached.urls.every((url) => url.startsWith('openchamber-asset://cache/'))).toBe(true);
    expect(result.packaged.downloads).toBe(0);
    expect(result.packaged.urls.every((url) => url.startsWith('openchamber-asset://cache/'))).toBe(true);
    console.info('Image cache evidence', JSON.stringify(result));
  } finally { if (!process.env.OPENCHAMBER_TEST_EVIDENCE_DIR) await rm(work, { recursive: true, force: true }); }
});
