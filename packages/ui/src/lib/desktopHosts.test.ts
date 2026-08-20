import { afterEach, describe, expect, mock, test } from 'bun:test';

const runtimeFetchCalls: unknown[][] = [];
let runtimeFetchImpl: (...args: unknown[]) => Promise<Response> = async () =>
  new Response(JSON.stringify({ hosts: [] }), { status: 200, headers: { 'content-type': 'application/json' } });

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: (...args: unknown[]) => {
    runtimeFetchCalls.push(args);
    return runtimeFetchImpl(...args);
  },
}));

const {
  DESKTOP_HOST_SOURCE_CONNECT_LINK,
  desktopHostProbe,
  desktopHostsGet,
  desktopHostsSet,
  fetchSshHostToken,
  isVisibleDesktopHost,
  redactSensitiveUrl,
  requestSshHostToken,
  resolveDesktopHostUrl,
} = await import('./desktopHosts');
type DesktopHost = import('./desktopHosts').DesktopHost;

const withDesktopBridge = async <T>(handler: (cmd: string, args: Record<string, unknown>) => unknown | Promise<unknown>, run: () => Promise<T>): Promise<T> => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      __OPENCHAMBER_DESKTOP__: {
        invoke: handler,
      },
    },
  });
  try {
    return await run();
  } finally {
    if (previousWindow) {
      Object.defineProperty(globalThis, 'window', previousWindow);
    } else {
      Reflect.deleteProperty(globalThis, 'window');
    }
  }
};

describe('resolveDesktopHostUrl', () => {
  test('keeps regular host URLs unchanged', () => {
    expect(resolveDesktopHostUrl('https://example.com/app?x=1')).toEqual({
      persistedUrl: 'https://example.com/app?x=1',
      redeemUrl: null,
      kind: 'normal-host',
    });
  });

  test('detects tunnel connect links and stores only origin', () => {
    expect(resolveDesktopHostUrl('https://example.trycloudflare.com/connect?t=secret-token')).toEqual({
      persistedUrl: 'https://example.trycloudflare.com',
      redeemUrl: 'https://example.trycloudflare.com/connect?t=secret-token',
      kind: 'tunnel-connect-link',
    });
  });

  test('detects tunnel connect links with trailing slash', () => {
    expect(resolveDesktopHostUrl('https://example.trycloudflare.com/connect/?t=secret-token#section')).toEqual({
      persistedUrl: 'https://example.trycloudflare.com',
      redeemUrl: 'https://example.trycloudflare.com/connect/?t=secret-token',
      kind: 'tunnel-connect-link',
    });
  });

  test('redacts tunnel tokens from labels', () => {
    expect(redactSensitiveUrl('https://example.trycloudflare.com/connect?t=secret-token')).toBe(
      'https://example.trycloudflare.com/connect?t=%5BREDACTED%5D',
    );
  });
});

