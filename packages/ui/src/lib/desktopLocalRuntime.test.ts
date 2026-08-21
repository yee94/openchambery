import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  isElectronShell: false,
  runtimeKey: 'local',
  localClientToken: Promise.resolve('token-abc') as Promise<string>,
  switchCalls: [] as Array<{
    host: { id: string; label: string; url: string };
    localApiOrigin?: string | null;
    localClientToken?: string | null;
  }>,
  switchResult: {
    ok: true as const,
    via: 'direct' as const,
    status: { status: 'ok' as const, latencyMs: 0 },
  } as
    | { ok: true; via: 'direct'; status: { status: 'ok'; latencyMs: number } }
    | { ok: false; status: { status: 'unreachable'; latencyMs: number }; reason: 'unreachable' | 'unsupported' },
}));

vi.mock('@/lib/desktop', () => ({
  isElectronShell: () => mocks.isElectronShell,
}));

vi.mock('@/lib/runtime-switch', () => ({
  getRuntimeKey: () => mocks.runtimeKey,
}));

vi.mock('@/lib/desktopHosts', () => ({
  desktopLocalClientTokenGet: () => mocks.localClientToken,
}));

vi.mock('@/queries/desktopHostSwitchMutation', () => ({
  switchDesktopHostInstance: async (variables: {
    host: { id: string; label: string; url: string };
    localApiOrigin?: string | null;
    localClientToken?: string | null;
  }) => {
    mocks.switchCalls.push(variables);
    return mocks.switchResult;
  },
}));

import {
  getLocalRuntimeOrigin,
  isLocalRuntimeActive,
  switchToLocalDesktopRuntime,
} from './desktopLocalRuntime';

describe('desktopLocalRuntime', () => {
  beforeEach(() => {
    mocks.isElectronShell = false;
    mocks.runtimeKey = 'local';
    mocks.localClientToken = Promise.resolve('token-abc');
    mocks.switchCalls.length = 0;
    mocks.switchResult = { ok: true, via: 'direct', status: { status: 'ok', latencyMs: 0 } };
    window.__OPENCHAMBER_LOCAL_ORIGIN__ = 'http://127.0.0.1:4096';
  });

  afterEach(() => {
    delete window.__OPENCHAMBER_LOCAL_ORIGIN__;
  });

  test('getLocalRuntimeOrigin prefers injected local origin', () => {
    expect(getLocalRuntimeOrigin()).toBe('http://127.0.0.1:4096');
  });

  test('non-Electron: isLocalRuntimeActive is true and switch is a no-op', async () => {
    mocks.isElectronShell = false;
    mocks.runtimeKey = 'host:remote';
    expect(isLocalRuntimeActive()).toBe(true);
    const result = await switchToLocalDesktopRuntime();
    expect(result).toEqual({ ok: true });
    expect(mocks.switchCalls).toEqual([]);
  });

  test('Electron + local: switch is a no-op', async () => {
    mocks.isElectronShell = true;
    mocks.runtimeKey = 'local';
    expect(isLocalRuntimeActive()).toBe(true);
    const result = await switchToLocalDesktopRuntime();
    expect(result).toEqual({ ok: true });
    expect(mocks.switchCalls).toEqual([]);
  });

  test('Electron + non-local: calls switchDesktopHostInstance with origin and token', async () => {
    mocks.isElectronShell = true;
    mocks.runtimeKey = 'host:ssh-1';
    const result = await switchToLocalDesktopRuntime();
    expect(result).toEqual({ ok: true });
    expect(mocks.switchCalls).toEqual([
      {
        host: { id: 'local', label: 'Local', url: 'http://127.0.0.1:4096' },
        localApiOrigin: 'http://127.0.0.1:4096',
        localClientToken: 'token-abc',
      },
    ]);
  });

  test('Electron + non-local: token failure falls back to empty string', async () => {
    mocks.isElectronShell = true;
    mocks.runtimeKey = 'host:ssh-1';
    mocks.localClientToken = Promise.reject(new Error('ipc failed'));
    const result = await switchToLocalDesktopRuntime();
    expect(result).toEqual({ ok: true });
    expect(mocks.switchCalls).toHaveLength(1);
    expect(mocks.switchCalls[0]?.localClientToken).toBe('');
  });

  test('Electron + non-local: propagates switch failure reason', async () => {
    mocks.isElectronShell = true;
    mocks.runtimeKey = 'host:ssh-1';
    mocks.switchResult = {
      ok: false,
      status: { status: 'unreachable', latencyMs: 0 },
      reason: 'unreachable',
    };
    const result = await switchToLocalDesktopRuntime();
    expect(result).toEqual({ ok: false, reason: 'unreachable' });
  });
});
