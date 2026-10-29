import { readFileSync, existsSync } from 'node:fs';
import { mkdtemp, writeFile, rm, mkdir, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import vm from 'node:vm';
import { expect, test, vi } from 'vitest';

const directory = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(directory, 'main.mjs'), 'utf8');
const themeCode = source.slice(source.indexOf('const readThemeSource ='), source.indexOf('const getWindowIconPath ='));

test('Dock appearance restores app intent, avoids redundant writes and retries failed updates', () => {
  const settings = { themeMode: 'light', themeVariant: 'dark' };
  const nativeTheme = { shouldUseDarkColors: false };
  const setIcon = vi.fn();
  const context = vm.createContext({
    process: { platform: 'darwin' }, app: { dock: { setIcon } }, nativeTheme,
    isPreviewDesktop: false, resourceRoot: () => '/resources', path,
    fs: { existsSync: () => true }, log: { warn: vi.fn() }, readSettingsRoot: () => settings,
  });
  vm.runInContext(themeCode + '\nglobalThis.sync = syncMacDockIcon; globalThis.read = readThemeSource;', context);
  expect(context.read()).toBe('light');
  context.sync();
  context.sync();
  expect(setIcon).toHaveBeenCalledTimes(1);
  expect(setIcon.mock.lastCall[0]).toMatch(/yuri-icon-light-1024.png$/);
  nativeTheme.shouldUseDarkColors = true;
  setIcon.mockImplementationOnce(() => { throw new Error('failed'); });
  context.sync();
  context.sync();
  expect(setIcon).toHaveBeenCalledTimes(3);
  expect(setIcon.mock.lastCall[0]).toMatch(/yuri-icon-dark-1024.png$/);
  context.isPreviewDesktop = true;
  nativeTheme.shouldUseDarkColors = false;
  context.sync();
  expect(setIcon).toHaveBeenCalledTimes(3);
  context.isPreviewDesktop = false;
  context.process.platform = 'win32';
  context.sync();
  expect(setIcon).toHaveBeenCalledTimes(3);
});

test.skipIf(process.platform !== 'darwin')('real macOS Dock accepts both themes from development and staged resources', { timeout: 30000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuri-dock-theme-'));
  try {
    const staged = path.join(root, 'resources');
    const config = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'));
    for (const variant of ['light', 'dark']) {
      const entry = config.build.extraResources.find((item) => item.to === `icons/source/yuri-icon-${variant}-1024.png`);
      expect(entry).toBeDefined();
      expect(existsSync(path.join(directory, entry.from))).toBe(true);
      await mkdir(path.dirname(path.join(staged, entry.to)), { recursive: true });
      await copyFile(path.join(directory, entry.from), path.join(staged, entry.to));
    }
    const fixture = path.join(root, 'fixture.cjs');
    await writeFile(fixture, `
      const { app, nativeTheme, nativeImage } = require('electron');
      const fs = require('node:fs'); const path = require('node:path');
      const isPreviewDesktop = false; const log = { warn: (message, error) => { throw error; } };
      let resources; let settings;
      const resourceRoot = () => resources;
      const readSettingsRoot = () => settings;
      app.setPath('userData', ${JSON.stringify(path.join(root, 'user-data'))});
      ${themeCode}
      app.whenReady().then(async () => {
        nativeTheme.on('updated', syncMacDockIcon);
        for (resources of ${JSON.stringify([path.join(directory, 'resources'), staged])}) {
          for (const mode of ['light', 'dark', 'light']) {
            settings = { themeMode: mode, themeVariant: mode === 'light' ? 'dark' : 'light' };
            nativeTheme.themeSource = readThemeSource();
            if (!currentDockIconPath) syncMacDockIcon();
            await new Promise(resolve => setTimeout(resolve, 100));
            if (!currentDockIconPath?.endsWith('yuri-icon-' + mode + '-1024.png')) throw Error('Theme did not propagate');
            if (nativeImage.createFromPath(currentDockIconPath).isEmpty()) throw Error('Empty icon');
          }
        }
        console.log('dock-theme-ok'); app.exit(0);
      }).catch(error => { console.error(error); app.exit(1); });
    `);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const { stdout } = await promisify(execFile)(createRequire(import.meta.url)('electron'), [fixture], { env, timeout: 20000 });
    expect(stdout).toContain('dock-theme-ok');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
