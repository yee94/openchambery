import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
const PINNED_OPENCODE2_VERSION = '2.0.23';
import { configureOpenCodeTerminalPath } from './terminal-path.js';
import {
  ensurePinnedOpenCode2Cli,
  installedOpenCode2BinaryPath,
  isOpenCode2AutoInstallEnabled,
  resolveYuriDataDir,
  upgradeSelectedOpenCodeCli,
} from './ensure-cli.js';

vi.mock('./terminal-path.js', () => ({ configureOpenCodeTerminalPath: vi.fn() }));

const tempDirs = [];

const createTempDir = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  vi.clearAllMocks();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('ensurePinnedOpenCode2Cli', () => {
  it('resolves the latest stable 2.x for a fresh installation', async () => {
    const dataDir = createTempDir('yuri-latest-cli-');
    const installed = path.join(dataDir, 'opencode-cli', '2.9.1', 'opencode');
    const install = vi.fn(async () => installed);
    const result = await ensurePinnedOpenCode2Cli({ dataDir,
      resolveLatestVersion: async () => '2.9.1', install,
      readVersion: (file) => file === installed ? '2.9.1' : '',
    });
    expect(install).toHaveBeenCalledWith(expect.objectContaining({ version: '2.9.1' }));
    expect(result.version).toBe('2.9.1');
    expect(configureOpenCodeTerminalPath).toHaveBeenCalledWith(installed, expect.objectContaining({ dataDir }));
  });

  it.each(['1.18.4', '3.0.0', '2.9.1-beta.1', '2.0.1'])('never chooses an unsuitable fresh-install target %s', async (latest) => {
    const install = vi.fn(async () => '/installed/opencode');
    await expect(ensurePinnedOpenCode2Cli({ dataDir: createTempDir('yuri-invalid-cli-'), install,
      resolveLatestVersion: async () => latest,
      readVersion: (file) => file === '/installed/opencode' ? PINNED_OPENCODE2_VERSION : '',
    })).rejects.toThrow('Invalid stable OpenCode installation target');
    expect(install).not.toHaveBeenCalled();
  });

  it('reuses the newest verified cache offline instead of reinstalling the pin', async () => {
    const dataDir = createTempDir('yuri-new-cache-');
    for (const version of [PINNED_OPENCODE2_VERSION, '2.9.1', '2.10.0']) {
      fs.mkdirSync(path.join(dataDir, 'opencode-cli', version), { recursive: true });
    }
    const latest = installedOpenCode2BinaryPath('2.10.0', { dataDir });
    const resolveLatestVersion = vi.fn();
    const result = await ensurePinnedOpenCode2Cli({ dataDir, resolveLatestVersion,
      readVersion: (file) => path.basename(path.dirname(file)),
      install: async () => { throw new Error('must not install'); },
    });
    expect(result).toMatchObject({ path: latest, version: '2.10.0', installed: false });
    expect(resolveLatestVersion).not.toHaveBeenCalled();
  });

  it('reports registry failure without installing an obsolete fallback', async () => {
    const dataDir = createTempDir('yuri-offline-cli-');
    const install = vi.fn(async () => '/installed/opencode');
    await expect(ensurePinnedOpenCode2Cli({ dataDir, install,
      resolveLatestVersion: async () => { throw new Error('offline'); },
      readVersion: (file) => file === '/installed/opencode' ? PINNED_OPENCODE2_VERSION : '',
    })).rejects.toThrow('offline');
    expect(install).not.toHaveBeenCalled();
  });

  it('runs upgrade through the selected launch target and preserves its CLI entry path', async () => {
    const dir = createTempDir('yuri-upgrade-cli-');
    const script = path.join(dir, 'cli.cjs');
    const output = path.join(dir, 'invocation.json');
    fs.writeFileSync(script, 'require("node:fs").writeFileSync(process.env.RESULT_FILE, JSON.stringify(process.argv.slice(2)))');
    const entry = path.join(dir, 'opencode');
    await expect(upgradeSelectedOpenCodeCli({
      binaryPath: entry,
      version: '2.0.23',
      launchSpec: { binary: process.execPath, args: [script] },
      env: { ...process.env, RESULT_FILE: output },
    })).resolves.toBe(entry);
    expect(JSON.parse(fs.readFileSync(output, 'utf8'))).toEqual(['upgrade', '2.0.23']);
  });

  it('reports a failed CLI upgrade without exposing child output', async () => {
    await expect(upgradeSelectedOpenCodeCli({
      binaryPath: '/missing/opencode',
      version: '2.0.23',
      execFileImpl: (_binary, _args, _options, callback) => callback(new Error('sensitive child output')),
    })).rejects.toMatchObject({ code: 'UPGRADE_GLOBAL_CLI_FAILED', message: expect.not.stringContaining('sensitive') });
  });

  it('does not start a console-grandchild batch shim for upgrades on Windows', async () => {
    await expect(upgradeSelectedOpenCodeCli({
      binaryPath: 'C:\\tools\\opencode.cmd',
      version: '2.0.23',
      launchSpec: { binary: 'cmd.exe', args: [], wrapperType: 'cmd-wrapper' },
      execFileImpl: () => { throw new Error('must not spawn'); },
    })).rejects.toMatchObject({ code: 'UPGRADE_GLOBAL_CLI_UNSUPPORTED' });
  });

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
    expect(configureOpenCodeTerminalPath).not.toHaveBeenCalled();
  });

  it('installs the pin only when no usable 2.x binary is present', async () => {
    const dataDir = createTempDir('yuri-ensure-cli-');
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
    const dataDir = createTempDir('yuri-ensure-cached-');
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
      dataDir: createTempDir('yuri-ensure-disabled-'),
      readVersion: () => '',
    })).rejects.toMatchObject({ code: 'OPENCODE_CLI_MISSING' });
  });

  it('treats YURI_OPENCODE2_AUTO_INSTALL=0 as disabled', () => {
    expect(isOpenCode2AutoInstallEnabled({ YURI_OPENCODE2_AUTO_INSTALL: '0' })).toBe(false);
    expect(isOpenCode2AutoInstallEnabled({})).toBe(true);
  });

  it('resolves the Yuri data dir from YURI_DATA_DIR', () => {
    const dataDir = createTempDir('yuri-data-dir-');
    expect(resolveYuriDataDir({ YURI_DATA_DIR: dataDir })).toBe(path.resolve(dataDir));
  });
});
