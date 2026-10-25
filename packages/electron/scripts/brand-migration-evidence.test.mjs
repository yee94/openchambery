import { test } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('real Electron migrates old origin drafts, attachments and transcript without deleting source', { timeout: 120_000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yuri-origin-migration-'));
  const packageRoot = fileURLToPath(new URL('..', import.meta.url));
  try {
    for (const phase of ['seed', 'target', 'interrupt', 'migrate', 'verify']) {
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(path.join(packageRoot, 'node_modules/.bin/electron'), ['--headless', '--disable-gpu', path.join(packageRoot, 'scripts/brand-migration-evidence.mjs'), '--', root, phase], { env, stdio: 'inherit' });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Migration ${phase} timed out`)); }, 30_000);
        child.on('error', reject);
        child.on('exit', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Migration ${phase} failed: ${code}`)); });
      });
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