describe('desktop host runtime headers', () => {
  test('restores a saved custom Relay endpoint for Desktop reconnects', async () => {
    await withDesktopBridge(async (cmd) => {
      expect(cmd).toBe('desktop_hosts_get');
      return {
        hosts: [{
          id: 'remote-relay',
          label: 'Self-hosted Relay',
          url: 'relay://server-1',
          relay: {
            relayUrl: 'wss://self-hosted.example/ws',
            serverId: 'server-1',
            hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
          },
        }],
        defaultHostId: 'remote-relay',
        initialHostChoiceCompleted: true,
      };
    }, async () => {
      const config = await desktopHostsGet();
      expect(config.hosts[0]?.relay).toEqual({
        relayUrl: 'wss://self-hosted.example/ws',
        serverId: 'server-1',
        hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
      });
    });
  });

  test('parses persisted request headers from desktop config', async () => {
    await withDesktopBridge(async (cmd) => {
      expect(cmd).toBe('desktop_hosts_get');
      return {
        hosts: [{
          id: 'remote-1',
          label: 'Remote',
          url: 'https://remote.example',
          requestHeaders: {
            ' CF-Access-Client-Id ': ' client-id ',
            Authorization: 'Bearer should-not-be-read',
            'Bad:Name': 'bad',
          },
        }],
        defaultHostId: 'remote-1',
        initialHostChoiceCompleted: true,
      };
    }, async () => {
      const config = await desktopHostsGet();
      expect(config.hosts[0]?.requestHeaders).toEqual({
        'CF-Access-Client-Id': 'client-id',
      });
    });
  });

  test('parses connect-link source and ignores unknown source values', async () => {
    await withDesktopBridge(async (cmd) => {
      expect(cmd).toBe('desktop_hosts_get');
      return {
        hosts: [
          {
            id: 'imported',
            label: 'Imported',
            url: 'https://imported.example',
            source: 'connect-link',
          },
          {
            id: 'legacy',
            label: 'Legacy',
            url: 'https://legacy.example',
            source: 'manual',
          },
        ],
        defaultHostId: 'imported',
        initialHostChoiceCompleted: true,
      };
    }, async () => {
      const config = await desktopHostsGet();
      expect(config.hosts[0]?.source).toBe(DESKTOP_HOST_SOURCE_CONNECT_LINK);
      expect(config.hosts[1]?.source).toBeUndefined();
    });
  });

  test('passes request headers through host save and probe IPC calls', async () => {
    const calls: Array<{ cmd: string; args: Record<string, unknown> }> = [];
    await withDesktopBridge(async (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === 'desktop_host_probe') return { status: 'ok', latencyMs: 7 };
      return null;
    }, async () => {
      const requestHeaders = { 'CF-Access-Client-Id': 'client-id' };
      await desktopHostsSet({
        hosts: [{ id: 'remote-1', label: 'Remote', url: 'https://remote.example', requestHeaders }],
        defaultHostId: 'remote-1',
      });
      const probe = await desktopHostProbe('https://remote.example', { requestHeaders });
      expect(probe).toEqual({ status: 'ok', latencyMs: 7 });
    });

    expect(calls[0]).toEqual({
      cmd: 'desktop_hosts_set',
      args: {
        input: {
          hosts: [{ id: 'remote-1', label: 'Remote', url: 'https://remote.example', requestHeaders: { 'CF-Access-Client-Id': 'client-id' } }],
          defaultHostId: 'remote-1',
          initialHostChoiceCompleted: undefined,
        },
      },
    });
    expect(calls[1]).toEqual({
      cmd: 'desktop_host_probe',
      args: {
        url: 'https://remote.example',
        requestHeaders: { 'CF-Access-Client-Id': 'client-id' },
      },
    });
  });
});

describe('isVisibleDesktopHost', () => {
  const host = (overrides: Partial<DesktopHost> = {}): DesktopHost => ({
    id: 'host-1',
    label: 'Host',
    url: 'https://host.example',
    ...overrides,
  });

  test('shows imported connect-link hosts', () => {
    expect(isVisibleDesktopHost(host({ source: DESKTOP_HOST_SOURCE_CONNECT_LINK }), new Set())).toBe(true);
  });

  test('shows hosts whose id matches a desktop SSH instance', () => {
    expect(isVisibleDesktopHost(host({ id: 'ssh-1' }), new Set(['ssh-1']))).toBe(true);
  });

  test('shows hosts that carry a relay descriptor', () => {
    expect(isVisibleDesktopHost(host({
      relay: {
        relayUrl: 'wss://relay.example/ws',
        serverId: 'server-1',
        hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
      },
    }), new Set())).toBe(true);
  });

  test('shows SSH hosts listed via relay', () => {
    expect(isVisibleDesktopHost(host({
      url: '',
      viaSshRelay: { localPort: 18765 },
    }), new Set())).toBe(true);
  });

  test('shows imported SSH pairing hosts with sshTarget', () => {
    expect(isVisibleDesktopHost(host({
      url: 'relay://server-1',
      relay: {
        relayUrl: 'wss://relay.example/ws',
        serverId: 'server-1',
        hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
      },
      sshTarget: { hostId: 'ssh-1', desktopClientToken: 'desk-token' },
      source: DESKTOP_HOST_SOURCE_CONNECT_LINK,
    }), new Set())).toBe(true);
  });

  test('hides legacy manually added hosts without deleting them', () => {
    expect(isVisibleDesktopHost(host(), new Set(['other-ssh']))).toBe(false);
  });
});

describe('desktop host sshTarget parse', () => {
  test('parses sshTarget from desktop_hosts_get', async () => {
    await withDesktopBridge(async (cmd) => {
      expect(cmd).toBe('desktop_hosts_get');
      return {
        hosts: [{
          id: 'imported-ssh',
          label: 'Office · SSH',
          url: 'relay://server-1',
          clientToken: 'ssh-token',
          source: 'connect-link',
          relay: {
            relayUrl: 'wss://relay.example/ws',
            serverId: 'server-1',
            hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
          },
          sshTarget: { hostId: 'ssh-1', desktopClientToken: 'desk-token' },
        }],
        defaultHostId: 'imported-ssh',
        initialHostChoiceCompleted: true,
      };
    }, async () => {
      const config = await desktopHostsGet();
      expect(config.hosts[0]?.sshTarget).toEqual({
        hostId: 'ssh-1',
        desktopClientToken: 'desk-token',
      });
      expect(config.hosts[0]?.clientToken).toBe('ssh-token');
    });
  });
});

