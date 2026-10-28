import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build, createServer } from 'vite';
import { expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../../', import.meta.url));
test('real Electron: standard GUI main + preload IPC exports PDFs with HMR and bundled UI', { timeout: 120000 }, async () => {
  const work = await mkdtemp(join(process.env.YURI_TEST_EVIDENCE_DIR || tmpdir(), 'gui-plugin-pdf-'));
  let devServer;
  try {
    await build({ configFile: false, root: resolve(root, 'packages/ui'), publicDir: false,
      resolve: { conditions: ['browser'], alias: { '@': resolve(root, 'packages/ui/src') } },
      build: { outDir: work, emptyOutDir: false, target: 'esnext', minify: false,
        lib: { entry: resolve(root, 'packages/ui/src/lib/gui-plugins/native.electron.fixture.ts'), formats: ['es'], fileName: () => 'fixture.js' },
      },
    });
    devServer = await createServer({ configFile: false, root: resolve(root, 'packages/ui'), publicDir: false,
      resolve: { conditions: ['browser'], alias: { '@': resolve(root, 'packages/ui/src') } },
      server: { host: '127.0.0.1', port: 0 },
      plugins: [{ name: 'gui-plugin-evidence-page', configureServer(server) {
        server.middlewares.use((request, response, next) => {
          if (request.url !== '/') return next();
          response.setHeader('Content-Type', 'text/html');
          response.end('<html><body><script type="module" src="/@vite/client"></script><script type="module" src="/src/lib/gui-plugins/native.electron.fixture.ts"></script></body></html>');
        });
      } }],
    });
    await devServer.listen();
    for (const mode of ['hmr', 'packaged']) {
      await new Promise((done, reject) => {
        const env = { ...process.env, YURI_TEST_EVIDENCE_DIR: work, YURI_GUI_TEST_MODE: mode,
          YURI_GUI_TEST_ORIGIN: `http://127.0.0.1:${devServer.httpServer.address().port}` }; delete env.ELECTRON_RUN_AS_NODE;
        const child = spawn(require('electron'), [resolve(root, 'packages/electron/scripts/gui-plugin-evidence.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        let errors = '';
        child.stderr.on('data', (data) => { errors += data; });
        child.stdout.on('data', (data) => { errors += data; });
        const timeout = setTimeout(() => { child.kill(); reject(new Error(errors.slice(-5000))); }, 45000);
        child.once('error', (error) => { clearTimeout(timeout); reject(error); });
        child.once('exit', (status) => { clearTimeout(timeout); status === 0 ? done() : reject(new Error(errors.slice(-5000))); });
      });
      const pdf = await readFile(join(work, `${mode}.pdf`));
      expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
      expect(pdf.length).toBeGreaterThan(1000);
    }
  } finally {
    await devServer?.close();
    if (!process.env.YURI_TEST_EVIDENCE_DIR) await rm(work, { recursive: true, force: true });
  }
});
