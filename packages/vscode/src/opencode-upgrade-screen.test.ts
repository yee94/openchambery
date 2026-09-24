import { describe, expect, test, vi } from 'vitest';
import { compatibilityFromDebugInfo, installManagedRequiredOpenCode } from './opencode-upgrade-screen';

describe('VS Code upgrade screen adapter', () => {
  test('does not offer install for an external server and does gate a managed 2.0.14', () => {
    expect(compatibilityFromDebugInfo({ mode: 'external', version: '2.0.12' }, { platformCanInstall: true })).toMatchObject({
      state: 'incompatible',
      canInstall: false,
      installation: 'external',
    });
    expect(compatibilityFromDebugInfo({ mode: 'managed', version: '2.0.15' }, { platformCanInstall: true }).state).toBe('compatible');
    expect(compatibilityFromDebugInfo({
      mode: 'managed',
      version: null,
      cliPath: '/old/opencode',
    }, {
      platformCanInstall: true,
      readBinaryVersion: () => '1.18.30',
    })).toMatchObject({ state: 'incompatible', canInstall: true, version: '1.18.30' });
  });

  test('surfaces the install error and does not report upgraded', async () => {
    const manager = {
      getDebugInfo: () => ({ mode: 'managed', version: '2.0.14', cliPath: '/old/opencode' }),
      restart: vi.fn(),
    };
    await expect(installManagedRequiredOpenCode(manager as never, {
      platformCanInstall: true,
      persistBinary: vi.fn(async () => undefined),
      readBinaryVersion: () => '2.0.14',
      install: vi.fn(async () => {
        throw new Error('disk full');
      }),
    })).rejects.toThrow('disk full');
    expect(manager.restart).not.toHaveBeenCalled();
  });
});
