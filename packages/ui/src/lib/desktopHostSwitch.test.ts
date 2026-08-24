import { afterEach, describe, expect, mock, test } from 'bun:test';

// Controllable impls + manual call tracking (project bun-test.d.ts does not
// declare mock matcher / mockClear types; existing tests use plain arrays).
let desktopHostProbeImpl: (...args: unknown[]) => Promise<{ status: 'ok' | 'unreachable'; latencyMs: number }> =
  async () => ({ status: 'ok', latencyMs: 12 });
let probeRelayDesktopHostImpl: (...args: unknown[]) => Promise<{ status: 'ok' | 'unreachable'; latencyMs: number }> =
  async () => ({ status: 'ok', latencyMs: 30 });
let switchRuntimeEndpointImpl: (...args: unknown[]) => void = () => undefined;
let scheduleDesktopHostCandidateRefreshImpl: (...args: unknown[]) => void = () => undefined;
let adoptRelayTunnelImpl: (...args: unknown[]) => void = () => undefined;
let isElectronShellImpl: () => boolean = () => true;
let getRuntimeKeyImpl: () => string = () => 'local';

const desktopHostProbeCalls: unknown[][] = [];
const probeRelayDesktopHostCalls: unknown[][] = [];
const switchRuntimeEndpointCalls: unknown[][] = [];
const scheduleDesktopHostCandidateRefreshCalls: unknown[][] = [];
const adoptRelayTunnelCalls: unknown[][] = [];

mock.module('@/lib/desktop', () => ({
  isElectronShell: () => isElectronShellImpl(),
}));

mock.module('@/lib/desktopHosts', () => ({
  desktopHostProbe: (...args: unknown[]) => {
    desktopHostProbeCalls.push(args);
    return desktopHostProbeImpl(...args);
  },
  getDesktopHostApiUrl: (host: { apiUrl?: string; url: string }) => host.apiUrl || host.url,
  normalizeHostUrl: (raw: string) => {
    try {
      const url = new URL(raw);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
      return raw.split('#')[0] || null;
    } catch {
      return null;
    }
  },
  probeRelayDesktopHost: (...args: unknown[]) => {
    probeRelayDesktopHostCalls.push(args);
    return probeRelayDesktopHostImpl(...args);
  },
}));

mock.module('@/lib/desktopRelayRestore', () => ({
  scheduleDesktopHostCandidateRefresh: (...args: unknown[]) => {
    scheduleDesktopHostCandidateRefreshCalls.push(args);
    return scheduleDesktopHostCandidateRefreshImpl(...args);
  },
}));

mock.module('@/lib/relay/runtime-tunnel', () => ({
  adoptRelayTunnel: (...args: unknown[]) => {
    adoptRelayTunnelCalls.push(args);
    return adoptRelayTunnelImpl(...args);
  },
  getActiveRelayDescriptor: () => null,
}));

mock.module('@/lib/relay/tunnel-client', () => ({
  createRelayTunnelClient: () => ({ close: () => undefined }),
}));

mock.module('@/lib/runtime-switch', () => ({
  getRuntimeKey: () => getRuntimeKeyImpl(),
  switchRuntimeEndpoint: (...args: unknown[]) => {
    switchRuntimeEndpointCalls.push(args);
    return switchRuntimeEndpointImpl(...args);
  },
}));

const { isDesktopHostActive, runtimeKeyForDesktopHost, switchDesktopHost } = await import('./desktopHostSwitch');

const directHost = {
  id: 'host-a',
  label: 'Office',
  url: 'http://192.168.1.10:4096',
  apiUrl: 'http://192.168.1.10:4096',
  clientToken: 'token-a',
};

const relayHost = {
  id: 'host-b',
  label: 'Travel',
  url: 'relay://server-b',
  clientToken: 'token-b',
  relay: {
    relayUrl: 'wss://relay.example/ws',
    serverId: 'server-b',
    hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
  },
};

