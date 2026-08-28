import { beforeEach, describe, expect, mock, test } from 'bun:test';

// Relay hot-switch gate: only a definitive usable direct probe ('ok' /
// 'update-recommended') may replace a working relay transport. A probe 'auth'
// (reachable but token rejected) previously passed the blocked-status check
// and hot-switched the desktop off a healthy E2EE relay onto a direct leg
// that 401s every runtime request.

let activeRuntimeKey = 'host:host-1';
let probeStatus: 'ok' | 'auth' | 'update-recommended' | 'incompatible' | 'wrong-service' | 'unreachable' = 'ok';
const switches: Array<Record<string, unknown>> = [];
let persistedHosts: Array<Record<string, unknown>> = [];

mock.module('@/lib/desktop', () => ({
  isElectronShell: () => true,
}));

const passthroughUrl = (raw: unknown): string | null =>
  typeof raw === 'string' && raw.trim() ? raw.trim() : null;

mock.module('@/lib/desktopHosts', () => ({
  desktopHostProbe: async () => ({ status: probeStatus, latencyMs: 5 }),
  desktopHostsGet: async () => ({
    hosts: persistedHosts,
    defaultHostId: 'host-1',
    initialHostChoiceCompleted: true,
    localOrigin: 'http://127.0.0.1:57123',
  }),
  desktopHostsSet: async (config: { hosts: Array<Record<string, unknown>> }) => {
    persistedHosts = config.hosts;
  },
  getDesktopHostApiUrl: (host: { apiUrl?: string }) => host.apiUrl ?? '',
  normalizeHostUrl: passthroughUrl,
}));

mock.module('@/lib/desktopHostSwitch', () => ({
  runtimeKeyForDesktopHost: (host: { id: string }) => (host.id === 'local' ? 'local' : `host:${host.id}`),
}));

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: async () => ({
    ok: true,
    json: async () => ({
      serverId: 'srv-1',
      candidates: [{ type: 'lan', url: 'http://192.168.1.50:57123' }],
    }),
  }),
}));

mock.module('@/lib/runtime-switch', () => ({
  getRuntimeKey: () => activeRuntimeKey,
  switchRuntimeEndpoint: (options: Record<string, unknown>) => {
    switches.push(options);
  },
}));

const { refreshDesktopHostCandidates } = await import('./desktopRelayRestore');

const relayHost = {
  id: 'host-1',
  label: 'Remote desktop',
  url: 'http://192.168.1.50:57123',
  apiUrl: 'http://192.168.1.50:57123',
  relay: {
    relayUrl: 'wss://relay.example/ws',
    serverId: 'srv-1',
    hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'axfR8uEsQv8FJfV6gYwVgyNMLawKaV7Rbm6V7RkF7yA', y: 'T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU' },
  },
};

describe('refreshDesktopHostCandidates relay→direct hot-switch gate', () => {
  beforeEach(() => {
    activeRuntimeKey = 'host:host-1';
    switches.length = 0;
    persistedHosts = [{ ...relayHost, relay: { ...relayHost.relay } }];
  });

  test('keeps the relay when the direct probe answers auth (token rejected)', async () => {
    probeStatus = 'auth';
    await refreshDesktopHostCandidates('host-1');
    expect(switches).toEqual([]);
  });

  test('keeps the relay on blocked probe statuses', async () => {
    for (const status of ['unreachable', 'wrong-service', 'incompatible'] as const) {
      probeStatus = status;
      await refreshDesktopHostCandidates('host-1');
    }
    expect(switches).toEqual([]);
  });

  test('adopts direct on a usable probe without carrying the relay descriptor', async () => {
    probeStatus = 'ok';
    await refreshDesktopHostCandidates('host-1');
    expect(switches).toHaveLength(1);
    expect(switches[0].apiBaseUrl).toBe('http://192.168.1.50:57123');
    expect(switches[0].runtimeKey).toBe('host:host-1');
    expect(switches[0].relay).toBeUndefined();
  });

  test('update-recommended is still a usable direct transport', async () => {
    probeStatus = 'update-recommended';
    await refreshDesktopHostCandidates('host-1');
    expect(switches).toHaveLength(1);
  });
});
