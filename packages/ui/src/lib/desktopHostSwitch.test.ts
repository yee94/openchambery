import { afterEach, describe, expect, mock, test } from 'bun:test';

const desktopHostProbe = mock(async () => ({ status: 'ok' as const, latencyMs: 12 }));
const probeRelayDesktopHost = mock(async () => ({ status: 'ok' as const, latencyMs: 30 }));
const switchRuntimeEndpoint = mock(() => undefined);
const scheduleDesktopHostCandidateRefresh = mock(() => undefined);
const adoptRelayTunnel = mock(() => undefined);
const isElectronShell = mock(() => true);
const getRuntimeKey = mock(() => 'local');

mock.module('@/lib/desktop', () => ({
  isElectronShell: () => isElectronShell(),
}));

mock.module('@/lib/desktopHosts', () => ({
  desktopHostProbe: (...args: unknown[]) => desktopHostProbe(...args),
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
  probeRelayDesktopHost: (...args: unknown[]) => probeRelayDesktopHost(...args),
}));

mock.module('@/lib/desktopRelayRestore', () => ({
  scheduleDesktopHostCandidateRefresh: (...args: unknown[]) => scheduleDesktopHostCandidateRefresh(...args),
}));

mock.module('@/lib/relay/runtime-tunnel', () => ({
  adoptRelayTunnel: (...args: unknown[]) => adoptRelayTunnel(...args),
}));

mock.module('@/lib/relay/tunnel-client', () => ({
  createRelayTunnelClient: () => ({ close: () => undefined }),
}));

mock.module('@/lib/runtime-switch', () => ({
  getRuntimeKey: () => getRuntimeKey(),
  switchRuntimeEndpoint: (...args: unknown[]) => switchRuntimeEndpoint(...args),
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
  desktopHostProbe.mockClear();
  probeRelayDesktopHost.mockClear();
  switchRuntimeEndpoint.mockClear();
  scheduleDesktopHostCandidateRefresh.mockClear();
  adoptRelayTunnel.mockClear();
  isElectronShell.mockReset();
  isElectronShell.mockImplementation(() => true);
  getRuntimeKey.mockReset();
  getRuntimeKey.mockImplementation(() => 'local');
});

describe('desktopHostSwitch', () => {
  test('runtimeKeyForDesktopHost matches host switcher convention', () => {
    expect(runtimeKeyForDesktopHost({ id: 'local', label: 'Local', url: 'http://127.0.0.1' })).toBe('local');
    expect(runtimeKeyForDesktopHost(directHost)).toBe('host:host-a');
  });

  test('isDesktopHostActive uses runtime key', () => {
    getRuntimeKey.mockImplementation(() => 'host:host-a');
    expect(isDesktopHostActive(directHost)).toBe(true);
    expect(isDesktopHostActive(relayHost)).toBe(false);
  });

  test('switchDesktopHost returns unsupported outside Electron', async () => {
    isElectronShell.mockImplementation(() => false);
    const result = await switchDesktopHost(directHost);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unsupported');
    expect(switchRuntimeEndpoint).not.toHaveBeenCalled();
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
    expect(desktopHostProbe).not.toHaveBeenCalled();
    expect(switchRuntimeEndpoint).toHaveBeenCalledWith({
      apiBaseUrl: 'http://192.168.1.10:4096',
      clientToken: 'token-a',
      requestHeaders: null,
      runtimeKey: 'host:host-a',
    });
  });

  test('switchDesktopHost falls back to relay when direct is blocked', async () => {
    desktopHostProbe.mockImplementation(async () => ({ status: 'unreachable' as const, latencyMs: 0 }));
    probeRelayDesktopHost.mockImplementation(async () => ({ status: 'ok' as const, latencyMs: 40 }));

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
    expect(switchRuntimeEndpoint).toHaveBeenCalledWith(expect.objectContaining({
      runtimeKey: 'host:host-multi',
      relay: multi.relay,
      clientToken: 'token-a',
    }));
    expect(scheduleDesktopHostCandidateRefresh).toHaveBeenCalledWith('host-multi');
  });

  test('switchDesktopHost reports unreachable when every transport fails', async () => {
    desktopHostProbe.mockImplementation(async () => ({ status: 'unreachable' as const, latencyMs: 0 }));
    probeRelayDesktopHost.mockImplementation(async () => ({ status: 'unreachable' as const, latencyMs: 0 }));

    const multi = {
      ...directHost,
      id: 'host-down',
      relay: relayHost.relay,
    };
    const result = await switchDesktopHost(multi);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unreachable');
    expect(switchRuntimeEndpoint).not.toHaveBeenCalled();
  });
});
