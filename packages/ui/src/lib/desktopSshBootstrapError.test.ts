import { describe, expect, test } from 'vitest';
import {
  classifyManagedSshBootstrapError,
  formatSshBootstrapErrorDescription,
  isManagedSshBootstrapErrorCode,
  resolveManagedSshBootstrapErrorCode,
  sshBootstrapErrorGuidanceKey,
  sshBootstrapErrorTitleKey,
} from './desktopSshBootstrapError';

describe('classifyManagedSshBootstrapError', () => {
  test('classifies missing Node 22+', () => {
    expect(classifyManagedSshBootstrapError(
      'Managed SSH remote requires Node.js 22+; no supported Node runtime was found on the remote host',
    )).toBe('nodeRuntimeMissing');
  });

  test('classifies missing package manager', () => {
    expect(classifyManagedSshBootstrapError('Remote host has neither bun nor npm available')).toBe('packageManagerMissing');
  });

  test('classifies native binding / node-gyp failures', () => {
    expect(classifyManagedSshBootstrapError('failed to prepare better-sqlite3 for Node 23.11.1')).toBe('nativeBinding');
    expect(classifyManagedSshBootstrapError('gyp ERR! UNCAUGHT EXCEPTION\nENOENT: .../build/node_gyp_bins')).toBe('nativeBinding');
  });

  test('classifies install and SSH transport failures', () => {
    expect(classifyManagedSshBootstrapError(
      'OpenChamber installation completed but the executable is unavailable',
    )).toBe('openchamberCliMissing');
    expect(classifyManagedSshBootstrapError(
      'npm ERR! code ETIMEDOUT\nnpm ERR! network request to https://registry.npmjs.org/@openchambery%2fweb failed',
    )).toBe('openchamberRegistry');
    expect(classifyManagedSshBootstrapError('Failed to install OpenChamber on remote host')).toBe('openchamberInstall');
    expect(classifyManagedSshBootstrapError('Error: Unknown option: --relay-host')).toBe('openchamberCliIncompatible');
    expect(classifyManagedSshBootstrapError('Failed to install OpenCode CLI on remote host')).toBe('opencodeInstall');
    expect(classifyManagedSshBootstrapError('Managed OpenChamber server failed to become reachable')).toBe('serverStart');
    expect(classifyManagedSshBootstrapError('Permission denied (publickey)')).toBe('sshAuth');
    expect(classifyManagedSshBootstrapError('ssh: Could not resolve hostname host:36000')).toBe('sshUnreachable');
    expect(classifyManagedSshBootstrapError('Timed out waiting for SSH connection')).toBe('timeout');
    expect(classifyManagedSshBootstrapError('something else')).toBe('unknown');
  });

  test('prefers an explicit status code over reclassifying detail', () => {
    expect(resolveManagedSshBootstrapErrorCode('nativeBinding', 'Permission denied')).toBe('nativeBinding');
    expect(resolveManagedSshBootstrapErrorCode('nope', 'Permission denied (publickey)')).toBe('sshAuth');
    expect(isManagedSshBootstrapErrorCode('nativeBinding')).toBe(true);
    expect(isManagedSshBootstrapErrorCode('nope')).toBe(false);
  });

  test('maps every code to title and guidance keys', () => {
    expect(sshBootstrapErrorTitleKey('nativeBinding')).toBe('desktopHostSwitcher.sshError.nativeBinding.title');
    expect(sshBootstrapErrorGuidanceKey('nativeBinding')).toBe('desktopHostSwitcher.sshError.nativeBinding.guidance');
    expect(sshBootstrapErrorTitleKey('openchamberCliMissing')).toBe('desktopHostSwitcher.sshError.openchamberCliMissing.title');
    expect(sshBootstrapErrorGuidanceKey('openchamberCliMissing')).toBe('desktopHostSwitcher.sshError.openchamberCliMissing.guidance');
    expect(sshBootstrapErrorTitleKey('openchamberRegistry')).toBe('desktopHostSwitcher.sshError.openchamberRegistry.title');
    expect(sshBootstrapErrorGuidanceKey('openchamberRegistry')).toBe('desktopHostSwitcher.sshError.openchamberRegistry.guidance');
    expect(sshBootstrapErrorTitleKey('unknown')).toBe('desktopHostSwitcher.sshError.unknown.title');
    expect(sshBootstrapErrorTitleKey('openchamberCliIncompatible')).toBe(
      'desktopHostSwitcher.sshError.openchamberCliIncompatible.title',
    );
  });

  test('appends raw detail for unknown and incompatible errors', () => {
    expect(formatSshBootstrapErrorDescription('guidance', 'unknown', 'Error: Unknown option: --relay-host')).toBe(
      'guidance\nError: Unknown option: --relay-host',
    );
    expect(formatSshBootstrapErrorDescription('guidance', 'nativeBinding', 'gyp ERR')).toBe('guidance');
  });
});