describe('desktopHostsGet runtime fallback', () => {
  afterEach(() => {
    runtimeFetchCalls.length = 0;
    runtimeFetchImpl = async () =>
      new Response(JSON.stringify({ hosts: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  });

  test('maps /api/openchamber/desktop-hosts when desktop invoke is unavailable', async () => {
    runtimeFetchImpl = async () => new Response(JSON.stringify({
      hosts: [
        { id: 'ssh-a', label: 'Office SSH', localPort: 18765, reachable: true },
        { id: 'bad', label: 'Missing port', reachable: false },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } });

    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {},
    });
    try {
      const config = await desktopHostsGet();
      expect(runtimeFetchCalls).toEqual([['/api/openchamber/desktop-hosts']]);
      expect(config.hosts).toEqual([
        {
          id: 'ssh-a',
          label: 'Office SSH',
          url: '',
          apiUrl: '',
          viaSshRelay: { localPort: 18765 },
        },
      ]);
      expect(config.defaultHostId).toBeNull();
    } finally {
      if (previousWindow) {
        Object.defineProperty(globalThis, 'window', previousWindow);
      } else {
        Reflect.deleteProperty(globalThis, 'window');
      }
    }
  });

  test('keeps desktop invoke path when available', async () => {
    await withDesktopBridge(async (cmd) => {
      expect(cmd).toBe('desktop_hosts_get');
      return {
        hosts: [{ id: 'remote-1', label: 'Remote', url: 'https://remote.example' }],
        defaultHostId: 'remote-1',
        initialHostChoiceCompleted: true,
      };
    }, async () => {
      const config = await desktopHostsGet();
      expect(runtimeFetchCalls).toEqual([]);
      expect(config.hosts).toEqual([
        { id: 'remote-1', label: 'Remote', url: 'https://remote.example' },
      ]);
    });
  });

  test('throws when runtime desktop-hosts request fails', async () => {
    runtimeFetchImpl = async () => new Response('nope', { status: 503 });
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {},
    });
    try {
      let message = '';
      try {
        await desktopHostsGet();
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toBe('desktop-hosts failed: 503');
    } finally {
      if (previousWindow) {
        Object.defineProperty(globalThis, 'window', previousWindow);
      } else {
        Reflect.deleteProperty(globalThis, 'window');
      }
    }
  });
});

describe('fetchSshHostToken', () => {
  afterEach(() => {
    runtimeFetchCalls.length = 0;
    runtimeFetchImpl = async () =>
      new Response(JSON.stringify({ hosts: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  });

  test('returns token from POST /api/openchamber/ssh-host-token', async () => {
    runtimeFetchImpl = async () => new Response(JSON.stringify({
      token: ' host-token ',
      localPort: 18765,
      reachable: true,
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    const token = await fetchSshHostToken('ssh-a');
    expect(token).toBe('host-token');
    expect(runtimeFetchCalls).toHaveLength(1);
    expect(runtimeFetchCalls[0]?.[0]).toBe('/api/openchamber/ssh-host-token');
    const init = runtimeFetchCalls[0]?.[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ hostId: 'ssh-a' }));
  });

  test('throws when token response is not ok', async () => {
    runtimeFetchImpl = async () => new Response('denied', { status: 403 });
    let message = '';
    try {
      await fetchSshHostToken('ssh-a');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe('ssh-host-token failed: 403');
  });

  test('throws when token is missing', async () => {
    runtimeFetchImpl = async () => new Response(JSON.stringify({}), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    let message = '';
    try {
      await fetchSshHostToken('ssh-a');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe('ssh-host-token missing token');
  });

  test('requestSshHostToken returns localPort/reachable and accepts pairingId', async () => {
    runtimeFetchImpl = async () => new Response(JSON.stringify({
      token: 'ssh-token',
      localPort: 19001,
      reachable: true,
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    const result = await requestSshHostToken('ssh-a', { pairingId: 'pair_1' });
    expect(result).toEqual({ token: 'ssh-token', localPort: 19001, reachable: true });
    const init = runtimeFetchCalls[0]?.[1] as RequestInit;
    expect(init.body).toBe(JSON.stringify({ hostId: 'ssh-a', pairingId: 'pair_1' }));
  });

  test('requestSshHostToken marks unreachable when localPort is null', async () => {
    runtimeFetchImpl = async () => new Response(JSON.stringify({
      token: 'ssh-token',
      localPort: null,
      reachable: false,
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    const result = await requestSshHostToken('ssh-a');
    expect(result.reachable).toBe(false);
    expect(result.localPort).toBeNull();
  });
});
