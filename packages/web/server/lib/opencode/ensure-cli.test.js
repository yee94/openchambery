import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PINNED_OPENCODE2_VERSION } from './opencode2-pin.js';
import {
  ensurePinnedOpenCode2Cli,
  installedOpenCode2BinaryPath,
  isOpenCode2AutoInstallEnabled,
  resolveOpenChamberDataDir,
} from './ensure-cli.js';

const tempDirs = [];

const createTempDir = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('ensurePinnedOpenCode2Cli', () => {
  it('keeps a discovered binary that already meets the pin', async () => {
    const result = await ensurePinnedOpenCode2Cli({
      discoveredPath: '/opt/opencode2',
      pin: '2.0.12',
      readVersion: () => '2.0.12',
      install: async () => {
        throw new Error('should not install');
      },
    });
    expect(result).toEqual({
      path: '/opt/opencode2',
      version: '2.0.12',
      source: 'discovered',
      installed: false,
    });
  });

  it('reuses an older global 2.x binary instead of reinstalling the pin', async () => {
    const result = await ensurePinnedOpenCode2Cli({
      discoveredPath: '/opt/old-opencode',
      pin: '2.0.12',
      readVersion: () => '2.0.5',
      install: async () => {
        throw new Error('should not install');
      },
    });
    expect(result.source).toBe('discovered');
    expect(result.path).toBe('/opt/old-opencode');
  });

  it('installs the pin only when no usable 2.x binary is present', async () => {
    const dataDir = createTempDir('openchamber-ensure-cli-');
    const installed = path.join(dataDir, 'opencode-cli', PINNED_OPENCODE2_VERSION, 'opencode');
    let installedOnce = false;
    const result = await ensurePinnedOpenCode2Cli({
      discoveredPath: '',
      pin: PINNED_OPENCODE2_VERSION,
      dataDir,
      platform: 'linux',
      readVersion: (binaryPath) => {
        if (binaryPath === installed && installedOnce) return PINNED_OPENCODE2_VERSION;
        return '';
      },
      install: async () => {
        installedOnce = true;
        return installed;
      },
    });
    expect(result).toEqual({
      path: installed,
      version: PINNED_OPENCODE2_VERSION,
      source: 'installed',
      installed: true,
    });
  });

  it('reuses a cached pin without downloading', async () => {
    const dataDir = createTempDir('openchamber-ensure-cached-');
    const cached = installedOpenCode2BinaryPath(PINNED_OPENCODE2_VERSION, { dataDir, platform: 'linux' });
    const result = await ensurePinnedOpenCode2Cli({
      pin: PINNED_OPENCODE2_VERSION,
      dataDir,
      platform: 'linux',
      readVersion: (binaryPath) => (binaryPath === cached ? PINNED_OPENCODE2_VERSION : ''),
      install: async () => {
        throw new Error('should not install');
      },
    });
    expect(result.source).toBe('installed');
    expect(result.installed).toBe(false);
    expect(result.path).toBe(cached);
  });

  it('fails closed when auto-install is disabled and nothing usable is present', async () => {
    await expect(ensurePinnedOpenCode2Cli({
      pin: PINNED_OPENCODE2_VERSION,
      autoInstall: false,
      dataDir: createTempDir('openchamber-ensure-disabled-'),
      readVersion: () => '',
    })).rejects.toMatchObject({ code: 'OPENCODE_CLI_MISSING' });
  });

  it('treats OPENCHAMBER_OPENCODE2_AUTO_INSTALL=0 as disabled', () => {
    expect(isOpenCode2AutoInstallEnabled({ OPENCHAMBER_OPENCODE2_AUTO_INSTALL: '0' })).toBe(false);
    expect(isOpenCode2AutoInstallEnabled({})).toBe(true);
  });

  it('resolves the OpenChamber data dir from OPENCHAMBER_DATA_DIR', () => {
    const dataDir = createTempDir('openchamber-data-dir-');
    expect(resolveOpenChamberDataDir({ OPENCHAMBER_DATA_DIR: dataDir })).toBe(path.resolve(dataDir));
  });
});
