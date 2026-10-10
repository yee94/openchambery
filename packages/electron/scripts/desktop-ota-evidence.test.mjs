import { test, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAssetZip } from '../../web/server/lib/zip-assets.js';
import { desktopOtaEvidenceArgs } from './desktop-ota-evidence-launch.mjs';

test.each(['download', 'apply'])('Linux %s fixture disables the sandbox before Electron starts', (stage) => {
  const args = desktopOtaEvidenceArgs({ script: 'fixture.mjs', root: 'fixture-data', stage, platform: 'linux' });
  expect(args).toContain('--no-sandbox');
  expect(args.slice(0, 3)).toEqual(['fixture.mjs', 'fixture-data', stage]);
});

test.each(['darwin', 'win32'])('%s fixture keeps its default sandbox', (platform) => {
  expect(desktopOtaEvidenceArgs({ script: 'fixture.mjs', root: 'fixture-data', platform })).not.toContain('--no-sandbox');
});

test('real Electron relaunch loads downloaded resources through the packaged protocol', { timeout: 30000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'electron-ota-evidence-'));
  let child;
  try {
    const assets = path.join(root, 'assets');
    await mkdir(assets);
    await writeFile(path.join(assets, 'index.html'), '<!doctype html><body>OTA 2.1.1-beta.2</body>');
    await writeFile(path.join(assets, 'desktop-ota.json'), JSON.stringify({ releaseVersion: '2.1.1-beta.2' }));
    createAssetZip(assets, path.join(root, 'bundle.zip'));
    const bytes = await readFile(path.join(root, 'bundle.zip'));
    const checksum = createHash('sha256').update(bytes).digest('hex');
    const bundleId = checksum.slice(0, 16);
    await writeFile(path.join(root, 'decision.json'), JSON.stringify({ status: 'ok', primaryAction: 'apply_ota',
      native: { state: 'current' }, nextCheckInSec: 3600, ota: { state: 'available', bundle: {
        bundleId, releaseVersion: '2.1.1-beta.2', url: `https://openchamber-update.vercel.app/ota/bundles/${bundleId}.zip`,
        size: bytes.length, checksum, minShellApiVersion: 1, minShellReleaseVersion: '2.1.0',
      } } }));
    const require = createRequire(import.meta.url);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    child = spawn(require('electron'), desktopOtaEvidenceArgs({
      script: path.join(path.dirname(fileURLToPath(import.meta.url)), 'desktop-ota-evidence.mjs'), root,
    }), {
      env, stdio: 'pipe', windowsHide: true,
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const resultPath = path.join(root, 'result.json');
    const deadline = Date.now() + 25000;
    let result;
    while (Date.now() < deadline) {
      try { result = JSON.parse(await readFile(resultPath, 'utf8')); break; }
      catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
      if (child.signalCode || (child.exitCode !== null && child.exitCode !== 0)) {
        throw new Error(`Electron fixture exited (${child.signalCode ?? child.exitCode}): ${stderr}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(result, stderr).toBeDefined();
    expect(result.error).toBeUndefined();
    expect(result.pid).not.toBe(result.before.pid);
    expect(result.before.version).toBe('2.1.0');
    expect(result.version).toBe('2.1.1-beta.2');
    expect(result.rendered).toContain('OTA 2.1.1-beta.2');
    expect(result.trial).toBe(false);
  } finally {
    if (child && child.exitCode === null) child.kill();
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
