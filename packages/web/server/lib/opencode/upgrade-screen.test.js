import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import {
  REQUIRED_OPENCODE_VERSION,
  describeUpgradeScreen,
  evaluateUpgradeScreenInstallResult,
  installRequiredOpenCode,
  registerUpgradeScreenRoutes,
  resolveUpgradeScreenTarget,
} from './upgrade-screen.js';

describe('upgrade screen version gate', () => {
  it('uses 2.0.15 even when the runtime pin is older', () => {
    expect(REQUIRED_OPENCODE_VERSION).toBe('2.0.15');
    expect(resolveUpgradeScreenTarget('2.0.12')).toBe('2.0.15');
    expect(resolveUpgradeScreenTarget('2.0.16')).toBe('2.0.16');
  });

  it('does not open the gate at or above 2.0.15', () => {
    expect(describeUpgradeScreen({
      version: '2.0.15',
      installation: 'managed',
      platformCanInstall: true,
    })).toMatchObject({ state: 'compatible', canInstall: false, minimumVersion: '2.0.15' });
    expect(describeUpgradeScreen({
      version: 'v2.0.16',
      installation: 'managed',
      platformCanInstall: true,
    }).state).toBe('compatible');
  });

  it('opens the gate below 2.0.15 and offers install only when this runtime can switch', () => {
    expect(describeUpgradeScreen({
      version: '2.0.14',
      installation: 'managed',
      platformCanInstall: true,
    })).toMatchObject({ state: 'incompatible', canInstall: true, version: '2.0.14' });
    expect(describeUpgradeScreen({
      version: '1.18.30',
      installation: 'managed',
      platformCanInstall: true,
    })).toMatchObject({ state: 'incompatible', canInstall: true });
    expect(describeUpgradeScreen({
      version: '2.0.14',
      installation: 'external',
      platformCanInstall: true,
    }).canInstall).toBe(false);
    expect(describeUpgradeScreen({
      version: '2.0.14',
      installation: 'bundled',
      platformCanInstall: true,
    })).toMatchObject({ state: 'incompatible', canInstall: true, installation: 'bundled' });
    expect(describeUpgradeScreen({
      version: '2.0.14',
      installation: 'managed',
      platformCanInstall: false,
    }).canInstall).toBe(false);
  });

  it('does not treat a missing version as an old install', () => {
    expect(describeUpgradeScreen({
      version: null,
      installation: 'managed',
      platformCanInstall: true,
    }).state).toBe('unavailable');
  });

  it('does not report an unverified install as upgraded', () => {
    expect(evaluateUpgradeScreenInstallResult({
      targetVersion: '2.0.15',
      serveVersion: '2.0.14',
    })).toMatchObject({ ok: false, upgraded: false, version: '2.0.14' });
    expect(evaluateUpgradeScreenInstallResult({
      targetVersion: '2.0.15',
      serveVersion: null,
    }).upgraded).toBe(false);
    expect(evaluateUpgradeScreenInstallResult({
      targetVersion: '2.0.15',
      serveVersion: '2.0.15',
    })).toMatchObject({ ok: true, upgraded: true, version: '2.0.15' });
  });
});

describe('installRequiredOpenCode', () => {
  const createDeps = (overrides = {}) => {
    const calls = [];
    const deps = {
      resolveOwnership: async () => ({ ownership: 'global-cli', guidance: null }),
      readServeVersion: async () => '2.0.14',
      readCliVersion: () => '2.0.14',
      platformCanInstall: true,
      install: vi.fn(async () => {
        calls.push('install');
        return '/cache/opencode';
      }),
      readBinaryVersion: vi.fn(() => '2.0.15'),
      persistBinary: vi.fn(async () => {
        calls.push('persist');
      }),
      forceBinary: vi.fn(() => {
        calls.push('force');
      }),
      restart: vi.fn(async () => {
        calls.push('restart');
      }),
      waitReady: vi.fn(async () => {
        calls.push('ready');
      }),
      readConfiguredBinary: async () => null,
      isSharedService: () => false,
      ...overrides,
    };
    return { deps, calls };
  };

  it('installs 2.0.15 and only succeeds after the running serve is verified', async () => {
    const { deps, calls } = createDeps({
      readServeVersion: vi.fn()
        .mockResolvedValueOnce('2.0.14')
        .mockResolvedValueOnce('2.0.15'),
    });

    await expect(installRequiredOpenCode(deps)).resolves.toMatchObject({
      ok: true,
      upgraded: true,
      version: '2.0.15',
      targetVersion: '2.0.15',
    });
    expect(deps.install).toHaveBeenCalledWith({ version: '2.0.15' });
    expect(calls).toEqual(['install', 'persist', 'force', 'restart', 'ready']);
  });

  it('returns the failure reason and does not claim an upgrade when verification fails', async () => {
    const { deps } = createDeps({
      readServeVersion: vi.fn()
        .mockResolvedValueOnce('1.18.30')
        .mockResolvedValueOnce('1.18.30'),
      readCliVersion: () => '1.18.30',
      readBinaryVersion: () => '2.0.15',
    });

    await expect(installRequiredOpenCode(deps)).rejects.toThrow(/still 1\.18\.30/);
    expect(deps.persistBinary).toHaveBeenCalledWith('');
  });

  it('does not install when the runtime cannot switch', async () => {
    const { deps } = createDeps({
      resolveOwnership: async () => ({
        ownership: 'external-serve',
        guidance: 'Restart that server yourself.',
      }),
    });

    await expect(installRequiredOpenCode(deps)).rejects.toMatchObject({
      status: 409,
      message: 'Restart that server yourself.',
    });
    expect(deps.install).not.toHaveBeenCalled();
  });
});

describe('upgrade screen routes', () => {
  it('hides the gate for 2.0.15 and reports install failure without upgraded:true', async () => {
    const app = express();
    app.use(express.json());
    const readServeVersion = vi.fn()
      .mockResolvedValueOnce('2.0.15')
      .mockResolvedValueOnce('2.0.12')
      .mockResolvedValueOnce('2.0.12');
    registerUpgradeScreenRoutes(app, {
      resolveOwnership: async () => ({ ownership: 'owned-cache', guidance: null }),
      readServeVersion,
      readCliVersion: () => '2.0.12',
      platformCanInstall: true,
      install: vi.fn(async () => {
        throw new Error('registry unreachable');
      }),
      readBinaryVersion: () => '2.0.15',
      persistBinary: vi.fn(),
      forceBinary: vi.fn(),
      restart: vi.fn(),
    });

    const compatible = await request(app).get('/api/opencode/compatibility').expect(200);
    expect(compatible.body).toMatchObject({ state: 'compatible', version: '2.0.15', minimumVersion: '2.0.15' });

    const failed = await request(app).post('/api/opencode/install-required').expect(500);
    expect(failed.body).toMatchObject({
      success: false,
      upgraded: false,
      error: 'registry unreachable',
    });
    expect(failed.body.upgraded).not.toBe(true);
  });
});
