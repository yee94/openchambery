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
let requestSshHostTokenImpl: (...args: unknown[]) => Promise<{ token: string; localPort: number | null; reachable: boolean }> =
  async () => ({ token: 'ssh-token', localPort: 18765, reachable: true });
let getActiveRelayDescriptorImpl: () => unknown = () => null;

const desktopHostProbeCalls: unknown[][] = [];
const probeRelayDesktopHostCalls: unknown[][] = [];
const switchRuntimeEndpointCalls: unknown[][] = [];
const scheduleDesktopHostCandidateRefreshCalls: unknown[][] = [];
const adoptRelayTunnelCalls: unknown[][] = [];
const requestSshHostTokenCalls: unknown[][] = [];

mock.module('@/lib/desktop', () => ({
  isElectronShell: () => isElectronShellImpl(),
}));

mock.module('@/lib/desktopHosts', () => ({
  desktopHostProbe: (...args: unknown[]) => {
    desktopHostProbeCalls.push(args);
    return desktopHostProbeImpl(...args);
  },
  requestSshHostToken: (...args: unknown[]) => {
    requestSshHostTokenCalls.push(args);
    return requestSshHostTokenImpl(...args);
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
  getActiveRelayDescriptor: () => getActiveRelayDescriptorImpl(),
}));

mock.module('@/lib/relay/tunnel-client', () => ({
  createRelayTunnelClient: () => ({ close: () => undefined }),
}));

mock.module('@/lib/runtime-switch', () => ({
  OPENCHAMBER_TARGET_PORT_HEADER: 'x-openchamber-target-port',
  getRuntimeKey: () => getRuntimeKeyImpl(),
  switchRuntimeEndpoint: (...args: unknown[]) => {
    switchRuntimeEndpointCalls.push(args);
    return switchRuntimeEndpointImpl(...args);
  },
}));

const { isDesktopHostActive, runtimeKeyForDesktopHost, switchDesktopHost, switchViaSshRelay } = await import('./desktopHostSwitch');

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
  requestSshHostTokenCalls.length = 0;
  desktopHostProbeImpl = async () => ({ status: 'ok', latencyMs: 12 });
  probeRelayDesktopHostImpl = async () => ({ status: 'ok', latencyMs: 30 });
  switchRuntimeEndpointImpl = () => undefined;
  scheduleDesktopHostCandidateRefreshImpl = () => undefined;
  adoptRelayTunnelImpl = () => undefined;
  isElectronShellImpl = () => true;
  getRuntimeKeyImpl = () => 'local';
  requestSshHostTokenImpl = async () => ({ token: 'ssh-token', localPort: 18765, reachable: true });
  getActiveRelayDescriptorImpl = () => null;
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

  test('switchViaSshRelay keeps relay transport and sets target-port header', async () => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { location: { origin: 'https://app.example' } },
    });
    getActiveRelayDescriptorImpl = () => relayHost.relay;
    const sshHost = {
      id: 'ssh-remote',
      label: 'SSH Box',
      url: '',
      viaSshRelay: { localPort: 18765 },
      clientToken: 'ssh-token',
    };
    try {
      // Pre-resolved port + token skips mint when not an imported sshTarget host.
      const result = await switchViaSshRelay(sshHost, { localPort: 18765, sshToken: 'ssh-token' });
      expect(result).toEqual({
        ok: true,
        via: 'relay',
        status: { status: 'ok', latencyMs: 0, via: 'relay' },
      });
      expect(requestSshHostTokenCalls).toEqual([]);
      expect(switchRuntimeEndpointCalls).toEqual([[{
        apiBaseUrl: 'https://app.example',
        clientToken: 'ssh-token',
        runtimeKey: 'host:ssh-remote',
        relay: relayHost.relay,
        requestHeaders: { 'x-openchamber-target-port': '18765' },
      }]]);
    } finally {
      if (previousWindow) {
        Object.defineProperty(globalThis, 'window', previousWindow);
      } else {
        Reflect.deleteProperty(globalThis, 'window');
      }
    }
  });

  test('switchViaSshRelay accepts an external relay descriptor for imported hosts', async () => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { location: { origin: 'https://app.example' } },
    });
    getActiveRelayDescriptorImpl = () => null;
    const imported = {
      id: 'imported-ssh',
      label: 'Office · SSH',
      url: 'relay://server-b',
      clientToken: 'old-ssh-token',
      relay: relayHost.relay,
      sshTarget: { hostId: 'ssh-1', desktopClientToken: 'desk-token' },
    };
    try {
      const result = await switchViaSshRelay(imported, { relay: relayHost.relay });
      expect(result.ok).toBe(true);
      expect(requestSshHostTokenCalls).toHaveLength(1);
      expect(requestSshHostTokenCalls[0]?.[0]).toBe('ssh-1');
      const mintOpts = requestSshHostTokenCalls[0]?.[1] as { headers?: Record<string, string> } | undefined;
      expect(mintOpts?.headers?.Authorization).toBe('Bearer desk-token');
      expect(switchRuntimeEndpointCalls).toEqual([[{
        apiBaseUrl: 'https://app.example',
        clientToken: 'ssh-token',
        runtimeKey: 'host:imported-ssh',
        relay: relayHost.relay,
        requestHeaders: { 'x-openchamber-target-port': '18765' },
      }]]);
    } finally {
      if (previousWindow) {
        Object.defineProperty(globalThis, 'window', previousWindow);
      } else {
        Reflect.deleteProperty(globalThis, 'window');
      }
    }
  });

  test('switchViaSshRelay is unsupported without an active relay', async () => {
    getActiveRelayDescriptorImpl = () => null;
    const result = await switchViaSshRelay({
      id: 'ssh-remote',
      label: 'SSH Box',
      url: '',
      viaSshRelay: { localPort: 18765 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unsupported');
    expect(requestSshHostTokenCalls).toEqual([]);
    expect(switchRuntimeEndpointCalls).toEqual([]);
  });
});
