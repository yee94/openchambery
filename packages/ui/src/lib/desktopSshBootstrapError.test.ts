import { describe, expect, test } from 'vitest';
import {
  classifyManagedSshBootstrapError,
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
    expect(classifyManagedSshBootstrapError('Failed to install OpenChamber on remote host')).toBe('openchamberInstall');
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
    expect(sshBootstrapErrorTitleKey('unknown')).toBe('desktopHostSwitcher.sshError.unknown.title');
  });
});
