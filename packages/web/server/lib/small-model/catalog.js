import { OpenCode } from '@opencode/client';

// Directory-scoped OpenCode provider catalog for small-model resolution.
// Never contacts models.dev — source of truth is provider.list + model.list,
// the same connected catalog the LLM gateway checks before generating.
// ModelInfo.id is the external model id; ModelInfo.modelID is internal.
// OpenCode failure is an explicit error, never a substitute catalog.

const CATALOG_TTL_MS = 30_000;
const CATALOG_TIMEOUT_MS = 8_000;

const normalizeDirectoryKey = (directory) => {
  if (typeof directory !== 'string') return '';
  const trimmed = directory.trim();
  if (!trimmed) return '';
  // Collapse trailing slashes so "/proj" and "/proj/" share a bucket.
  return trimmed.replace(/\/+$/u, '') || '/';
};

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// v2 ModelInfo.cost is a tier array. Ranking still reads cost.input / cost.output.
const projectCatalogCost = (cost) => {
  const entry = Array.isArray(cost)
    ? (cost.find((item) => isRecord(item) && !isRecord(item.tier)) || cost.find((item) => isRecord(item)))
    : (isRecord(cost) ? cost : null);
  if (!isRecord(entry)) return undefined;
  const projected = Object.create(null);
  if (Number.isFinite(entry.input)) projected.input = entry.input;
  if (Number.isFinite(entry.output)) projected.output = entry.output;
  return Object.keys(projected).length > 0 ? projected : undefined;
};

// Compose official v2 provider.list + model.list into the SDK catalog shape
// consumed by toSmallModelCatalog. Missing arrays are failure, not empty success.
const composeV2ProviderCatalogSource = (providers, models) => {
  if (!Array.isArray(providers) || !Array.isArray(models)) return null;

  const modelsByProvider = new Map();
  for (const model of models) {
    if (!isRecord(model)) continue;
    const providerID = typeof model.providerID === 'string' ? model.providerID : '';
    // ModelInfo.id is the external model id used in generate/session refs.
    // ModelInfo.modelID is a separate internal field and must not be preferred.
    const modelID = typeof model.id === 'string' && model.id
      ? model.id
      : (typeof model.modelID === 'string' ? model.modelID : '');
    if (!providerID || !modelID) continue;
    if (!modelsByProvider.has(providerID)) modelsByProvider.set(providerID, Object.create(null));
    const entry = { id: modelID };
    if (typeof model.family === 'string' && model.family) entry.family = model.family;
    if (isRecord(model.limit)) {
      const limit = Object.create(null);
      if (Number.isFinite(model.limit.context)) limit.context = model.limit.context;
      if (Number.isFinite(model.limit.output)) limit.output = model.limit.output;
      if (Object.keys(limit).length > 0) entry.limit = limit;
    }
    const cost = projectCatalogCost(model.cost);
    if (cost) entry.cost = cost;
    if (isRecord(model.api) && typeof model.api.url === 'string' && model.api.url.trim()) {
      entry.api = { url: model.api.url.trim() };
    }
    if (typeof model.time?.released === 'number' && Number.isFinite(model.time.released)) {
      entry.release_date = new Date(model.time.released).toISOString().slice(0, 10);
    } else if (typeof model.release_date === 'string' && model.release_date) {
      entry.release_date = model.release_date;
    }
    modelsByProvider.get(providerID)[modelID] = entry;
  }

  const catalogProviders = [];
  for (const provider of providers) {
    if (!isRecord(provider) || typeof provider.id !== 'string' || !provider.id) continue;
    catalogProviders.push({
      id: provider.id,
      name: typeof provider.name === 'string' && provider.name ? provider.name : provider.id,
      models: modelsByProvider.get(provider.id) || Object.create(null),
    });
  }
  return { providers: catalogProviders };
};

/**
 * Convert the official SDK provider list into the internal small-model catalog
 * shape. Keeps family / release_date / limit / cost.input|output /
 * model.api.url / provider name for resolve + call; does not project the
 * client-safe catalog allowlist.
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
        // cost.input/output feed default small-model ranking (cheapest first).
        if (isRecord(model.cost)) {
          const cost = Object.create(null);
          if (Number.isFinite(model.cost.input)) cost.input = model.cost.input;
          if (Number.isFinite(model.cost.output)) cost.output = model.cost.output;
          if (Object.keys(cost).length > 0) entry.cost = cost;
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
  /** @type {Map<string, { catalog: object | null, cachedAt: number, inflight: Promise<object> | null }>} */
  const buckets = new Map();

  const fetchOpenCodeCatalog = async (directory) => {
    const baseUrl = buildOpenCodeUrl('/', '').replace(/\/$/, '');
    const client = OpenCode.make({
      baseUrl,
      headers: getOpenCodeAuthHeaders(),
      fetch: (request, init) => fetchImpl(request, { ...init, signal: AbortSignal.timeout(timeoutMs) }),
    });
    const location = directory ? { directory } : undefined;
    const request = location ? { location } : undefined;
    const [providersResult, modelsResult] = await Promise.all([
      client.provider.list(request),
      client.model.list(request),
    ]);
    const source = composeV2ProviderCatalogSource(providersResult?.data, modelsResult?.data);
    if (!source) {
      throw new Error('OpenCode provider catalog is unavailable');
    }
    const catalog = toSmallModelCatalog(source);
    if (!catalog) {
      throw new Error('OpenCode provider catalog returned an unexpected payload');
    }
    return catalog;
  };

  /**
   * Load (or serve cached) directory-scoped catalog. Failures are not cached
   * and reject with statusCode 502 so callers never resolve against a guess.
   */
  const getModelCatalog = async (directory) => {
    const key = normalizeDirectoryKey(directory);
    const now = Date.now();
    let bucket = buckets.get(key);
    if (bucket && now - bucket.cachedAt < ttlMs && bucket.catalog) {
      return bucket.catalog;
    }

    if (!bucket) {
      bucket = { catalog: null, cachedAt: 0, inflight: null };
      buckets.set(key, bucket);
    }

    if (!bucket.inflight) {
      bucket.inflight = (async () => {
        try {
          const catalog = await fetchOpenCodeCatalog(key || undefined);
          bucket.catalog = catalog;
          bucket.cachedAt = Date.now();
          return catalog;
        } catch (error) {
          throw Object.assign(
            new Error(`OpenCode provider catalog is unavailable (${error?.message || error})`),
            { statusCode: 502 },
          );
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
  };
}
