import { test, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DesktopOta } from './desktop-ota.mjs';

test('OTA backend resolves ESM and createRequire dependencies from the installed package', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'desktop-backend-'));
  try {
    const builtin = path.join(root, 'installed/server/index.js');
    const backend = path.join(root, 'downloaded');
    await mkdir(path.dirname(builtin), { recursive: true });
    await mkdir(backend);
    const dependency = path.join(root, 'installed/node_modules/fixture-dependency');
    await mkdir(dependency, { recursive: true });
    await writeFile(path.join(dependency, 'package.json'), JSON.stringify({ main: 'index.cjs' }));
    await writeFile(path.join(dependency, 'index.cjs'), 'module.exports = { nativeAbi: "installed" };');
    await writeFile(path.join(backend, 'entry.mjs'), `
      import dep from 'fixture-dependency';
      import { createRequire } from 'node:module';
      export default [dep.nativeAbi, createRequire(import.meta.url)('fixture-dependency').nativeAbi];
    `);
    const loader = new URL('./desktop-backend.mjs', import.meta.url).href;
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
      import { registerDesktopBackend } from ${JSON.stringify(loader)};
      const hook = registerDesktopBackend(${JSON.stringify({ directory: backend, builtinEntry: pathToFileURL(builtin).href })});
      const result = await import(${JSON.stringify(pathToFileURL(path.join(backend, 'entry.mjs')).href)});
      console.log(JSON.stringify(result.default));
      hook.deregister();
    `]);
    expect(JSON.parse(stdout)).toEqual(['installed', 'installed']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('backend-bearing OTA activates persistently without startup rollback and rejects mixed versions', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'desktop-backend-state-'));
  try {
    const bundle = { bundleId: 'a'.repeat(16), releaseVersion: '2.1.1' };
    const dir = path.join(root, bundle.bundleId);
    await mkdir(path.join(dir, 'desktop-backend/server'), { recursive: true });
    await writeFile(path.join(dir, 'index.html'), 'new UI');
    await writeFile(path.join(dir, 'desktop-ota.json'), JSON.stringify({ releaseVersion: '2.1.1', backendVersion: '2.1.1' }));
    await writeFile(path.join(dir, 'desktop-backend/package.json'), JSON.stringify({ version: '2.1.0' }));
    await writeFile(path.join(dir, 'desktop-backend/server/index.js'), 'export const version = "2.1.1";');
    const options = { directory: root, builtinDirectory: root, nativeVersion: '2.1.0', requireBackend: true };
    const ota = new DesktopOta(options);
    expect(await ota.usable(bundle)).toBe(false);
    await writeFile(path.join(dir, 'desktop-backend/package.json'), JSON.stringify({ version: '2.1.1' }));
    ota.state.queued = bundle;
    await ota.persist();
    await ota.initialize();
    expect(ota.backendDirectory).toBe(path.join(dir, 'desktop-backend'));
    expect(ota.state.trial).toBe(false);
    const restarted = new DesktopOta(options);
    await restarted.initialize();
    expect(restarted.version).toBe('2.1.1');
    await rm(path.join(dir, 'desktop-backend/server/index.js'));
    await expect(new DesktopOta(options).initialize()).rejects.toThrow('clear the OTA cache');
  } finally { await rm(root, { recursive: true, force: true }); }
});
