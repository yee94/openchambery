import { beforeEach, describe, expect, mock, test } from 'bun:test';

let runtimeKey = 'runtime-a';
let agentCalls = 0;
let providerCalls = 0;
let seenSignal: AbortSignal | undefined;
let providerSignal: AbortSignal | undefined;
let providerDirectory: string | null = null;
let providerPayload: unknown;
let providerFetchImpl: (() => Promise<Response>) | undefined;
let v2ProviderCalls = 0;
let v2ModelCalls = 0;
let v2ConfigCalls = 0;
let v2ProviderDirectory: string | undefined;
let v2ProviderSignal: AbortSignal | undefined;
let v2ProviderResult: unknown;
let v2ModelResult: unknown;
let v2ConfigResult: unknown;
let resolveAgents: (() => void) | undefined;

mock.module('@/lib/runtime-switch', () => ({
  getRuntimeTransportIdentity: () => runtimeKey,
  getRuntimeGeneration: () => 0,
  isRuntimeEndpointIdentityChange: () => false,
  subscribeRuntimeEndpointChanged: () => () => undefined,
}));
mock.module('@/lib/opencode/client', () => ({
  opencodeClient: {
    getSdkClient: () => ({
      provider: {
        list: async (parameters?: { location?: { directory?: string } }, options?: { signal?: AbortSignal }) => {
          v2ProviderCalls += 1;
          v2ProviderDirectory = parameters?.location?.directory;
          v2ProviderSignal = options?.signal;
          return v2ProviderResult;
        },
      },
      model: {
        list: async () => {
          v2ModelCalls += 1;
          return v2ModelResult;
        },
      },
      config: {
        get: async () => {
          v2ConfigCalls += 1;
          return v2ConfigResult;
        },
      },
    }),
    listAgents: async (_directory?: string | null, signal?: AbortSignal) => {
      agentCalls += 1;
      seenSignal = signal;
      await new Promise<void>((resolve) => { resolveAgents = resolve; });
      return [{ name: `${runtimeKey}:${_directory}` }];
    },
  },
}));
mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: async (_path: string, options?: RequestInit) => {
    providerCalls += 1;
    providerSignal = options?.signal ?? undefined;
    providerDirectory = new Headers(options?.headers).get('x-opencode-directory');
    return providerFetchImpl ? providerFetchImpl() : new Response(JSON.stringify(providerPayload));
  },
}));

const { queryClient } = await import('@/lib/queryRuntime');
const { parseProviderCatalog } = await import('@/lib/configCatalogParser');
const {
  ensureRawAgentsQuery,
  ensureProviderCatalogQuery,
  refreshProviderCatalogQuery,
  seedProviderCatalogQuery,
  invalidateRawAgentsQuery,
  providerCatalogQueryOptions,
  rawAgentsQueryOptions,
} = await import('./configCatalogQueries');

