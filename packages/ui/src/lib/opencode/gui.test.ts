import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGuiClient } from './gui';
import { configureRuntimeUrlResolver, getRuntimeUrlResolver, setRuntimeUrlResolver } from '@/lib/runtime-url';
import { setRuntimeBearerToken } from '@/lib/runtime-auth';
import { adoptRelayTunnel, deactivateRelayTunnel } from '@/lib/relay/runtime-tunnel';

const identity = vi.hoisted(() => ({ value: 'host-a', generation: 0 }));
vi.mock('@/lib/runtime-switch', () => ({ getRuntimeTransportIdentity: () => identity.value, getRuntimeGeneration: () => identity.generation }));
const previousResolver = getRuntimeUrlResolver();
const fetchMock = vi.fn();
beforeEach(() => {
  identity.value = 'host-a';
  identity.generation = 0;
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  configureRuntimeUrlResolver({ apiBaseUrl: 'https://host.example' });
  setRuntimeBearerToken('test-gui-token');
});
afterEach(() => {
  deactivateRelayTunnel();
  setRuntimeBearerToken(null);
  setRuntimeUrlResolver(previousResolver);
  vi.unstubAllGlobals();
});

describe('GUI SDK boundary', () => {
  it.each([
    ['https://app.example/session/test', 'https://host.example'],
    ['yuri-ui://app/index.html', 'http://127.0.0.1:43123'],
    ['capacitor://localhost/index.html', 'https://relay-runtime.example'],
  ])('routes GUI bundles over relay from %s with runtime %s', async (href, apiBaseUrl) => {
    vi.stubGlobal('window', Object.assign(new EventTarget(), { location: new URL(href) }));
    configureRuntimeUrlResolver({ apiBaseUrl });
    const relayFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString(), 'https://host.example');
      expect(url.pathname).toBe('/api/plugin/gui');
      expect(url.searchParams.get('id')).toBe('dsl');
      expect(new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get('authorization')).toBe('Bearer test-gui-token');
      return Response.json({ data: { code: 'module.exports={setup(){}}', revision: 'relay', options: {} } });
    });
    adoptRelayTunnel({ relayUrl: 'wss://relay.example', serverId: 'test-host', hostEncPubJwk: {} }, {
      fetch: relayFetch, close: () => {}, getStatus: () => ({ state: 'connected' }), subscribeStatus: () => () => {},
      openWebSocket: () => { throw new Error('unused'); },
    });
    const api = createGuiClient(new AbortController().signal);
    expect((await api.plugin.gui({ id: 'dsl' })).data.revision).toBe('relay');
    expect(relayFetch).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('uses SDK routes with runtime auth and preserves global scope and query', async () => {
    fetchMock.mockImplementation(async (input: Request | string, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      expect(url.origin).toBe('https://host.example');
      expect(url.pathname).toBe('/api/plugin/gui');
      expect(url.searchParams.get('id')).toBe('@example/dsl');
      expect(url.searchParams.has('location[directory]')).toBe(false);
      expect(request.headers.get('authorization')).toBe('Bearer test-gui-token');
      return Response.json({ data: { code: 'module.exports={setup(){}}', revision: 'one', options: {} } });
    });
    const api = createGuiClient(new AbortController().signal);
    expect((await api.plugin.gui({ id: '@example/dsl' })).data.revision).toBe('one');
  });

  it('rejects retained plugin clients after runtime switch or disposal before dispatch', async () => {
    const controller = new AbortController();
    const api = createGuiClient(controller.signal);
    identity.value = 'host-b';
    await expect(api.plugin.list()).rejects.toThrow();
    identity.value = 'host-a';
    identity.generation += 1;
    await expect(api.plugin.list()).rejects.toThrow();
    controller.abort();
    await expect(api.plugin.list()).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('preserves SDK mutation payload and headers and merges cancellation', async () => {
    const lifetime = new AbortController();
    const requestAbort = new AbortController();
    fetchMock.mockImplementation(async (input: Request | string, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      expect(request.method).toBe('POST');
      expect(request.headers.get('x-test')).toBe('kept');
      expect(await request.json()).toEqual({ targets: ['@example/dsl'] });
      lifetime.abort();
      expect((init?.signal ?? request.signal).aborted).toBe(true);
      return new Response(null, { status: 204 });
    });
    const api = createGuiClient(lifetime.signal);
    await api.plugin.update({ targets: ['@example/dsl'] }, { signal: requestAbort.signal, headers: { 'x-test': 'kept' } });
  });
});
