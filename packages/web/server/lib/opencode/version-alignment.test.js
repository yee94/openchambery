import { describe, expect, it, vi } from 'vitest';
import { MINIMUM_OPENCODE2_VERSION, PINNED_OPENCODE2_VERSION } from './opencode2-pin.js';
import { evaluateRuntimeContract } from './runtime-contract.js';
import { describeUpgradeScreen, installRequiredOpenCode, resolveUpgradeScreenTarget } from './upgrade-screen.js';
import { ensurePinnedOpenCode2Cli } from './ensure-cli.js';

describe('v2 version alignment', () => {
  it.each(['1.18.30', '2.0.19', null, 'unknown'])('blocks execution and startup for %s', (version) => {
    expect(evaluateRuntimeContract({ serveVersion: version, cliVersion: '2.0.23', reachable: true, authenticated: true }).executionAllowed).toBe(false);
    expect(describeUpgradeScreen({ version }).state).not.toBe('compatible');
  });
  it.each(['2.0.20', '2.0.23', '2.1.0'])('admits running %s independently of CLI pin', (version) => {
    expect(evaluateRuntimeContract({ serveVersion: version, cliVersion: '2.0.15', reachable: true, authenticated: true })).toMatchObject({ executionAllowed: true, versionMismatch: true, minVerifiedVersion: '2.0.20' });
    expect(describeUpgradeScreen({ version }).state).toBe('compatible');
  });
  it('installs the audited pin on first install and preserves newer discovered CLIs', async () => {
    expect(MINIMUM_OPENCODE2_VERSION).toBe('2.0.20');
    expect(PINNED_OPENCODE2_VERSION).toBe('2.0.23');
    expect(resolveUpgradeScreenTarget()).toBe('2.0.23');
    const install = vi.fn(async () => '/owned/opencode');
    await expect(ensurePinnedOpenCode2Cli({ readVersion: (path) => path === '/owned/opencode' ? '2.0.23' : '', install })).resolves.toMatchObject({ version: '2.0.23', installed: true });
    expect(install).toHaveBeenCalledWith(expect.objectContaining({ version: '2.0.23' }));
    install.mockClear();
    await expect(ensurePinnedOpenCode2Cli({ discoveredPath: '/global/opencode', readVersion: () => '2.1.0', install })).resolves.toMatchObject({ version: '2.1.0', installed: false });
    expect(install).not.toHaveBeenCalled();
  });
  it('does not infer a successful installation from an unreadable binary', async () => {
    await expect(ensurePinnedOpenCode2Cli({ readVersion: () => '', install: async () => '/owned/opencode' })).rejects.toThrow('got unknown');
  });
  it('verifies the live service after explicit install, and rolls selection back on failure', async () => {
    const persistBinary = vi.fn();
    const restart = vi.fn();
    const deps = { resolveOwnership: async () => ({ ownership: 'shared-service' }), readServeVersion: vi.fn().mockResolvedValueOnce('2.0.19').mockResolvedValueOnce('2.0.23'), readCliVersion: () => '2.0.23', platformCanInstall: true, install: async () => '/owned/opencode', readBinaryVersion: () => '2.0.23', persistBinary, restart, isSharedService: () => true };
    await expect(installRequiredOpenCode(deps)).resolves.toMatchObject({ upgraded: true, version: '2.0.23' });
    expect(restart).toHaveBeenCalledWith({ binaryPath: '/owned/opencode' });
    deps.readServeVersion.mockResolvedValue('2.0.19');
    await expect(installRequiredOpenCode(deps)).rejects.toMatchObject({ code: 'UPGRADE_SCREEN_NOT_VERIFIED' });
    expect(persistBinary).toHaveBeenLastCalledWith('');
  });
});