describe('configCatalogQueries', () => {
  beforeEach(() => {
    queryClient.clear();
    runtimeKey = 'runtime-a';
    agentCalls = 0;
    providerCalls = 0;
    seenSignal = undefined;
    providerSignal = undefined;
    providerDirectory = null;
    providerPayload = { schemaVersion: 1, providers: [{ id: 'safe', name: 'Safe', models: { model: { id: 'model', name: 'Model', api: 'secret', variants: { fast: { token: 'secret' } } } } }], default: {}, partial: false };
    providerFetchImpl = undefined;
    v2ProviderCalls = 0;
    v2ModelCalls = 0;
    v2ConfigCalls = 0;
    v2ProviderDirectory = undefined;
    v2ProviderSignal = undefined;
    v2ProviderResult = { data: [{ id: 'legacy', name: 'Legacy' }] };
    v2ModelResult = { data: [{ id: 'model', modelID: 'model', providerID: 'legacy', name: 'Model' }] };
    v2ConfigResult = [{ type: 'document', info: { model: { providerID: 'legacy', model: 'model' } } }];
    resolveAgents = undefined;
  });

  test('同一规范化目录的并发读取共享一次请求，并透传 AbortSignal', async () => {
    const first = ensureRawAgentsQuery(' /workspace/project/ ', runtimeKey);
    const second = ensureRawAgentsQuery('/workspace/project', runtimeKey);
    expect(agentCalls).toBe(1);
    expect(seenSignal).toBeInstanceOf(AbortSignal);
    resolveAgents?.();
    expect(await Promise.all([first, second])).toEqual([
      [{ name: 'runtime-a:/workspace/project' }],
      [{ name: 'runtime-a:/workspace/project' }],
    ]);
  });

  test('fresh cache、精确失效和 transport/directory key 保持隔离', async () => {
    const first = ensureRawAgentsQuery('/workspace/project', runtimeKey);
    resolveAgents?.();
    await first;
    await ensureRawAgentsQuery('/workspace/project', runtimeKey);
    expect(agentCalls).toBe(1);

    const secondDirectory = ensureRawAgentsQuery('/workspace/other', runtimeKey);
    resolveAgents?.();
    await secondDirectory;
    runtimeKey = 'runtime-b';
    const secondTransport = ensureRawAgentsQuery('/workspace/project', runtimeKey);
    resolveAgents?.();
    await secondTransport;
    expect(agentCalls).toBe(2);

    await invalidateRawAgentsQuery('/workspace/project', 'runtime-a');
    runtimeKey = 'runtime-a';
    const refreshed = ensureRawAgentsQuery('/workspace/project', runtimeKey);
    resolveAgents?.();
    await refreshed;
    expect(agentCalls).toBe(3);
    expect(rawAgentsQueryOptions('/workspace/project', 'runtime-a').queryKey).toEqual(['runtime-a', 'agents', 'raw']);
    expect(rawAgentsQueryOptions('/workspace/project', 'runtime-a').queryKey).toEqual(
      rawAgentsQueryOptions('/workspace/other', 'runtime-a').queryKey,
    );
    expect(providerCatalogQueryOptions('/workspace/project', 'runtime-a').queryKey).toEqual(['runtime-a', 'configCatalog', 'providers']);
  });

  test('Agent catalog 跨目录共享同一份全局 cache', async () => {
    const first = ensureRawAgentsQuery('/workspace/project', runtimeKey);
    resolveAgents?.();
    await first;
    await ensureRawAgentsQuery('/workspace/other', runtimeKey);
    expect(agentCalls).toBe(1);
    expect(rawAgentsQueryOptions('/workspace/project', runtimeKey).queryKey).toEqual(
      rawAgentsQueryOptions('/workspace/other', runtimeKey).queryKey,
    );
  });

  test('Provider Catalog 跨目录共享同一份全局 cache', async () => {
    await ensureProviderCatalogQuery('/workspace/project', runtimeKey);
    await ensureProviderCatalogQuery('/workspace/other', runtimeKey);
    expect(providerCalls).toBe(1);
    expect(providerCatalogQueryOptions('/workspace/project', runtimeKey).queryKey).toEqual(
      providerCatalogQueryOptions('/workspace/other', runtimeKey).queryKey,
    );
  });

  test('Provider Catalog 使用安全宿主路由、目录和 AbortSignal，并丢弃敏感字段', async () => {
    const result = await ensureProviderCatalogQuery('/workspace/project', runtimeKey);
    expect(providerCalls).toBe(1);
    expect(providerDirectory).toBe('/workspace/project');
    expect(providerSignal).toBeInstanceOf(AbortSignal);
    expect(result.providers[0]).toEqual({ id: 'safe', name: 'Safe', models: { model: { id: 'model', name: 'Model', variants: { fast: {} } } } });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(JSON.stringify(queryClient.getQueryData(providerCatalogQueryOptions('/workspace/project', runtimeKey).queryKey))).not.toContain('secret');
  });

  test('完整快照只 seed 冷 Query，partial 快照不创建冷 Query', () => {
    seedProviderCatalogQuery('/workspace/project', {
      providers: [{ id: 'seed', name: 'Seed', apiKey: 'secret', models: [{ id: 'model', name: 'Model', variants: { fast: { token: 'secret' } } }] }],
      defaultProviders: { default: 'seed' },
      providerCatalogPartial: false,
    }, runtimeKey);
    expect(queryClient.getQueryData(providerCatalogQueryOptions('/workspace/project', runtimeKey).queryKey)).toEqual({
      schemaVersion: 1,
      providers: [{ id: 'seed', name: 'Seed', models: { '0': { id: 'model', name: 'Model', variants: { fast: {} } } } }],
      default: { default: 'seed' },
      partial: false,
    });
    const warmCatalog = queryClient.getQueryData(providerCatalogQueryOptions('/workspace/project', runtimeKey).queryKey);
    seedProviderCatalogQuery('/workspace/project', {
      providers: [{ id: 'replacement', name: 'Replacement', models: [{ id: 'replacement-model', name: 'Replacement model' }] }],
      defaultProviders: { default: 'replacement' },
      providerCatalogPartial: false,
    }, runtimeKey);
    expect(queryClient.getQueryData(providerCatalogQueryOptions('/workspace/other', runtimeKey).queryKey)).toEqual(warmCatalog);

    seedProviderCatalogQuery('/workspace/cold-partial', { providers: [], defaultProviders: {}, providerCatalogPartial: true }, runtimeKey);
    expect(queryClient.getQueryData(providerCatalogQueryOptions('/workspace/cold-partial', runtimeKey).queryKey)).toEqual(warmCatalog);
  });

  test('Provider Catalog 顶层 schema 失效时失败关闭', async () => {
    providerPayload = { schemaVersion: 2, providers: [], default: {}, partial: false };
    await expect(ensureProviderCatalogQuery('/workspace/project', runtimeKey)).rejects.toThrow('Invalid provider catalog response');
  });

  test('安全宿主路由返回 404 和 501 时通过 v2 provider.list / model.list / config.get 组装 catalog，并透传目录与 AbortSignal', async () => {
    for (const status of [404, 501]) {
      providerFetchImpl = async () => new Response('unsupported', { status });

      const result = await ensureProviderCatalogQuery(' /workspace/project/ ', runtimeKey);

      expect(providerCalls).toBe(1);
      expect(v2ProviderCalls).toBe(1);
      expect(v2ModelCalls).toBe(1);
      expect(v2ConfigCalls).toBe(1);
      expect(v2ProviderDirectory).toBe('/workspace/project');
      expect(v2ProviderSignal).toBeInstanceOf(AbortSignal);
      expect(result).toEqual({ schemaVersion: 1, providers: [{ id: 'legacy', name: 'Legacy', models: { model: { id: 'model', name: 'Model' } } }], default: { legacy: 'model' }, partial: false });
      queryClient.clear();
      providerCalls = 0;
      v2ProviderCalls = 0;
      v2ModelCalls = 0;
      v2ConfigCalls = 0;
    }
  });

  test('v2 catalog 缺少 provider.list data 时失败关闭', async () => {
    providerFetchImpl = async () => new Response('missing', { status: 404 });
    v2ProviderResult = { location: {} };

    await expect(ensureProviderCatalogQuery('/workspace/project', runtimeKey)).rejects.toThrow('v2 provider catalog request failed');
    expect(queryClient.getQueryData(providerCatalogQueryOptions('/workspace/project', runtimeKey).queryKey)).toBe(undefined);
  });

  test('parser keeps valid fixed modalities and model keys; soft metadata strip is not partial, structural drops are', () => {
    const softOnly = parseProviderCatalog({
      schemaVersion: 1,
      providers: [
        { id: 'safe', name: 'Safe', models: {
          stable_key: {
            id: 'model', name: 'Model',
            capabilities: { temperature: 'yes', input: { unknown: true, text: true, audio: false, image: true, video: false, pdf: true } },
            cost: { input: Infinity, output: 1, cache: { read: 'bad', write: 2 } },
            limit: { context: 'bad', output: 3 },
            release_date: ' invalid ',
            variants: { valid: {}, invalid: 'bad' },
          },
        } },
      ],
      default: { safe: 'model' },
      partial: false,
    });
    expect(softOnly.partial).toBe(false);
    expect(Object.keys(softOnly.providers[0]!.models)).toEqual(['stable_key']);
    expect(softOnly.providers[0]!.models.stable_key?.capabilities?.input).toEqual({ text: true, audio: false, image: true, video: false, pdf: true });
    expect(softOnly.providers[0]!.models.stable_key?.cost).toEqual({ output: 1, cache: { write: 2 } });
    expect(softOnly.providers[0]!.models.stable_key?.limit).toEqual({ output: 3 });
    expect(softOnly.providers[0]!.models.stable_key?.release_date).toBe(undefined);
    expect(softOnly.providers[0]!.models.stable_key?.variants).toEqual({ valid: {} });
    expect(softOnly.default).toEqual({ safe: 'model' });

    const structural = parseProviderCatalog({
      schemaVersion: 1,
      providers: [
        { id: 'safe', name: 'Safe', models: {
          stable_key: { id: 'model', name: 'Model' },
          duplicate_id: { id: 'model', name: 'Duplicate' },
          missing_name: { id: 'missing-name' },
          constructor: { id: 'dangerous-key', name: 'Dangerous key' },
          dangerous_id: { id: 'constructor', name: 'Dangerous id' },
        } },
        { id: 'safe', name: 'Duplicate provider', models: {} },
      ],
      default: { constructor: 'model', safe: 'model' },
      partial: false,
    });
    expect(structural.partial).toBe(true);
    expect(Object.keys(structural.providers[0]!.models)).toEqual(['stable_key']);
    expect(structural.default).toEqual({ safe: 'model' });

    const nullPrototype = Object.assign(Object.create(null), { schemaVersion: 1, providers: [], default: {}, partial: false });
    expect(() => parseProviderCatalog(nullPrototype)).toThrow('Invalid provider catalog response');
    const dangerousKey = parseProviderCatalog(JSON.parse('{"schemaVersion":1,"providers":[],"default":{"__proto__":"model"},"partial":false}'));
    expect(dangerousKey.default).toEqual({});
    expect(dangerousKey.partial).toBe(true);
  });

  test('partial refresh preserves a complete snapshot, cold partial remains usable, and retry runs exactly three requests', async () => {
    const complete = { schemaVersion: 1, providers: [{ id: 'safe', name: 'Safe', models: { model: { id: 'model', name: 'Model' } } }], default: {}, partial: false };
    providerPayload = complete;
    await ensureProviderCatalogQuery('/workspace/project', runtimeKey);
    providerPayload = { ...complete, partial: true };
    await expect(refreshProviderCatalogQuery('/workspace/project', runtimeKey)).rejects.toThrow('Partial provider catalog refresh retained the complete snapshot');
    expect(queryClient.getQueryData<{ partial: boolean }>(providerCatalogQueryOptions('/workspace/project', runtimeKey).queryKey)?.partial).toBe(false);

    queryClient.clear();
    const coldPartial = await ensureProviderCatalogQuery('/workspace/project', runtimeKey);
    expect(coldPartial.partial).toBe(true);

    queryClient.clear();
    providerFetchImpl = async () => new Response('unavailable', { status: 503 });
    providerCalls = 0;
    await expect(ensureProviderCatalogQuery('/workspace/retry', runtimeKey)).rejects.toThrow('Provider catalog request failed');
    expect(providerCalls).toBe(3);
    expect(v2ProviderCalls).toBe(0);
  });

  test('v2 catalog 在无限 freshness 下重复 ensure 不发起新请求', async () => {
    providerFetchImpl = async () => new Response('missing', { status: 404 });
    await ensureProviderCatalogQuery('/workspace/project', runtimeKey);
    await ensureProviderCatalogQuery('/workspace/project', runtimeKey);

    expect(providerCalls).toBe(1);
    expect(v2ProviderCalls).toBe(1);
    expect(v2ModelCalls).toBe(1);
    expect(v2ConfigCalls).toBe(1);
  });
});