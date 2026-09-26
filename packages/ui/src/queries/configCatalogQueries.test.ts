import { mock } from 'bun:test';
import { beforeEach, describe, expect, test } from 'vitest';

let runtimeKey = 'runtime-a';
let agentCalls = 0;
let agentResult: Array<{ name: string }> | null = null;
let agentFailure = false;
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
          if (v2ConfigResult instanceof Error) throw v2ConfigResult;
          return v2ConfigResult;
        },
      },
    }),
    listAgents: async (_directory?: string | null, signal?: AbortSignal) => {
      agentCalls += 1;
      seenSignal = signal;
      if (agentFailure) throw new Error('Agent catalog unavailable');
      await new Promise<void>((resolve) => { resolveAgents = resolve; });
      return agentResult ?? [{ name: `${runtimeKey}:${_directory}` }];
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
    agentResult = null;
    agentFailure = false;
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
    v2ModelResult = { data: [{ id: 'model', modelID: 'internal-pack', providerID: 'legacy', name: 'Model' }] };
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
    expect(providerCatalogQueryOptions('/workspace/project', 'runtime-a').queryKey).toEqual(['runtime-a', 'configCatalog', 'providers', '/workspace/project']);
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

  test('Provider Catalog 按目录分片，不同 directory 各自请求', async () => {
    await ensureProviderCatalogQuery('/workspace/project', runtimeKey);
    await ensureProviderCatalogQuery('/workspace/other', runtimeKey);
    expect(providerCalls).toBe(2);
    expect(providerCatalogQueryOptions('/workspace/project', runtimeKey).queryKey).not.toEqual(
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
    // 分片后 seed 不得泄漏到其他目录
    expect(queryClient.getQueryData(providerCatalogQueryOptions('/workspace/other', runtimeKey).queryKey)).toBe(undefined);
    expect(queryClient.getQueryData(providerCatalogQueryOptions('/workspace/project', runtimeKey).queryKey)).toEqual(warmCatalog);

    seedProviderCatalogQuery('/workspace/cold-partial', { providers: [], defaultProviders: {}, providerCatalogPartial: true }, runtimeKey);
    expect(queryClient.getQueryData(providerCatalogQueryOptions('/workspace/cold-partial', runtimeKey).queryKey)).toBe(undefined);
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

  test('v2 fallback 把思考变体数组投影成 catalog record，并丢掉请求载荷', async () => {
    providerFetchImpl = async () => new Response('unsupported', { status: 404 });
    v2ModelResult = {
      data: [{
        id: 'model',
        modelID: 'internal-pack',
        providerID: 'legacy',
        name: 'Model',
        capabilities: { tools: true, input: ['text', 'image'], output: ['text'] },
        variants: [
          { id: 'low', settings: { apiKey: 'variant-settings-sentinel' } },
          { id: 'high', headers: { Authorization: 'variant-headers-sentinel' } },
        ],
        time: { released: Date.parse('2026-01-02T00:00:00Z') },
      }],
    };

    const result = await ensureProviderCatalogQuery('/workspace/project', runtimeKey);
    expect(result.providers[0]?.models.model).toEqual({
      id: 'model',
      name: 'Model',
      capabilities: { toolcall: true, input: { text: true, image: true }, output: { text: true } },
      release_date: '2026-01-02',
      variants: { low: {}, high: {} },
    });
    expect(JSON.stringify(result)).not.toContain('sentinel');
    expect(JSON.stringify(result)).not.toContain('internal-pack');
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

    const v2Variants = parseProviderCatalog({
      schemaVersion: 1,
      providers: [{
        id: 'safe',
        name: 'Safe',
        models: {
          stable_key: {
            id: 'model',
            name: 'Model',
            capabilities: { tools: true, input: ['text', 'pdf', 'secret'], output: ['text'] },
            cost: [{ tier: { type: 'context', size: 1 }, input: 9, output: 9 }, { input: 1, output: 2, cache: { read: 0.1, write: 0.2 } }],
            variants: [{ id: 'low', settings: { token: 'secret' } }, { id: 'high' }, { id: 'constructor' }, 'max'],
          },
        },
      }],
      default: { safe: 'model' },
      partial: false,
    });
    expect(v2Variants.partial).toBe(false);
    expect(v2Variants.providers[0]!.models.stable_key).toEqual({
      id: 'model',
      name: 'Model',
      capabilities: { toolcall: true, input: { text: true, pdf: true }, output: { text: true } },
      cost: { input: 1, output: 2, cache: { read: 0.1, write: 0.2 } },
      variants: { low: {}, high: {}, max: {} },
    });
    expect(JSON.stringify(v2Variants)).not.toContain('secret');
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

  test('partial responses stay stale, failed requests are not cached as success, and a later ensure recovers', async () => {
    const complete = { schemaVersion: 1, providers: [{ id: 'safe', name: 'Safe', models: { model: { id: 'model', name: 'Model' } } }], default: {}, partial: false };
    providerPayload = complete;
    await ensureProviderCatalogQuery('/workspace/project', runtimeKey);
    providerPayload = { ...complete, partial: true };
    await expect(refreshProviderCatalogQuery('/workspace/project', runtimeKey)).rejects.toThrow('Partial provider catalog refresh retained the complete snapshot');
    expect(queryClient.getQueryData<{ partial: boolean }>(providerCatalogQueryOptions('/workspace/project', runtimeKey).queryKey)?.partial).toBe(false);

    queryClient.clear();
    expect((await ensureProviderCatalogQuery('/workspace/project', runtimeKey)).partial).toBe(true);
    const callsAfterPartial = providerCalls;
    providerPayload = complete;
    expect((await ensureProviderCatalogQuery('/workspace/project', runtimeKey)).partial).toBe(false);
    expect(providerCalls).toBe(callsAfterPartial + 1);

    queryClient.clear();
    providerFetchImpl = async () => new Response('unavailable', { status: 503 });
    providerCalls = 0;
    await expect(ensureProviderCatalogQuery('/workspace/retry', runtimeKey)).rejects.toThrow('Provider catalog request failed');
    expect(providerCalls).toBe(3);
    expect(v2ProviderCalls).toBe(0);
    expect(queryClient.getQueryData(providerCatalogQueryOptions('/workspace/retry', runtimeKey).queryKey)).toBeUndefined();
    providerFetchImpl = undefined;
    expect((await ensureProviderCatalogQuery('/workspace/retry', runtimeKey)).providers).toHaveLength(1);
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

  test('optional default config failure does not discard the loaded provider and model lists', async () => {
    providerFetchImpl = async () => new Response('missing', { status: 404 });
    v2ConfigResult = new Error('config unavailable');
    const catalog = await ensureProviderCatalogQuery('/workspace/project', runtimeKey);
    expect(catalog.providers[0]?.models.model.id).toBe('model');
    expect(catalog.default).toEqual({});
    expect(catalog.partial).toBe(false);
  });

  test('成功返回空 catalog 后，再次 ensure 会重新发起请求', async () => {
    providerPayload = { schemaVersion: 1, providers: [], default: {}, partial: false };
    await ensureProviderCatalogQuery('/workspace/project', runtimeKey);
    expect(providerCalls).toBe(1);

    await ensureProviderCatalogQuery('/workspace/project', runtimeKey);
    expect(providerCalls).toBeGreaterThan(1);
  });

  test('空 providers 完整快照不 seed', () => {
    seedProviderCatalogQuery('/workspace/project', {
      providers: [],
      defaultProviders: {},
      providerCatalogPartial: false,
    }, runtimeKey);
    expect(queryClient.getQueryData(providerCatalogQueryOptions('/workspace/project', runtimeKey).queryKey)).toBe(undefined);
  });

  test('成功返回空 Agent catalog 后，再次 ensure 会重新发起请求', async () => {
    agentResult = [];
    const first = ensureRawAgentsQuery('/workspace/project', runtimeKey);
    resolveAgents?.();
    expect(await first).toEqual([]);
    expect(agentCalls).toBe(1);

    const second = ensureRawAgentsQuery('/workspace/project', runtimeKey);
    resolveAgents?.();
    expect(await second).toEqual([]);
    expect(agentCalls).toBe(2);
  });

  test('failed Agent ensure does not cache an empty success and the next demand recovers', async () => {
    agentFailure = true;
    await expect(ensureRawAgentsQuery('/workspace/project', runtimeKey)).rejects.toThrow('Agent catalog unavailable');
    expect(queryClient.getQueryState(rawAgentsQueryOptions('/workspace/project', runtimeKey).queryKey)?.status).toBe('error');
    expect(queryClient.getQueryData(rawAgentsQueryOptions('/workspace/project', runtimeKey).queryKey)).toBeUndefined();
    agentFailure = false;
    const recovery = ensureRawAgentsQuery('/workspace/project', runtimeKey);
    resolveAgents?.();
    expect(await recovery).toHaveLength(1);
    const calls = agentCalls;
    await ensureRawAgentsQuery('/workspace/project', runtimeKey);
    expect(agentCalls).toBe(calls);
  });
});
