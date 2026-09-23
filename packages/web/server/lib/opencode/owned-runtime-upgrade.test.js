import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildUpgradeStatusSnapshot,
  classifyRuntimeOwnership,
  createUpgradeOperationState,
  evaluateOwnedUpgradeResult,
  isOwnedOpenCodeCachePath,
} from './owned-runtime-upgrade.js';
import { evaluateRuntimeContract } from './runtime-contract.js';

describe('owned runtime upgrade (ticket 12)', () => {
  const dataDir = path.join('/tmp', 'openchamber-owned-upgrade-test');
  const ownedBinary = path.join(dataDir, 'opencode-cli', '2.0.12', 'opencode');

  it('models binary vs process ownership separately', () => {
    expect(isOwnedOpenCodeCachePath(ownedBinary, dataDir)).toBe(true);
    expect(isOwnedOpenCodeCachePath('/usr/local/bin/opencode', dataDir)).toBe(false);

    const externalUsingOwnedFile = classifyRuntimeOwnership({
      isExternal: true,
      binaryPath: ownedBinary,
      binarySource: 'installed',
      dataDir,
    });
    expect(externalUsingOwnedFile.ownership).toBe('external-serve');
    expect(externalUsingOwnedFile.canUpgradeInApp).toBe(false);
    expect(externalUsingOwnedFile.binaryOwnership).toBe('owned-cache');

    const managedGlobal = classifyRuntimeOwnership({
      isExternal: false,
      binarySource: 'path',
      binaryPath: '/usr/local/bin/opencode',
      dataDir,
    });
    expect(managedGlobal.ownership).toBe('global-cli');
    expect(managedGlobal.canUpgradeInApp).toBe(false);
    expect(managedGlobal.guidance).toMatch(/global/i);

    const owned = classifyRuntimeOwnership({
      isExternal: false,
      binarySource: 'installed',
      binaryPath: ownedBinary,
      dataDir,
    });
    expect(owned.ownership).toBe('owned-cache');
    expect(owned.canUpgradeInApp).toBe(true);

    const bundled = classifyRuntimeOwnership({
      isExternal: false,
      binarySource: 'bundled',
      binaryPath: '/app/resources/opencode-cli/opencode',
    });
    expect(bundled.canUpgradeInApp).toBe(false);
    expect(bundled.management).toBe('bundled');
  });

  it('upgrade-status exposes manage rights and manual guidance', () => {
    const globalStatus = buildUpgradeStatusSnapshot({
      ownership: classifyRuntimeOwnership({ isExternal: false, binarySource: 'path' }),
      serveVersion: '2.0.12',
      cliVersion: '2.0.12',
      targetVersion: '2.0.14',
    });
    expect(globalStatus.canManage).toBe(false);
    expect(globalStatus.available).toBeNull();
    expect(globalStatus.management).toBe('manual-global');
    expect(globalStatus.guidance).toBeTruthy();
    expect(globalStatus.currentVersion).toBe('2.0.12');
    expect(globalStatus.targetVersion).toBe('2.0.14');

    const ownedStatus = buildUpgradeStatusSnapshot({
      ownership: classifyRuntimeOwnership({
        isExternal: false,
        binarySource: 'installed',
        binaryPath: ownedBinary,
        dataDir,
      }),
      serveVersion: '2.0.12',
      targetVersion: '2.0.14',
    });
    expect(ownedStatus.canManage).toBe(true);
    expect(ownedStatus.available).toBe(true);
    expect(ownedStatus.management).toBe('in-app');
  });

  it('verifies running serve identity before upgrade success', () => {
    const contractOk = evaluateRuntimeContract({
      serveVersion: '2.0.14',
      reachable: true,
      authenticated: true,
      healthOk: true,
      migrationAdmitTranscript: true,
    });
    expect(evaluateOwnedUpgradeResult({
      targetVersion: '2.0.14',
      serveVersion: '2.0.14',
      binaryPath: ownedBinary,
      expectedBinaryPath: ownedBinary,
      contract: contractOk,
    }).ok).toBe(true);

    expect(evaluateOwnedUpgradeResult({
      targetVersion: '2.0.14',
      serveVersion: '2.0.12',
      contract: evaluateRuntimeContract({
        serveVersion: '2.0.12',
        reachable: true,
        authenticated: true,
        healthOk: true,
        migrationAdmitTranscript: true,
      }),
    })).toMatchObject({
      ok: false,
      errorCode: 'UPGRADE_SERVE_VERSION_MISMATCH',
    });

    expect(evaluateOwnedUpgradeResult({
      targetVersion: '2.0.14',
      serveVersion: '2.0.14',
      binaryPath: '/usr/bin/opencode',
      expectedBinaryPath: ownedBinary,
      contract: contractOk,
    }).errorCode).toBe('UPGRADE_BINARY_IDENTITY_MISMATCH');

    // Target match alone is not enough — below-minimum versions must not succeed.
    expect(evaluateOwnedUpgradeResult({
      targetVersion: '2.0.5',
      serveVersion: '2.0.5',
      contract: evaluateRuntimeContract({
        serveVersion: '2.0.5',
        reachable: true,
        authenticated: true,
        healthOk: true,
        migrationAdmitTranscript: true,
      }),
    })).toMatchObject({
      ok: false,
      errorCode: 'UPGRADE_CONTRACT_FAILED',
    });
  });

  it('keeps concurrent upgrade state stable and reconciles failures', () => {
    const op = createUpgradeOperationState();
    expect(op.begin('2.0.14').ok).toBe(true);
    const second = op.begin('2.0.14');
    expect(second.ok).toBe(false);
    expect(second.status).toBe(409);
    expect(second.body.errorCode).toBe('UPGRADE_IN_PROGRESS');

    op.setPhase('download');
    op.fail({ error: 'download failed', errorCode: 'UPGRADE_DOWNLOAD_FAILED', phase: 'download' });
    expect(op.getState()).toMatchObject({
      status: 'failed',
      errorCode: 'UPGRADE_DOWNLOAD_FAILED',
      phase: 'download',
      targetVersion: '2.0.14',
    });
  });
});