afterEach(() => {
  desktopHostProbeCalls.length = 0;
  probeRelayDesktopHostCalls.length = 0;
  switchRuntimeEndpointCalls.length = 0;
  scheduleDesktopHostCandidateRefreshCalls.length = 0;
  adoptRelayTunnelCalls.length = 0;
  desktopHostProbeImpl = async () => ({ status: 'ok', latencyMs: 12 });
  probeRelayDesktopHostImpl = async () => ({ status: 'ok', latencyMs: 30 });
  switchRuntimeEndpointImpl = () => undefined;
  scheduleDesktopHostCandidateRefreshImpl = () => undefined;
  adoptRelayTunnelImpl = () => undefined;
  isElectronShellImpl = () => true;
  getRuntimeKeyImpl = () => 'local';
});

describe('desktopHostSwitch', () => {
  test('runtimeKeyForDesktopHost matches host switcher convention', () => {
    expect(runtimeKeyForDesktopHost({ id: 'local', label: 'Local', url: 'http://127.0.0.1' })).toBe('local');
    expect(runtimeKeyForDesktopHost(directHost)).toBe('host:host-a');
  });

  test('isDesktopHostActive uses runtime key', () => {
    getRuntimeKeyImpl = () => 'host:host-a';
    expect(isDesktopHostActive(directHost)).toBe(true);
    expect(isDesktopHostActive(relayHost)).toBe(false);
  });

  test('switchDesktopHost returns unsupported outside Electron', async () => {
    isElectronShellImpl = () => false;
    const result = await switchDesktopHost(directHost);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unsupported');
    expect(switchRuntimeEndpointCalls).toEqual([]);
  });

  test('switchDesktopHost uses cached direct probe without re-probing', async () => {
    const result = await switchDesktopHost(directHost, {
      cachedProbe: { status: 'ok', latencyMs: 9 },
    });
    expect(result).toEqual({
      ok: true,
      via: 'direct',
      status: { status: 'ok', latencyMs: 9 },
    });
    expect(desktopHostProbeCalls).toEqual([]);
    expect(switchRuntimeEndpointCalls).toEqual([[{
      apiBaseUrl: 'http://192.168.1.10:4096',
      clientToken: 'token-a',
      requestHeaders: null,
      runtimeKey: 'host:host-a',
    }]]);
  });

  test('switchDesktopHost falls back to relay when direct is blocked', async () => {
    desktopHostProbeImpl = async () => ({ status: 'unreachable', latencyMs: 0 });
    probeRelayDesktopHostImpl = async () => ({ status: 'ok', latencyMs: 40 });

    const multi = {
      ...directHost,
      id: 'host-multi',
      relay: relayHost.relay,
    };
    const result = await switchDesktopHost(multi);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.via).toBe('relay');
      expect(result.status.via).toBe('relay');
    }
    expect(switchRuntimeEndpointCalls).toHaveLength(1);
    const switchArgs = switchRuntimeEndpointCalls[0]?.[0] as Record<string, unknown> | undefined;
    expect(switchArgs?.runtimeKey).toBe('host:host-multi');
    expect(switchArgs?.relay).toEqual(multi.relay);
    expect(switchArgs?.clientToken).toBe('token-a');
    expect(scheduleDesktopHostCandidateRefreshCalls).toEqual([['host-multi']]);
  });

  test('switchDesktopHost reports unreachable when every transport fails', async () => {
    desktopHostProbeImpl = async () => ({ status: 'unreachable', latencyMs: 0 });
    probeRelayDesktopHostImpl = async () => ({ status: 'unreachable', latencyMs: 0 });

    const multi = {
      ...directHost,
      id: 'host-down',
      relay: relayHost.relay,
    };
    const result = await switchDesktopHost(multi);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unreachable');
    expect(switchRuntimeEndpointCalls).toEqual([]);
  });
});
