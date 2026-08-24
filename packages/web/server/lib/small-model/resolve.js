import { getCatalogProvider } from './catalog.js';

// Mirrors OpenCode's getSmallModel fallback chain, with OpenChamber's own
// keyword + cheapest-first default when no session/family match applies:
// 1. `small_model` from the merged config layers ("provider/model").
// 2. Family-priority / keyword scan of authenticated providers' catalog models.
// 3. GitHub Copilot's hidden utility models when Copilot is logged in.
const FAMILY_PRIORITY = ['gemini-flash', 'gpt-nano', 'claude-haiku'];
const COPILOT_UTILITY_MODELS = ['gpt-5.4-nano', 'gpt-4.1', 'gpt-4o', 'gpt-4o-mini'];
// The ChatGPT-plan codex backend only accepts a small allowlist of models
// (nano/API-key models are rejected with 400) — this is its cheapest one.
const OPENAI_OAUTH_SMALL_MODEL = 'gpt-5.4-mini';

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

const AUTH_PROVIDER_ALIASES = {
  'github-copilot': ['github-copilot', 'copilot'],
};

export function getAuthEntryForProvider(auth, providerID) {
  const aliases = AUTH_PROVIDER_ALIASES[providerID] || [providerID];
  for (const alias of aliases) {
    const entry = auth?.[alias];
    if (entry && typeof entry === 'object') {
      return entry;
    }
  }
  return null;
}

export function isUsableAuthEntry(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (entry.type === 'api') return typeof entry.key === 'string' && entry.key.length > 0;
  if (entry.type === 'oauth') {
    return (typeof entry.access === 'string' && entry.access.length > 0)
      || (typeof entry.refresh === 'string' && entry.refresh.length > 0);
  }
  if (entry.type === 'wellknown') return typeof entry.token === 'string' && entry.token.length > 0;
  return false;
}

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

// Small-model candidates within ONE provider, by family priority. Copilot and
// ChatGPT-plan OpenAI have fixed small models that never appear in the
// catalog; everyone else is scanned through the catalog families.
// Auth-type constraints for the four minimal hardcoded providers:
// OpenAI OAuth → hardcoded codex-small only; OpenAI API key → catalog families;
// Anthropic/Google require API keys; Copilot supports auth aliases.
const pickWithinProvider = (providerID, auth, catalog, family) => {
  if (providerID === 'openai' && auth.openai?.type === 'oauth') {
    if (!isUsableAuthEntry(auth.openai)) return null;
    return family === 'gpt-nano'
      ? { providerID, modelID: OPENAI_OAUTH_SMALL_MODEL, source: 'codex-small' }
      : null;
  }
  if (providerID === 'github-copilot') {
    if (!isUsableAuthEntry(getAuthEntryForProvider(auth, 'github-copilot'))) return null;
    return family === 'gpt-nano'
      ? { providerID, modelID: COPILOT_UTILITY_MODELS[0], source: 'copilot-utility' }
      : null;
  }
  if (providerID === 'openai') {
    if (auth.openai?.type !== 'api' || !isUsableAuthEntry(auth.openai)) return null;
  }
  if (providerID === 'anthropic') {
    if (auth.anthropic?.type !== 'api' || !isUsableAuthEntry(auth.anthropic)) return null;
  }
  if (providerID === 'google') {
    if (auth.google?.type !== 'api' || !isUsableAuthEntry(auth.google)) return null;
  }
  const provider = getCatalogProvider(catalog, providerID);
  if (!provider || !provider.models || typeof provider.models !== 'object') return null;
  const model = pickByFamily(provider.models, family);
  return model?.id ? { providerID, modelID: model.id, source: 'family-scan' } : null;
};

const pickKeywordDefault = (auth, catalog, excludeProviderID) => {
  /** @type {Array<{ providerID: string, model: object }>} */
  const candidates = [];
  const providerIDs = Object.keys(auth || {}).filter((providerID) => {
    if (providerID === 'copilot') return false;
    if (excludeProviderID && providerID === excludeProviderID) return false;
    return isUsableAuthEntry(getAuthEntryForProvider(auth, providerID));
  });
  // Surface github-copilot when only the `copilot` alias is present.
  if (
    !providerIDs.includes('github-copilot')
    && isUsableAuthEntry(getAuthEntryForProvider(auth, 'github-copilot'))
    && excludeProviderID !== 'github-copilot'
  ) {
    providerIDs.push('github-copilot');
  }

  for (const providerID of providerIDs) {
    if (providerID === 'openai' && auth.openai?.type === 'oauth') continue;
    if (providerID === 'github-copilot') continue;
    if (providerID === 'openai' && (auth.openai?.type !== 'api' || !isUsableAuthEntry(auth.openai))) continue;
    if (providerID === 'anthropic' && (auth.anthropic?.type !== 'api' || !isUsableAuthEntry(auth.anthropic))) continue;
    if (providerID === 'google' && (auth.google?.type !== 'api' || !isUsableAuthEntry(auth.google))) continue;

    const provider = getCatalogProvider(catalog, providerID);
    if (!provider?.models) continue;
    for (const model of rankSmallModelCandidates(provider.models)) {
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

export function resolveSmallModel({ auth, catalog, settingsSmallModel, configSmallModel, preferredProviderID, preferredModelID }) {
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
  if (preferred && isUsableAuthEntry(getAuthEntryForProvider(auth, preferred))) {
    for (const family of FAMILY_PRIORITY) {
      const match = pickWithinProvider(preferred, auth, catalog, family);
      if (match) return match;
    }
    const preferredCatalog = getCatalogProvider(catalog, preferred);
    if (preferredCatalog?.models) {
      const ranked = rankSmallModelCandidates(preferredCatalog.models);
      if (ranked[0]?.id) {
        return { providerID: preferred, modelID: ranked[0].id, source: 'keyword-scan' };
      }
    }
    if (typeof preferredModelID === 'string' && preferredModelID) {
      return { providerID: preferred, modelID: preferredModelID, source: 'session-model' };
    }
  }

  // No session context (or its provider has no usable login): scan all
  // authenticated providers by family priority, then keyword+cost default.
  const authedProviders = Object.keys(auth || {}).filter((providerID) =>
    providerID !== preferred && isUsableAuthEntry(auth[providerID]));

  for (const family of FAMILY_PRIORITY) {
    for (const providerID of authedProviders) {
      const match = pickWithinProvider(providerID, auth, catalog, family);
      if (match) return match;
    }
  }

  const keywordDefault = pickKeywordDefault(auth, catalog, preferred);
  if (keywordDefault) return keywordDefault;

  // Copilot's utility fallback for legacy auth aliases the loop above missed.
  const copilotEntry = getAuthEntryForProvider(auth, 'github-copilot');
  if (isUsableAuthEntry(copilotEntry)) {
    return {
      providerID: 'github-copilot',
      modelID: COPILOT_UTILITY_MODELS[0],
      source: 'copilot-utility',
    };
  }

  return null;
}
