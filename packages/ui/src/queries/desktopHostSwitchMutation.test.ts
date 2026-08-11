import { afterEach, describe, expect, mock, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';

// Controllable impls + manual call tracking (project bun-test.d.ts does not
// declare mock matcher / mockClear types; existing tests use plain arrays).
type SwitchDesktopHostResult =
  | { ok: true; via: 'direct' | 'relay'; status: { status: 'ok'; latencyMs: number } | { status: 'ok'; latencyMs: number; via?: string } }
  | { ok: false; status: { status: 'unreachable'; latencyMs: number }; reason: 'unreachable' | 'unsupported' };

let switchDesktopHostImpl: (...args: unknown[]) => Promise<SwitchDesktopHostResult> = async () => ({
  ok: true,
  via: 'direct',
  status: { status: 'ok', latencyMs: 8 },
});
let switchRuntimeEndpointImpl: (...args: unknown[]) => void = () => undefined;
let isDesktopHostActiveImpl: () => boolean = () => false;
let toastErrorImpl: (...args: unknown[]) => void = () => undefined;

const switchDesktopHostCalls: unknown[][] = [];
const switchRuntimeEndpointCalls: unknown[][] = [];
const toastErrorCalls: unknown[][] = [];

const queryClient = new QueryClient();

mock.module('@/lib/desktopHostSwitch', () => ({
  isDesktopHostActive: () => isDesktopHostActiveImpl(),
  runtimeKeyForDesktopHost: (host: { id: string }) => (host.id === 'local' ? 'local' : `host:${host.id}`),
  switchDesktopHost: (...args: unknown[]) => {
    switchDesktopHostCalls.push(args);
    return switchDesktopHostImpl(...args);
  },
}));

mock.module('@/lib/desktopHosts', () => ({
  redactSensitiveUrl: (value: string) => value,
}));

mock.module('@/lib/runtime-switch', () => ({
  switchRuntimeEndpoint: (...args: unknown[]) => {
    switchRuntimeEndpointCalls.push(args);
    return switchRuntimeEndpointImpl(...args);
  },
}));

mock.module('@/lib/queryRuntime', () => ({
  queryClient,
}));

mock.module('@/components/ui', () => ({
  toast: {
    error: (...args: unknown[]) => {
      toastErrorCalls.push(args);
      return toastErrorImpl(...args);
    },
    success: () => undefined,
  },
}));

mock.module('@/lib/i18n', () => ({
  formatMessage: (_dict: unknown, key: string, params?: Record<string, unknown>) => {
    if (params?.host) return `${key}:${params.host}`;
    return key;
  },
  useI18nStore: {
    getState: () => ({ dictionary: {} }),
  },
}));

const {
  DESKTOP_HOST_SWITCH_MUTATION_KEY,
  DesktopHostSwitchError,
  isDesktopHostSwitchPending,
  resetDesktopHostSwitchMutationForTests,
  switchDesktopHostInstance,
} = await import('./desktopHostSwitchMutation');

const host = {
  id: 'host-a',
  label: 'Office',
  url: 'http://192.168.1.10:4096',
  apiUrl: 'http://192.168.1.10:4096',
  clientToken: 'token-a',
};

afterEach(() => {
  resetDesktopHostSwitchMutationForTests();
  switchDesktopHostCalls.length = 0;
  switchRuntimeEndpointCalls.length = 0;
  toastErrorCalls.length = 0;
  switchDesktopHostImpl = async () => ({
    ok: true,
    via: 'direct',
    status: { status: 'ok', latencyMs: 8 },
  });
  switchRuntimeEndpointImpl = () => undefined;
  isDesktopHostActiveImpl = () => false;
  toastErrorImpl = () => undefined;
});

describe('desktopHostSwitchMutation', () => {
  test('exposes a stable mutation key for the global pending lane', () => {
    expect(DESKTOP_HOST_SWITCH_MUTATION_KEY).toEqual(['desktopHostSwitch']);
  });

  test('switchDesktopHostInstance is a no-op success when already active', async () => {
    isDesktopHostActiveImpl = () => true;
    const result = await switchDesktopHostInstance({ host });
    expect(result.ok).toBe(true);
    expect(switchDesktopHostCalls).toEqual([]);
    expect(isDesktopHostSwitchPending()).toBe(false);
  });

  test('switchDesktopHostInstance runs remote switch through shared mutation', async () => {
    const result = await switchDesktopHostInstance({
      host,
      cachedProbe: { status: 'ok', latencyMs: 4 },
    });
    expect(result).toEqual({
      ok: true,
      via: 'direct',
      status: { status: 'ok', latencyMs: 8 },
    });
    expect(switchDesktopHostCalls).toEqual([[host, {
      cachedProbe: { status: 'ok', latencyMs: 4 },
    }]]);
  });

  test('switchDesktopHostInstance switches local via runtime endpoint', async () => {
    const local = { id: 'local', label: 'Local', url: 'http://127.0.0.1:4096' };
    const result = await switchDesktopHostInstance({
      host: local,
      localApiOrigin: 'http://127.0.0.1:4096',
      localClientToken: 'local-token',
    });
    expect(result.ok).toBe(true);
    expect(switchRuntimeEndpointCalls).toEqual([[{
      apiBaseUrl: 'http://127.0.0.1:4096',
      clientToken: 'local-token',
      runtimeKey: 'local',
    }]]);
    expect(switchDesktopHostCalls).toEqual([]);
  });

  test('unreachable remote surfaces toast via mutation onError and returns result', async () => {
    switchDesktopHostImpl = async () => ({
      ok: false,
      status: { status: 'unreachable', latencyMs: 0 },
      reason: 'unreachable',
    });
    const result = await switchDesktopHostInstance({ host });
    expect(result.ok).toBe(false);
    expect(toastErrorCalls.length).toBeGreaterThan(0);
  });

  test('concurrent second switch is rejected while first is pending', async () => {
    let resolveSwitch: ((value: SwitchDesktopHostResult) => void) = () => undefined;
    switchDesktopHostImpl = () => new Promise<SwitchDesktopHostResult>((resolve) => {
      resolveSwitch = resolve;
    });

    const first = switchDesktopHostInstance({ host });
    // Yield so the mutation enters pending.
    await Promise.resolve();
    await Promise.resolve();

    expect(isDesktopHostSwitchPending()).toBe(true);
    const second = await switchDesktopHostInstance({
      host: { ...host, id: 'host-b', label: 'Other' },
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('unsupported');

    resolveSwitch({
      ok: true,
      via: 'direct',
      status: { status: 'ok', latencyMs: 1 },
    });
    await first;
  });

  test('DesktopHostSwitchError carries host + result', () => {
    const error = new DesktopHostSwitchError(
      { ok: false, status: { status: 'unreachable', latencyMs: 0 }, reason: 'unreachable' },
      host,
    );
    expect(error.host.id).toBe('host-a');
    expect(error.result.reason).toBe('unreachable');
  });
});
