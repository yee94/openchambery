import { getCatalogProvider } from './catalog.js';

// Mirrors OpenCode's getSmallModel fallback chain over the connected OpenCode
// catalog, with OpenChamber's own keyword + cheapest-first default when no
// session/family match applies:
// 1. `small_model` from the merged config layers ("provider/model").
// 2. Family-priority / keyword scan of connected providers' catalog models.
const FAMILY_PRIORITY = ['gemini-flash', 'gpt-nano', 'claude-haiku'];

// Tokenize model ids so "mini" does not match inside "gemini".
const modelIdTokens = (id) => String(id || '')
  .toLowerCase()
  .split(/[^a-z0-9]+/i)
  .filter(Boolean);

const idHasToken = (id, token) => modelIdTokens(id).includes(token);

// Small-model keyword tiers (lower = better). Known OpenCode families stay
// highest; broader name tokens cover plugin / catalog models without a family.
const SMALL_MODEL_KEYWORD_TIERS = Object.freeze([
  { tier: 0, test: (id, family) => family === 'gemini-flash' || idHasToken(id, 'flash') },
  { tier: 1, test: (id, family) => family === 'gpt-nano' || idHasToken(id, 'nano') },
  { tier: 2, test: (id, family) => family === 'claude-haiku' || idHasToken(id, 'haiku') },
  { tier: 3, test: (id) => idHasToken(id, 'mini') },
  { tier: 4, test: (id) => idHasToken(id, 'lite') },
  { tier: 5, test: (id) => idHasToken(id, 'turbo') },
  { tier: 6, test: (id) => idHasToken(id, 'instant') },
  { tier: 7, test: (id) => idHasToken(id, 'small') },
  { tier: 8, test: (id) => idHasToken(id, 'chat') },
]);

export function parseModelRef(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const slash = trimmed.indexOf('/');
  if (slash <= 0 || slash === trimmed.length - 1) return null;
  return {
    providerID: trimmed.slice(0, slash),
    modelID: trimmed.slice(slash + 1),
  };
}

const pickByFamily = (models, family) => {
  const matches = Object.values(models)
    .filter((model) => model && typeof model === 'object' && model.family === family);
  if (matches.length === 0) return null;
  matches.sort(compareSmallModelCandidates);
  return matches[0];
};

const smallModelKeywordTier = (model) => {
  const id = typeof model?.id === 'string' ? model.id : '';
  const family = typeof model?.family === 'string' ? model.family : '';
  for (const entry of SMALL_MODEL_KEYWORD_TIERS) {
    if (entry.test(id, family)) return entry.tier;
  }
  return Number.POSITIVE_INFINITY;
};

const costInputOrLast = (model) => {
  const input = model?.cost?.input;
  return Number.isFinite(input) ? input : Number.POSITIVE_INFINITY;
};

/** Cheapest input cost first; missing cost last; newer release_date wins ties. */
export function compareSmallModelCandidates(a, b) {
  const costDiff = costInputOrLast(a) - costInputOrLast(b);
  if (costDiff !== 0) return costDiff;
  return String(b.release_date || '').localeCompare(String(a.release_date || ''));
}

/**
 * Rank catalog models for the default (no explicit config) small-model pick:
 * keyword tier → cost.input asc (missing last) → release_date desc.
 */
export function rankSmallModelCandidates(models) {
  return Object.values(models || {})
    .filter((model) => model && typeof model === 'object' && typeof model.id === 'string' && model.id)
    .map((model) => ({ model, tier: smallModelKeywordTier(model) }))
    .filter((entry) => Number.isFinite(entry.tier))
    .sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier;
      return compareSmallModelCandidates(a.model, b.model);
    })
    .map((entry) => entry.model);
}

const catalogModels = (catalog, providerID) => {
  const models = getCatalogProvider(catalog, providerID)?.models;
  return models && typeof models === 'object' ? models : null;
};

const pickWithinProvider = (catalog, providerID, family) => {
  const models = catalogModels(catalog, providerID);
  const model = models ? pickByFamily(models, family) : null;
  return model?.id ? { providerID, modelID: model.id, source: 'family-scan' } : null;
};

const pickKeywordDefault = (catalog, providerIDs) => {
  /** @type {Array<{ providerID: string, model: object }>} */
  const candidates = [];
  for (const providerID of providerIDs) {
    for (const model of rankSmallModelCandidates(catalogModels(catalog, providerID))) {
      candidates.push({ providerID, model });
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    const tierDiff = smallModelKeywordTier(a.model) - smallModelKeywordTier(b.model);
    if (tierDiff !== 0) return tierDiff;
    return compareSmallModelCandidates(a.model, b.model);
  });
  const best = candidates[0];
  return { providerID: best.providerID, modelID: best.model.id, source: 'keyword-scan' };
};

/**
 * @param {{
 *   catalog: object | null,
 *   settingsSmallModel?: string | null,
 *   configSmallModel?: string | null,
 *   preferredProviderID?: string,
 *   preferredModelID?: string,
 * }} input
 */
export function resolveSmallModel({ catalog, settingsSmallModel, configSmallModel, preferredProviderID, preferredModelID }) {
  // OpenChamber's own setting (Settings → Sessions → Small Model override)
  // outranks everything, including the OpenCode config.
  const fromSettings = parseModelRef(settingsSmallModel);
  if (fromSettings) {
    return { ...fromSettings, source: 'settings' };
  }

  const explicit = parseModelRef(configSmallModel);
  if (explicit) {
    return { ...explicit, source: 'config' };
  }

  // Like OpenCode: when the caller has a session context, the utility call
  // stays on the session's provider. Scan its families for a small model,
  // otherwise run on the session's own model — never silently switch to a
  // different provider's subscription.
  const preferred = typeof preferredProviderID === 'string' && preferredProviderID
    ? preferredProviderID
    : null;
  if (preferred && getCatalogProvider(catalog, preferred)) {
    for (const family of FAMILY_PRIORITY) {
      const match = pickWithinProvider(catalog, preferred, family);
      if (match) return match;
    }
    const ranked = rankSmallModelCandidates(catalogModels(catalog, preferred));
    if (ranked[0]?.id) {
      return { providerID: preferred, modelID: ranked[0].id, source: 'keyword-scan' };
    }
    if (typeof preferredModelID === 'string' && preferredModelID) {
      return { providerID: preferred, modelID: preferredModelID, source: 'session-model' };
    }
  }

  // No session context (or its provider is not connected): scan the other
  // connected providers by family priority, then keyword+cost default.
  const otherProviders = Object.keys(catalog || {}).filter((providerID) => providerID !== preferred);
  for (const family of FAMILY_PRIORITY) {
    for (const providerID of otherProviders) {
      const match = pickWithinProvider(catalog, providerID, family);
      if (match) return match;
    }
  }

  return pickKeywordDefault(catalog, otherProviders);
}
