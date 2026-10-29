import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGuiClient } from './gui';
import { configureRuntimeUrlResolver, getRuntimeUrlResolver, setRuntimeUrlResolver } from '@/lib/runtime-url';
import { setRuntimeBearerToken } from '@/lib/runtime-auth';
import { adoptRelayTunnel, deactivateRelayTunnel } from '@/lib/relay/runtime-tunnel';
import { runtimeFileStore } from '@/lib/runtime-file-store';

const identity = vi.hoisted(() => ({ value: 'host-a', generation: 0, runtime: 'paired-a', listeners: new Set<() => void>() }));
const disk = vi.hoisted(() => new Map<string, Blob>());
vi.mock('@/lib/runtime-file-store', () => ({ runtimeFileStore: {
  read: vi.fn(async (key: string) => disk.get(key) ?? null),
  write: vi.fn(async (key: string, value: Blob) => { disk.set(key, value); }),
} }));
vi.mock('@/lib/runtime-switch', () => ({
  getRuntimeTransportIdentity: () => identity.value,
  getRuntimeGeneration: () => identity.generation,
  getRuntimeKey: () => identity.runtime,
  subscribeRuntimeEndpointChanged: (listener: () => void) => {
    identity.listeners.add(listener);
    return () => { identity.listeners.delete(listener); };
  },
}));
const previousResolver = getRuntimeUrlResolver();
const fetchMock = vi.fn();
beforeEach(() => {
  identity.value = 'host-a';
  identity.generation = 0;
  identity.runtime = 'paired-a';
  identity.listeners.clear();
  disk.clear();
  vi.mocked(runtimeFileStore.read).mockReset().mockImplementation(async (key) => disk.get(key) ?? null);
  vi.mocked(runtimeFileStore.write).mockReset().mockImplementation(async (key, value) => { disk.set(key, value); });
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  configureRuntimeUrlResolver({ apiBaseUrl: 'https://host.example' });
  setRuntimeBearerToken('test-gui-token');
});

const tokenA = 'a'.repeat(64);
const tokenB = 'b'.repeat(64);
const bundleResponse = (code = 'module.exports={setup(){}}', token = tokenA, options = {}, cached = false) => Response.json({
  data: { code, revision: `revision-${token}`, options },
}, { headers: { 'X-Yuri-Gui-Revision': token, ...(cached ? { 'X-Yuri-Gui-Code': 'cached' } : {}) } });
const requestHeaders = (input: Request | string, init?: RequestInit) => new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));

