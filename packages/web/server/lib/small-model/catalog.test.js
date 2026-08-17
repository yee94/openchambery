import { describe, expect, it } from 'vitest';
import { createModelCatalogLoader, toSmallModelCatalog, MINIMAL_FALLBACK_CATALOG } from './catalog.js';

describe('toSmallModelCatalog', () => {
  it('keeps family, release_date, limit, model.api.url, and provider name', () => {
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
  it('uses explicit minimal fallback when OpenCode is unreachable (not empty catalog)', async () => {
    const loader = createModelCatalogLoader({
      buildOpenCodeUrl: () => 'http://127.0.0.1:9/',
      getOpenCodeAuthHeaders: () => ({}),
      ttlMs: 30_000,
      timeoutMs: 50,
      fetchImpl: async () => {
        throw new Error('network down');
      },
    });

    const a = loader.getModelCatalog('/proj');
    const b = loader.getModelCatalog('/proj/');
    // Single-flight + directory key normalization: same bucket for trailing slash.
    const [catalogA, catalogB] = await Promise.all([a, b]);
    expect(catalogA).toBe(MINIMAL_FALLBACK_CATALOG);
    expect(catalogB).toBe(MINIMAL_FALLBACK_CATALOG);
    expect(catalogA.google?.models?.['gemini-2.5-flash']?.family).toBe('gemini-flash');
    expect(catalogA.anthropic?.models?.['claude-haiku-4-5']?.family).toBe('claude-haiku');
    // Must not masquerade as authoritative empty success.
    expect(Object.keys(catalogA).length).toBeGreaterThan(0);
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
    expect(catalog).not.toBe(MINIMAL_FALLBACK_CATALOG);
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
