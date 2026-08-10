import { afterEach, describe, expect, mock, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';

const switchDesktopHost = mock(async () => ({
  ok: true as const,
  via: 'direct' as const,
  status: { status: 'ok' as const, latencyMs: 8 },
}));
const switchRuntimeEndpoint = mock(() => undefined);
const isDesktopHostActive = mock(() => false);
const toastError = mock(() => undefined);

const queryClient = new QueryClient();

mock.module('@/lib/desktopHostSwitch', () => ({
  isDesktopHostActive: () => isDesktopHostActive(),
  runtimeKeyForDesktopHost: (host: { id: string }) => (host.id === 'local' ? 'local' : `host:${host.id}`),
  switchDesktopHost: (...args: unknown[]) => switchDesktopHost(...args as [never]),
}));

mock.module('@/lib/desktopHosts', () => ({
  redactSensitiveUrl: (value: string) => value,
}));

mock.module('@/lib/runtime-switch', () => ({
  switchRuntimeEndpoint: (...args: unknown[]) => switchRuntimeEndpoint(...args as [never]),
}));

mock.module('@/lib/queryRuntime', () => ({
  queryClient,
}));

mock.module('@/components/ui', () => ({
  toast: { error: (...args: unknown[]) => toastError(...args as [never]), success: () => undefined },
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
  switchDesktopHost.mockClear();
  switchRuntimeEndpoint.mockClear();
  isDesktopHostActive.mockReset();
  isDesktopHostActive.mockImplementation(() => false);
  toastError.mockClear();
});

describe('desktopHostSwitchMutation', () => {
  test('exposes a stable mutation key for the global pending lane', () => {
    expect(DESKTOP_HOST_SWITCH_MUTATION_KEY).toEqual(['desktopHostSwitch']);
  });

  test('switchDesktopHostInstance is a no-op success when already active', async () => {
    isDesktopHostActive.mockImplementation(() => true);
    const result = await switchDesktopHostInstance({ host });
    expect(result.ok).toBe(true);
    expect(switchDesktopHost).not.toHaveBeenCalled();
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
    expect(switchDesktopHost).toHaveBeenCalledWith(host, {
      cachedProbe: { status: 'ok', latencyMs: 4 },
    });
  });

  test('switchDesktopHostInstance switches local via runtime endpoint', async () => {
    const local = { id: 'local', label: 'Local', url: 'http://127.0.0.1:4096' };
    const result = await switchDesktopHostInstance({
      host: local,
      localApiOrigin: 'http://127.0.0.1:4096',
      localClientToken: 'local-token',
    });
    expect(result.ok).toBe(true);
    expect(switchRuntimeEndpoint).toHaveBeenCalledWith({
      apiBaseUrl: 'http://127.0.0.1:4096',
      clientToken: 'local-token',
      runtimeKey: 'local',
    });
    expect(switchDesktopHost).not.toHaveBeenCalled();
  });

  test('unreachable remote surfaces toast via mutation onError and returns result', async () => {
    switchDesktopHost.mockImplementation(async () => ({
      ok: false as const,
      status: { status: 'unreachable' as const, latencyMs: 0 },
      reason: 'unreachable' as const,
    }));
    const result = await switchDesktopHostInstance({ host });
    expect(result.ok).toBe(false);
    expect(toastError).toHaveBeenCalled();
  });

  test('concurrent second switch is rejected while first is pending', async () => {
    let resolveSwitch: ((value: unknown) => void) | null = null;
    switchDesktopHost.mockImplementation(() => new Promise((resolve) => {
      resolveSwitch = resolve;
    }));

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

    resolveSwitch?.({
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