describe('durable GUI code revalidation', () => {
  it('reads cold, revalidated and streamed replacement bundles without retaining endpoint listeners', async () => {
    let headers!: (response: Response) => void;
    fetchMock.mockImplementation(() => new Promise(resolve => { headers = resolve; }));
    const api = createGuiClient(new AbortController().signal);
    const cold = api.plugin.gui({ id: 'dsl' });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    headers(bundleResponse('old'));
    expect((await cold).data.code).toBe('old');
    expect(identity.listeners.size).toBe(0);

    const warm = api.plugin.gui({ id: 'dsl' });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    headers(bundleResponse('', tokenA, {}, true));
    expect((await warm).data.code).toBe('old');
    expect(identity.listeners.size).toBe(0);

    let body!: ReadableStreamDefaultController<Uint8Array>;
    const changed = api.plugin.gui({ id: 'dsl' });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    headers(new Response(new ReadableStream({ start(controller) { body = controller; } }), {
      headers: { 'Content-Type': 'application/json', 'X-Yuri-Gui-Revision': tokenB },
    }));
    body.enqueue(new TextEncoder().encode(JSON.stringify({ data: { code: 'new', revision: 'new', options: {} } })));
    body.close();
    expect((await changed).data.code).toBe('new');
    expect(identity.listeners.size).toBe(0);
  });
  it('reuses disk across client restart and direct/relay generations, while options always come from authority', async () => {
    fetchMock.mockResolvedValueOnce(bundleResponse('code-one', tokenA, { password: 'never-persist' }));
    const first = await createGuiClient(new AbortController().signal).plugin.gui({ id: 'dsl' });
    expect(first.data.options).toEqual({ password: 'never-persist' });
    const stored = JSON.parse(await [...disk.values()][0].text());
    expect(stored).toEqual({ code: 'code-one', token: tokenA });
    identity.value = 'relay-host-a';
    identity.generation++;
    fetchMock.mockImplementationOnce(async (input, init) => {
      expect(requestHeaders(input, init).get('X-Yuri-Gui-Revision')).toBe(tokenA);
      return bundleResponse('', tokenA, { password: 'current-only' }, true);
    });
    const second = await createGuiClient(new AbortController().signal).plugin.gui({ id: 'dsl' });
    expect(second.data.code).toBe('code-one');
    expect(second.data.options).toEqual({ password: 'current-only' });
    expect(runtimeFileStore.write).toHaveBeenCalledTimes(1);
    expect(identity.listeners.size).toBe(0);
  });

  it('persists changed revisions including local code updates and remains compatible with old hosts', async () => {
    const api = createGuiClient(new AbortController().signal);
    fetchMock.mockResolvedValueOnce(bundleResponse('old'));
    await api.plugin.gui({ id: 'dsl' });
    fetchMock.mockResolvedValueOnce(bundleResponse('local-updated', tokenB, { changed: true }));
    expect((await api.plugin.gui({ id: 'dsl' })).data.code).toBe('local-updated');
    expect(JSON.parse(await [...disk.values()][0].text())).toEqual({ code: 'local-updated', token: tokenB });
    fetchMock.mockResolvedValueOnce(Response.json({ data: { code: 'old-host-code', revision: 'legacy', options: { legacy: true } } }));
    expect((await api.plugin.gui({ id: 'dsl' })).data.code).toBe('old-host-code');
    expect(runtimeFileStore.write).toHaveBeenCalledTimes(2);
  });

  it('isolates plugin and stable runtime keys without deleting other runtimes', async () => {
    fetchMock.mockResolvedValueOnce(bundleResponse('a'));
    await createGuiClient(new AbortController().signal).plugin.gui({ id: 'dsl' });
    identity.runtime = 'paired-b';
    fetchMock.mockImplementation(async (input, init) => {
      expect(requestHeaders(input, init).has('X-Yuri-Gui-Revision')).toBe(false);
      return bundleResponse('b');
    });
    await createGuiClient(new AbortController().signal).plugin.gui({ id: 'dsl' });
    await createGuiClient(new AbortController().signal).plugin.gui({ id: 'other' });
    expect(disk.size).toBe(3);
    identity.runtime = 'paired-a';
    fetchMock.mockResolvedValueOnce(bundleResponse('', tokenA, {}, true));
    expect((await createGuiClient(new AbortController().signal).plugin.gui({ id: 'dsl' })).data.code).toBe('a');
  });

  it.each(['missing', 'mismatch'])('retries an unusable cached-code response once without a token (%s)', async (mode) => {
    const api = createGuiClient(new AbortController().signal);
    if (mode === 'mismatch') {
      fetchMock.mockResolvedValueOnce(bundleResponse('old'));
      await api.plugin.gui({ id: 'dsl' });
    }
    fetchMock.mockResolvedValueOnce(bundleResponse('', tokenB, {}, true));
    fetchMock.mockImplementationOnce(async (input, init) => {
      expect(requestHeaders(input, init).has('X-Yuri-Gui-Revision')).toBe(false);
      return bundleResponse('fresh', tokenB);
    });
    expect((await api.plugin.gui({ id: 'dsl' })).data.code).toBe('fresh');
  });

  it('rejects a second unusable cached-code response instead of applying missing code', async () => {
    fetchMock.mockImplementation(async () => bundleResponse('', tokenA, {}, true));
    await expect(createGuiClient(new AbortController().signal).plugin.gui({ id: 'dsl' })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(disk.size).toBe(0);
  });

  it.each(['read', 'write'] as const)('storage %s failure never prevents an authoritative bundle', async (operation) => {
    vi.mocked(runtimeFileStore[operation]).mockRejectedValue(new Error('storage unavailable'));
    fetchMock.mockResolvedValueOnce(bundleResponse('network'));
    expect((await createGuiClient(new AbortController().signal).plugin.gui({ id: 'dsl' })).data.code).toBe('network');
    expect(requestHeaders(...fetchMock.mock.calls[0] as [Request, RequestInit]).has('X-Yuri-Gui-Revision')).toBe(false);
  });

  it.each(['not-json', '{"code":"broken"}', '{"code":"bad","token":"invalid"}', JSON.stringify({ code: 'secret', token: tokenA, options: { secret: true } })])('ignores malformed stored code: %s', async (body) => {
    vi.mocked(runtimeFileStore.read).mockResolvedValue(new Blob([body]));
    fetchMock.mockImplementation(async (input, init) => {
      expect(requestHeaders(input, init).has('X-Yuri-Gui-Revision')).toBe(false);
      return bundleResponse('network');
    });
    expect((await createGuiClient(new AbortController().signal).plugin.gui({ id: 'dsl' })).data.code).toBe('network');
  });

  it.each(['abort', 'generation', 'runtime'])('rejects late %s completions before persistence or SDK apply', async (change) => {
    const lifetime = new AbortController();
    fetchMock.mockImplementation(async () => {
      if (change === 'abort') lifetime.abort();
      else if (change === 'generation') identity.generation++;
      else identity.runtime = 'paired-b';
      return bundleResponse('late');
    });
    await expect(createGuiClient(lifetime.signal).plugin.gui({ id: 'dsl' })).rejects.toThrow();
    expect(runtimeFileStore.write).not.toHaveBeenCalled();
  });

  it('rejects incomplete network bundles without persisting them', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ data: { code: 'code', revision: 'revision' } }, { headers: { 'X-Yuri-Gui-Revision': tokenA } }));
    await expect(createGuiClient(new AbortController().signal).plugin.gui({ id: 'dsl' })).rejects.toThrow();
    expect(runtimeFileStore.write).not.toHaveBeenCalled();
  });

  it('rejects runtime changes during cache reads before issuing any network request', async () => {
    vi.mocked(runtimeFileStore.read).mockImplementationOnce(async () => {
      identity.generation++;
      return null;
    });
    await expect(createGuiClient(new AbortController().signal).plugin.gui({ id: 'dsl' })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('aborts persistence on endpoint change and never writes the new runtime partition', async () => {
    fetchMock.mockResolvedValueOnce(bundleResponse('code'));
    vi.mocked(runtimeFileStore.write).mockImplementationOnce(async (key, _blob, signal) => {
      expect(JSON.parse(key)).toEqual(['gui-code-v1', '2.2', 'paired-a', 'dsl']);
      identity.runtime = 'paired-b';
      identity.generation++;
      for (const listener of identity.listeners) listener();
      expect(signal.aborted).toBe(true);
      signal.throwIfAborted();
    });
    await expect(createGuiClient(new AbortController().signal).plugin.gui({ id: 'dsl' })).rejects.toThrow();
    expect(disk.size).toBe(0);
  });

  it('only reads the code cache for exact GUI bundle GETs, preserving unrelated SDK headers', async () => {
    fetchMock.mockImplementationOnce(async (input, init) => {
      expect(new URL(input.url).pathname).toBe('/api/plugin');
      expect(requestHeaders(input, init).get('x-test')).toBe('kept');
      return Response.json({ data: [] });
    });
    await createGuiClient(new AbortController().signal).plugin.list(undefined, { headers: { 'x-test': 'kept' } });
    expect(runtimeFileStore.read).not.toHaveBeenCalled();
    expect(runtimeFileStore.write).not.toHaveBeenCalled();
  });

  it('does not use cached code without an authoritative response', async () => {
    fetchMock.mockResolvedValueOnce(bundleResponse('old'));
    const api = createGuiClient(new AbortController().signal);
    await api.plugin.gui({ id: 'dsl' });
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    await expect(api.plugin.gui({ id: 'dsl' })).rejects.toThrow();
  });
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
