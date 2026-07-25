import { createOpencodeClient } from '@opencode-ai/sdk/v2';

// Directory-scoped OpenCode provider catalog for small-model resolution.
// Never contacts models.dev — source of truth is client.config.providers().
// On OpenCode failure the loader returns an explicit minimal fallback catalog
// (not an authoritative empty map) so hardcoded candidates still resolve.

const CATALOG_TTL_MS = 30_000;
const CATALOG_TIMEOUT_MS = 8_000;

// Minimal catalog when OpenCode is unreachable. OpenAI OAuth and Copilot use
// fixed utility models outside the catalog; Google/Anthropic need family
// entries so the family-priority scan can still pick a small model.
const MINIMAL_FALLBACK_CATALOG = Object.freeze({
  google: Object.freeze({
    id: 'google',
    name: 'Google',
    models: Object.freeze({
      'gemini-2.5-flash': Object.freeze({
        id: 'gemini-2.5-flash',
        family: 'gemini-flash',
        release_date: '2025-06-01',
      }),
    }),
  }),
  anthropic: Object.freeze({
    id: 'anthropic',
    name: 'Anthropic',
    models: Object.freeze({
      'claude-haiku-4-5': Object.freeze({
        id: 'claude-haiku-4-5',
        family: 'claude-haiku',
        release_date: '2025-10-01',
      }),
    }),
  }),
});

const normalizeDirectoryKey = (directory) => {
  if (typeof directory !== 'string') return '';
  const trimmed = directory.trim();
  if (!trimmed) return '';
  // Collapse trailing slashes so "/proj" and "/proj/" share a bucket.
  return trimmed.replace(/\/+$/u, '') || '/';
};

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Convert the official SDK provider list into the internal small-model catalog
 * shape. Keeps family / release_date / limit / model.api.url / provider name
 * for resolve + call; does not project the client-safe catalog allowlist.
 */
export function toSmallModelCatalog(source) {
  if (!isRecord(source) || !Array.isArray(source.providers)) {
    return null;
  }

  const catalog = Object.create(null);
  for (const provider of source.providers) {
    if (!isRecord(provider) || typeof provider.id !== 'string' || !provider.id) continue;
    const models = Object.create(null);
    if (isRecord(provider.models)) {
      for (const modelKey of Object.keys(provider.models)) {
        const model = provider.models[modelKey];
        if (!isRecord(model)) continue;
        const modelID = typeof model.id === 'string' && model.id ? model.id : modelKey;
        if (!modelID) continue;
        const entry = { id: modelID };
        if (typeof model.family === 'string' && model.family) entry.family = model.family;
        if (typeof model.release_date === 'string' && model.release_date) {
          entry.release_date = model.release_date;
        }
        if (isRecord(model.limit)) {
          const limit = Object.create(null);
          if (Number.isFinite(model.limit.context)) limit.context = model.limit.context;
          if (Number.isFinite(model.limit.output)) limit.output = model.limit.output;
          if (Object.keys(limit).length > 0) entry.limit = limit;
        }
        if (isRecord(model.api) && typeof model.api.url === 'string' && model.api.url.trim()) {
          entry.api = { url: model.api.url.trim() };
        }
        models[modelID] = entry;
      }
    }
    catalog[provider.id] = {
      id: provider.id,
      name: typeof provider.name === 'string' && provider.name ? provider.name : provider.id,
      models,
    };
  }
  return catalog;
}

export function getCatalogProvider(catalog, providerID) {
  const entry = catalog?.[providerID];
  return entry && typeof entry === 'object' ? entry : null;
}

/**
 * @param {{
 *   buildOpenCodeUrl: (pathname: string, search?: string) => string,
 *   getOpenCodeAuthHeaders: () => Record<string, string>,
 *   ttlMs?: number,
 *   timeoutMs?: number,
 *   fetchImpl?: typeof fetch,
 * }} options
 */
export function createModelCatalogLoader({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  ttlMs = CATALOG_TTL_MS,
  timeoutMs = CATALOG_TIMEOUT_MS,
  fetchImpl = globalThis.fetch.bind(globalThis),
}) {
  /** @type {Map<string, { catalog: object, cachedAt: number, source: string, inflight: Promise<object> | null }>} */
  const buckets = new Map();

  const fetchOpenCodeCatalog = async (directory) => {
    const baseUrl = buildOpenCodeUrl('/', '').replace(/\/$/, '');
    const client = createOpencodeClient({
      baseUrl,
      ...(directory ? { directory } : {}),
      headers: getOpenCodeAuthHeaders(),
      fetch: (request) => fetchImpl(request, { signal: AbortSignal.timeout(timeoutMs) }),
    });
    const response = await client.config.providers(directory ? { directory } : {});
    if (response?.error || response?.data === undefined) {
      throw new Error('OpenCode provider catalog is unavailable');
    }
    const catalog = toSmallModelCatalog(response.data);
    if (!catalog) {
      throw new Error('OpenCode provider catalog returned an unexpected payload');
    }
    return catalog;
  };

  /**
   * Load (or serve cached) directory-scoped catalog.
   * OpenCode failure → explicit minimal fallback (never an authoritative empty map).
   */
  const getModelCatalog = async (directory) => {
    const key = normalizeDirectoryKey(directory);
    const now = Date.now();
    let bucket = buckets.get(key);
    if (bucket && now - bucket.cachedAt < ttlMs && bucket.catalog) {
      return bucket.catalog;
    }

    if (!bucket) {
      bucket = { catalog: null, cachedAt: 0, source: 'none', inflight: null };
      buckets.set(key, bucket);
    }

    if (!bucket.inflight) {
      bucket.inflight = (async () => {
        try {
          const catalog = await fetchOpenCodeCatalog(key || undefined);
          bucket.catalog = catalog;
          bucket.cachedAt = Date.now();
          bucket.source = 'opencode';
          return catalog;
        } catch (error) {
          // Explicit failure path: minimal hardcoded candidates only.
          console.warn(
            '[small-model] OpenCode provider catalog failed; using minimal fallback:',
            error?.message || error,
          );
          bucket.catalog = MINIMAL_FALLBACK_CATALOG;
          bucket.cachedAt = Date.now();
          bucket.source = 'fallback';
          return MINIMAL_FALLBACK_CATALOG;
        } finally {
          bucket.inflight = null;
        }
      })();
    }

    return bucket.inflight;
  };

  return {
    getModelCatalog,
    getCatalogProvider,
    /** @internal test helpers */
    _normalizeDirectoryKey: normalizeDirectoryKey,
    _minimalFallbackCatalog: MINIMAL_FALLBACK_CATALOG,
  };
}

export { MINIMAL_FALLBACK_CATALOG };
