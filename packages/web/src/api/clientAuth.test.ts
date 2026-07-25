import { afterEach, describe, expect, mock, test } from 'bun:test';

import { createWebClientAuthAPI, normalizeHapiHubRelayWsUrl } from './clientAuth';

describe('normalizeHapiHubRelayWsUrl', () => {
  test('rewrites https hub dashboard URLs to the private-relay WS path', () => {
    expect(normalizeHapiHubRelayWsUrl('https://hub.example.com/dashboard')).toBe(
      'wss://hub.example.com/api/openchamber/relay/ws',
    );
  });

  test('rewrites http to ws and bare hosts to wss', () => {
    expect(normalizeHapiHubRelayWsUrl('http://localhost:8787')).toBe(
      'ws://localhost:8787/api/openchamber/relay/ws',
    );
    expect(normalizeHapiHubRelayWsUrl('hub.example.com')).toBe(
      'wss://hub.example.com/api/openchamber/relay/ws',
    );
  });

  test('accepts an already-ws URL and still forces the relay path', () => {
    expect(normalizeHapiHubRelayWsUrl('wss://hub.example.com/custom')).toBe(
      'wss://hub.example.com/api/openchamber/relay/ws',
    );
  });

  test('rejects empty / non-http(s)/ws schemes', () => {
    expect(normalizeHapiHubRelayWsUrl('')).toBeNull();
    expect(normalizeHapiHubRelayWsUrl('   ')).toBeNull();
    expect(normalizeHapiHubRelayWsUrl('ftp://hub.example.com')).toBeNull();
  });
});

describe('createWebClientAuthAPI HAPI relay', () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;

  const installWindow = () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        location: { origin: 'http://localhost:2606', href: 'http://localhost:2606/', protocol: 'http:', host: 'localhost:2606' },
        fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
      },
    });
  };

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
  });

  test('configureHapiRelay omits accessToken when not provided (reuse server token)', async () => {
    installWindow();
    const calls: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url, body });
      return Response.json({
        enabled: true,
        relayUrl: 'wss://hub.example.com/api/openchamber/relay/ws',
        transport: 'hapi',
        state: 'connected',
        serverId: 'srv1',
      });
    }) as typeof fetch;

    const api = createWebClientAuthAPI();
    const result = await api.configureHapiRelay({ hubUrl: 'https://hub.example.com' });
    expect(result.transport).toBe('hapi');
    expect(result.state).toBe('connected');
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const enableCall = calls.find((c) => {
      const body = c.body as { transport?: string } | null;
      return String(c.url).includes('/relay/enable') || body?.transport === 'hapi';
    });
    expect(enableCall?.body).toEqual({
      relayUrl: 'wss://hub.example.com/api/openchamber/relay/ws',
      transport: 'hapi',
    });
    expect((enableCall?.body as { accessToken?: string } | undefined)?.accessToken).toEqual(undefined);
  });

  test('configureHapiRelay fails without createPairing when server returns non-2xx', async () => {
    installWindow();
    let pairingCalled = false;
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/relay/enable')) {
        return Response.json({ error: 'HAPI relay did not connect in time (state=connecting)' }, { status: 504 });
      }
      if (url.includes('/pairing/sessions')) {
        pairingCalled = true;
        return Response.json({ error: 'should not reach' }, { status: 500 });
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;

    const api = createWebClientAuthAPI();
    await expect(api.configureHapiRelay({
      hubUrl: 'https://hub.example.com',
      accessToken: 'tok',
    })).rejects.toThrow(/connect|time|HAPI|Failed to configure/i);
    expect(pairingCalled).toBe(false);
  });

  test('getRelayStatus exposes hasAccessToken and strips any echoed token', async () => {
    installWindow();
    globalThis.fetch = mock(async () => Response.json({
      enabled: true,
      state: 'connected',
      transport: 'hapi',
      hasAccessToken: true,
      relayUrl: 'wss://hub.example/ws',
      // Buggy server should not leak — client must drop it.
      accessToken: 'leaked-secret',
    })) as typeof fetch;

    const api = createWebClientAuthAPI();
    const status = await api.getRelayStatus!();
    expect(status.hasAccessToken).toBe(true);
    expect(status.transport).toBe('hapi');
    expect((status as { accessToken?: string }).accessToken).toEqual(undefined);
    expect(JSON.stringify(status)).not.toContain('leaked-secret');
  });

  test('configureClassicRelay posts to /relay/classic', async () => {
    installWindow();
    const calls: string[] = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return Response.json({
        enabled: true,
        relayUrl: 'wss://relay.openchamber.dev/ws',
        hasAccessToken: false,
        state: 'connecting',
      });
    }) as typeof fetch;

    const api = createWebClientAuthAPI();
    const result = await api.configureClassicRelay!({ enabled: true });
    expect(result.hasAccessToken).toBe(false);
    expect(result.transport).toEqual(undefined);
    expect(calls.some((u) => u.includes('/relay/classic'))).toBe(true);
  });
});
