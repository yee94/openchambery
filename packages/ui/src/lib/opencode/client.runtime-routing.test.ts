import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { opencodeClient } from './client';
import { configureRuntimeUrlResolver, getRuntimeUrlResolver, setRuntimeUrlResolver } from '../runtime-url';
import { setRuntimeBearerToken } from '../runtime-auth';
import { adoptRelayTunnel, deactivateRelayTunnel } from '../relay/runtime-tunnel';
import type { RelayTunnelClient } from '../relay/tunnel-client';

const directory = '/remote/worktrees/project/feature';
const localOrigin = 'http://127.0.0.1:57123';
const previousResolver = getRuntimeUrlResolver();
const nativeFetch = vi.fn();
const remoteResponse = () => Response.json({
  location: { directory },
  data: [{ id: 'build', name: 'Remote Build', mode: 'primary' }],
});

beforeEach(() => {
  vi.stubGlobal('fetch', nativeFetch);
  nativeFetch.mockReset().mockImplementation(async () => Response.json({
    _tag: 'LocationNotFoundError', location: { directory }, message: `Location not found: ${directory}`,
  }, { status: 404 }));
  configureRuntimeUrlResolver({ apiBaseUrl: localOrigin });
  opencodeClient.reconnectToRuntimeBaseUrl();
  setRuntimeBearerToken('test-remote-token');
});

afterEach(() => {
  deactivateRelayTunnel();
  setRuntimeBearerToken(null);
  setRuntimeUrlResolver(previousResolver);
  vi.unstubAllGlobals();
});

test('a client created before desktop restore reads worktree agents from the current remote Host', async () => {
  configureRuntimeUrlResolver({ apiBaseUrl: 'https://remote.example' });
  nativeFetch.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (new URL(request.url).origin === localOrigin) {
      return Response.json({ _tag: 'LocationNotFoundError', location: { directory }, message: `Location not found: ${directory}` }, { status: 404 });
    }
    expect(new URL(request.url).origin).toBe('https://remote.example');
    expect(new URL(request.url).searchParams.get('location[directory]')).toBe(directory);
    expect(request.headers.get('authorization')).toBe('Bearer test-remote-token');
    return remoteResponse();
  });

  const agents = await opencodeClient.listAgents(directory);
  expect(agents[0].displayName).toBe('Remote Build');
  expect(nativeFetch).toHaveBeenCalledOnce();
});

test('a retained SDK client tunnels worktree catalog reads after a Host switch even when its captured origin is stale', async () => {
  configureRuntimeUrlResolver({ apiBaseUrl: 'https://previous-host.example' });
  opencodeClient.reconnectToRuntimeBaseUrl();
  const sdk = opencodeClient.getSdkClient();
  configureRuntimeUrlResolver({ apiBaseUrl: 'https://relay-runtime.example' });
  const tunnelFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString(), 'https://relay-runtime.example');
    expect(url.pathname).toBe('/api/agent');
    expect(url.searchParams.get('location[directory]')).toBe(directory);
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-remote-token');
    return remoteResponse();
  });
  const tunnel: RelayTunnelClient = {
    fetch: tunnelFetch,
    openWebSocket: () => { throw new Error('unused'); },
    getStatus: () => ({ state: 'connected' }),
    subscribeStatus: () => () => {},
    close: () => {},
  };
  adoptRelayTunnel({ relayUrl: 'wss://relay.example', serverId: 'remote-host', hostEncPubJwk: {} }, tunnel);

  const result = await sdk.agent.list({ location: { directory } });
  expect(result.data[0].name).toBe('Remote Build');
  expect(tunnelFetch).toHaveBeenCalledOnce();
  expect(nativeFetch).not.toHaveBeenCalled();
});

test('dispatch-time routing preserves SDK mutation bodies, headers and cancellation', async () => {
  const sdk = opencodeClient.getScopedSdkClient(directory);
  configureRuntimeUrlResolver({ apiBaseUrl: 'https://remote.example' });
  const controller = new AbortController();
  nativeFetch.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    expect(request.url).toBe('https://remote.example/api/session');
    expect(request.method).toBe('POST');
    expect(request.headers.get('authorization')).toBe('Bearer test-remote-token');
    expect(request.headers.get('x-test-request')).toBe('preserved');
    expect(await request.json()).toEqual({ title: 'Remote worktree', location: { directory } });
    controller.abort();
    expect(init?.signal?.aborted).toBe(true);
    return Response.json({ data: { id: 'ses_remote', title: 'Remote worktree', location: { directory } } });
  });

  const result = await sdk.session.create({ title: 'Remote worktree', location: { directory } }, {
    signal: controller.signal,
    headers: { 'x-test-request': 'preserved' },
  });
  expect(result.id).toBe('ses_remote');
  expect(nativeFetch).toHaveBeenCalledOnce();
});
