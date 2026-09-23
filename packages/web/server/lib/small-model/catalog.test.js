import { describe, expect, it } from 'vitest';
import { createModelCatalogLoader, toSmallModelCatalog } from './catalog.js';

describe('toSmallModelCatalog', () => {
  it('keeps family, release_date, limit, cost, model.api.url, and provider name', () => {
    const catalog = toSmallModelCatalog({
      providers: [{
        id: 'google',
        name: 'Google',
        models: {
          'gemini-2.5-flash': {
            id: 'gemini-2.5-flash',
            name: 'Gemini 2.5 Flash',
            family: 'gemini-flash',
            release_date: '2025-06-01',
            limit: { context: 1_000_000, output: 8192 },
            cost: { input: 0.15, output: 0.6, cache_read: 0.01 },
            api: { id: 'gemini-2.5-flash', url: 'https://generativelanguage.googleapis.com', npm: '@ai-sdk/google' },
          },
        },
      }],
      default: {},
    });

    expect(catalog.google).toEqual({
      id: 'google',
      name: 'Google',
      models: {
        'gemini-2.5-flash': {
          id: 'gemini-2.5-flash',
          family: 'gemini-flash',
          release_date: '2025-06-01',
          limit: { context: 1_000_000, output: 8192 },
          cost: { input: 0.15, output: 0.6 },
          api: { url: 'https://generativelanguage.googleapis.com' },
        },
      },
    });
  });

  it('returns null for malformed roots', () => {
    expect(toSmallModelCatalog(null)).toBeNull();
    expect(toSmallModelCatalog({ providers: {} })).toBeNull();
  });
});

describe('createModelCatalogLoader', () => {
  it('rejects with 502 when OpenCode is unreachable and does not cache the failure', async () => {
    let calls = 0;
    const loader = createModelCatalogLoader({
      buildOpenCodeUrl: () => 'http://127.0.0.1:9/',
      getOpenCodeAuthHeaders: () => ({}),
      ttlMs: 30_000,
      timeoutMs: 50,
      fetchImpl: async () => {
        calls += 1;
        throw new Error('network down');
      },
    });

    const a = loader.getModelCatalog('/proj');
    const b = loader.getModelCatalog('/proj/');
    // Single-flight + directory key normalization: same bucket for trailing slash.
    const results = await Promise.allSettled([a, b]);
    for (const result of results) {
      expect(result.status).toBe('rejected');
      expect(result.reason.statusCode).toBe(502);
      expect(result.reason.message).toMatch(/provider catalog is unavailable/);
    }
    const callsAfterFirst = calls;
    await expect(loader.getModelCatalog('/proj')).rejects.toMatchObject({ statusCode: 502 });
    expect(calls).toBeGreaterThan(callsAfterFirst);
  });

  it('forwards OpenCode auth headers through the fetch wrapper', async () => {
    const seen = [];
    const loader = createModelCatalogLoader({
      buildOpenCodeUrl: () => 'http://127.0.0.1:4096/',
      getOpenCodeAuthHeaders: () => ({ Authorization: 'Basic test' }),
      fetchImpl: async (url, init) => {
        seen.push(new Headers(init?.headers).get('authorization'));
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    await loader.getModelCatalog('/proj');
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((value) => value === 'Basic test')).toBe(true);
  });

  it('composes official v2 provider.list + model.list into the small-model catalog', async () => {
    const loader = createModelCatalogLoader({
      buildOpenCodeUrl: () => 'http://127.0.0.1:4096/',
      getOpenCodeAuthHeaders: () => ({ Authorization: 'Basic test' }),
      fetchImpl: async (url) => {
        const href = String(url);
        const data = href.includes('/api/model')
          ? [{
              id: 'gemini-2.5-flash',
              modelID: 'gemini-2.5-flash',
              providerID: 'google',
              family: 'gemini-flash',
              name: 'Gemini 2.5 Flash',
              capabilities: {},
              variants: [],
              time: { released: Date.parse('2025-06-01T00:00:00Z') },
              cost: [],
              status: 'active',
              enabled: true,
              limit: { context: 1_000_000, output: 8192 },
              api: { url: 'https://generativelanguage.googleapis.com' },
            }]
          : [{ id: 'google', name: 'Google', package: '@ai-sdk/google' }];
        return new Response(JSON.stringify({
          location: { directory: '/proj', project: { id: 'p', directory: '/proj', canonical: '/proj' } },
          data,
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });

    const catalog = await loader.getModelCatalog('/proj');
    expect(catalog.google).toEqual({
      id: 'google',
      name: 'Google',
      models: {
        'gemini-2.5-flash': {
          id: 'gemini-2.5-flash',
          family: 'gemini-flash',
          release_date: '2025-06-01',
          limit: { context: 1_000_000, output: 8192 },
          api: { url: 'https://generativelanguage.googleapis.com' },
        },
      },
    });
  });

  it('keys models by ModelInfo.id and keeps the base tier of array cost', async () => {
    const loader = createModelCatalogLoader({
      buildOpenCodeUrl: () => 'http://127.0.0.1:4096/',
      getOpenCodeAuthHeaders: () => ({}),
      fetchImpl: async (url) => {
        const href = String(url);
        const data = href.includes('/api/model')
          ? [{
              id: 'gpt-5.4-mini',
              modelID: 'internal-pack',
              providerID: 'openai',
              name: 'GPT-5.4 Mini',
              cost: [
                { tier: { type: 'context', size: 200000 }, input: 9, output: 9 },
                { input: 1, output: 2 },
              ],
            }]
          : [{ id: 'openai', name: 'OpenAI', package: '@ai-sdk/openai' }];
        return new Response(JSON.stringify({ data }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    const catalog = await loader.getModelCatalog('/proj');
    expect(catalog.openai?.models?.['gpt-5.4-mini']).toEqual({
      id: 'gpt-5.4-mini',
      cost: { input: 1, output: 2 },
    });
    expect(catalog.openai?.models?.['internal-pack']).toBeUndefined();
  });

  it('normalizes directory keys so trailing slashes share a bucket', () => {
    const loader = createModelCatalogLoader({
      buildOpenCodeUrl: () => 'http://127.0.0.1:9/',
      getOpenCodeAuthHeaders: () => ({}),
    });
    expect(loader._normalizeDirectoryKey('/proj/')).toBe('/proj');
    expect(loader._normalizeDirectoryKey('/proj')).toBe('/proj');
    expect(loader._normalizeDirectoryKey('')).toBe('');
    expect(loader._normalizeDirectoryKey(undefined)).toBe('');
  });
});
