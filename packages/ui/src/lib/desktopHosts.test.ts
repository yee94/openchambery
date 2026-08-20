import { describe, expect, test } from 'bun:test';
import {
  DESKTOP_HOST_SOURCE_CONNECT_LINK,
  desktopHostProbe,
  desktopHostsGet,
  desktopHostsSet,
  isVisibleDesktopHost,
  redactSensitiveUrl,
  resolveDesktopHostUrl,
  type DesktopHost,
} from './desktopHosts';

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

  test('hides legacy manually added hosts without deleting them', () => {
    expect(isVisibleDesktopHost(host(), new Set(['other-ssh']))).toBe(false);
  });
});
