import { describe, expect, it } from 'vitest';
import { createModelCatalogLoader, toSmallModelCatalog, MINIMAL_FALLBACK_CATALOG } from './catalog.js';

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
