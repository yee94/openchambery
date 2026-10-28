import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../../', import.meta.url));
test('real Electron: isolated container PDF/long PNG through production preload, HMR and packaged origin', { timeout: 120000 }, async () => {
  const work = await mkdtemp(join(process.env.YURI_TEST_EVIDENCE_DIR || tmpdir(), 'view-export-'));
  let server;
  let forbiddenRequests = 0;
  try {
    server = await createServer({ configFile: false, root: work, publicDir: false,
      server: { host: '127.0.0.1', port: 0 },
      plugins: [{ name: 'export-fixture', configureServer(vite) {
        vite.middlewares.use((request, response) => {
          if (/network-probe|frame-probe|leak/.test(request.url)) forbiddenRequests++;
          response.setHeader('Content-Type', 'text/html');
          response.end('<!doctype html><html><body>Export fixture<script type="module" src="/@vite/client"></script></body></html>');
        });
      } }],
    });
    await server.listen();
    for (const mode of ['hmr', 'packaged']) {
      await new Promise((done, reject) => {
        const env = { ...process.env, YURI_TEST_EVIDENCE_DIR: work, YURI_EXPORT_TEST_MODE: mode,
          YURI_EXPORT_TEST_ORIGIN: `http://127.0.0.1:${server.httpServer.address().port}` };
        delete env.ELECTRON_RUN_AS_NODE;
        const child = spawn(require('electron'), [resolve(root, 'packages/electron/scripts/view-export-evidence.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        child.stderr.on('data', (data) => { output += data; });
        child.stdout.on('data', (data) => { output += data; });
        const timeout = setTimeout(() => { child.kill(); reject(new Error(output.slice(-6000) || 'Electron fixture timed out')); }, 55000);
        child.once('error', (error) => { clearTimeout(timeout); reject(error); });
        child.once('exit', (status) => { clearTimeout(timeout); status === 0 ? done() : reject(new Error(output.slice(-6000))); });
      });
      const result = JSON.parse(await readFile(join(work, `${mode}-result.json`), 'utf8'));
      expect(result.png).toEqual({ width: 600, height: 4000 });
      expect(result.pages.a4).toBeGreaterThanOrEqual(3);
      expect(result.pages.letter).toBeGreaterThanOrEqual(3);
    }
    expect(forbiddenRequests).toBe(0);
  } finally {
    await server?.close();
    if (!process.env.YURI_TEST_EVIDENCE_DIR) await rm(work, { recursive: true, force: true });
  }
});
