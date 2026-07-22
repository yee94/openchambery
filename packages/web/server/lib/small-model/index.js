import fs from 'fs';
import os from 'os';
import path from 'path';
import { readAuthFile } from '../opencode/auth.js';
import { readConfigLayers } from '../opencode/shared.js';
import { getCatalogProvider, getModelCatalog } from './catalog.js';
import { resolveSmallModel, parseModelRef, isUsableAuthEntry, getAuthEntryForProvider } from './resolve.js';
import { callSmallModel } from './call.js';

const OPENCHAMBER_SETTINGS_FILE = path.join(
  process.env.OPENCHAMBER_DATA_DIR
    ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
    : path.join(os.homedir(), '.config', 'openchamber'),
  'settings.json',
);

const SUMMARY_PURPOSES = new Set(['commit', 'session-title']);

const readSummarySettings = () => {
  try {
    const raw = fs.readFileSync(OPENCHAMBER_SETTINGS_FILE, 'utf8');
    const settings = JSON.parse(raw);
    if (!settings || typeof settings !== 'object') return null;
    const mode = settings.summaryModelMode === 'custom' ? 'custom' : 'provider';
    const providerID = typeof settings.summaryProviderID === 'string' ? settings.summaryProviderID.trim() : '';
    const modelID = typeof settings.summaryModelID === 'string' ? settings.summaryModelID.trim() : '';
    const baseURL = typeof settings.summaryCustomBaseURL === 'string' ? settings.summaryCustomBaseURL.trim() : '';
    const apiToken = typeof settings.summaryCustomAPIToken === 'string' ? settings.summaryCustomAPIToken.trim() : '';
    return {
      mode,
      providerID,
      modelID,
      custom: baseURL && apiToken && modelID ? { baseURL, apiToken, modelID } : null,
      prompts: {
        commit: typeof settings.summaryCommitPrompt === 'string' ? settings.summaryCommitPrompt.trim() : '',
        'session-title': typeof settings.summarySessionTitlePrompt === 'string' ? settings.summarySessionTitlePrompt.trim() : '',
      },
    };
  } catch {
    return null;
  }
};

// OpenChamber's own settings: when the user unchecks "use default small model"
// their explicit override outranks every other resolution step.
const readSmallModelSettingsOverride = () => {
  try {
    const raw = fs.readFileSync(OPENCHAMBER_SETTINGS_FILE, 'utf8');
    const settings = JSON.parse(raw);
    if (!settings || typeof settings !== 'object') return null;
    if (settings.smallModelUseDefault !== false) return null;
    const override = typeof settings.smallModelOverride === 'string' ? settings.smallModelOverride.trim() : '';
    return override || null;
  } catch {
    return null;
  }
};

// Rough safety clamp so a huge input never blows the model's context window.
// Token estimate is ~4 chars/token; when the catalog has no limit for the
// model (Copilot/codex utility models are not listed) a conservative default
// applies.
const DEFAULT_CONTEXT_TOKENS = 64_000;
const OUTPUT_RESERVE_TOKENS = 4_000;

const clampPromptToModelLimit = ({ prompt, catalog, providerID, modelID }) => {
  const limit = catalog?.[providerID]?.models?.[modelID]?.limit;
  const contextTokens = Number(limit?.context) > 0 ? Number(limit.context) : DEFAULT_CONTEXT_TOKENS;
  const inputBudgetTokens = Math.max(1_000, contextTokens - OUTPUT_RESERVE_TOKENS);
  const maxChars = inputBudgetTokens * 4;
  if (prompt.length <= maxChars) {
    return { prompt, truncated: false };
  }
  return { prompt: `${prompt.slice(0, maxChars)}…`, truncated: true };
};

const listCallableProviderIDsForState = (auth, catalog) => {
  const ids = new Set(
    Object.keys(auth || {}).filter((providerID) => {
      if (!isUsableAuthEntry(auth[providerID])) return false;
      if (providerID === 'openai' || providerID === 'anthropic' || providerID === 'google') return true;
      const provider = getCatalogProvider(catalog, providerID);
      return typeof provider?.api === 'string' && provider.api.length > 0;
    }),
  );
  if (isUsableAuthEntry(getAuthEntryForProvider(auth, 'github-copilot'))) {
    ids.add('github-copilot');
  }
  return Array.from(ids);
};

const listCallableModelsForState = (auth, catalog) => {
  const result = {};
  for (const providerID of listCallableProviderIDsForState(auth, catalog)) {
    if (providerID === 'openai' && auth.openai?.type === 'oauth') {
      result[providerID] = ['gpt-5.4-mini'];
      continue;
    }
    if (providerID === 'github-copilot') {
      result[providerID] = ['gpt-5.4-nano'];
      continue;
    }
    const provider = getCatalogProvider(catalog, providerID);
    const modelIDs = Object.values(provider?.models || {})
      .map((model) => typeof model?.id === 'string' ? model.id : '')
      .filter(Boolean);
    if (modelIDs.length > 0) {
      result[providerID] = modelIDs;
    }
  }
  return result;
};

const resolveDefaultSummaryModel = (auth, catalog) => {
  const callableModels = listCallableModelsForState(auth, catalog);
  const providerIDs = Object.keys(callableModels);
  const providerID = callableModels.openai ? 'openai' : providerIDs[0];
  const modelID = providerID ? callableModels[providerID]?.[0] : undefined;
  return providerID && modelID
    ? { providerID, modelID, source: 'summary-default' }
    : null;
};

const readConfiguredSmallModel = (workingDirectory) => {
  try {
    const { mergedConfig } = readConfigLayers(workingDirectory);
    const value = mergedConfig?.small_model;
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
};

/**
 * Generates text with the user's small model, resolved and authenticated
 * entirely server-side from the OpenCode config and auth store.
 */
export async function generateSmallModelText({ prompt, system, maxOutputTokens, model, directory, preferredProviderID, preferredModelID, restrictToPreferredProvider = false, purpose }) {
  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw Object.assign(new Error('prompt is required'), { statusCode: 400 });
  }

  const auth = readAuthFile();
  const catalog = await getModelCatalog().catch(() => ({}));
  const summarySettings = SUMMARY_PURPOSES.has(purpose) ? readSummarySettings() : null;
  const summaryPrompt = summarySettings?.prompts?.[purpose];
  const defaultSummaryModel = SUMMARY_PURPOSES.has(purpose)
    ? resolveDefaultSummaryModel(auth, catalog)
    : null;

  const explicit = parseModelRef(model);
  const summaryProvider = summarySettings?.mode === 'provider' && summarySettings.providerID && summarySettings.modelID
    ? {
        providerID: summarySettings.providerID,
        modelID: summarySettings.modelID,
        source: 'summary-provider',
      }
    : summarySettings?.mode !== 'custom'
      ? defaultSummaryModel
      : null;
  const summaryCustom = summarySettings?.mode === 'custom' ? summarySettings.custom : null;
  if (summarySettings?.mode === 'custom' && !summaryCustom) {
    throw Object.assign(
      new Error('Custom summary API requires a Base URL, model ID, and API token'),
      { statusCode: 400 },
    );
  }
  const resolved = summaryCustom
    ? { providerID: 'custom', modelID: summaryCustom.modelID, source: 'summary-custom' }
    : summaryProvider
      ? summaryProvider
      : explicit
        ? { ...explicit, source: 'request' }
        : resolveSmallModel({
          auth,
          catalog,
          settingsSmallModel: readSmallModelSettingsOverride(),
          configSmallModel: readConfiguredSmallModel(directory),
          preferredProviderID: summarySettings?.providerID || preferredProviderID,
          preferredModelID,
        });

  if (!resolved) {
    throw Object.assign(
      new Error('No small model available — no authenticated provider has a suitable model'),
      { statusCode: 404 },
    );
  }

  // Callers with a session context can forbid silently switching providers:
  // an explicit user choice (settings override, opencode config, request
  // model) is always allowed, anything else must stay on the session's
  // provider.
  if (restrictToPreferredProvider
    && !['settings', 'config', 'request', 'summary-provider', 'summary-default', 'summary-custom'].includes(resolved.source)
    && resolved.providerID !== preferredProviderID) {
    throw Object.assign(
      new Error('No small model available within the session provider'),
      { statusCode: 404 },
    );
  }

  const clamped = clampPromptToModelLimit({
    prompt: prompt.trim(),
    catalog,
    providerID: resolved.providerID,
    modelID: resolved.modelID,
  });

  const text = await callSmallModel({
    auth,
    catalog,
    workingDirectory: directory,
    providerID: resolved.providerID,
    modelID: resolved.modelID,
    prompt: clamped.prompt,
    system: summaryPrompt || (typeof system === 'string' && system.trim() ? system.trim() : undefined),
    maxOutputTokens,
    custom: summaryCustom,
  });

  return {
    text: text.trim(),
    providerID: resolved.providerID,
    modelID: resolved.modelID,
    source: resolved.source,
    ...(clamped.truncated ? { inputTruncated: true } : {}),
  };
}

/**
 * Provider ids with a usable OpenCode login — the set the small model can
 * actually call. Used by the settings override picker to hide providers that
 * would only ever fail (e.g. opencode free models without a token).
 */
export async function listCallableProviders() {
  try {
    const auth = readAuthFile();
    const catalog = await getModelCatalog().catch(() => ({}));
    return listCallableProviderIDsForState(auth, catalog);
  } catch {
    return [];
  }
}

export async function listCallableModels() {
  try {
    const auth = readAuthFile();
    const catalog = await getModelCatalog().catch(() => ({}));
    return listCallableModelsForState(auth, catalog);
  } catch {
    return {};
  }
}


/**
 * Reports which model would be used, without calling it.
 */
export async function describeSmallModel({ directory, preferredProviderID, preferredModelID } = {}) {
  const auth = readAuthFile();
  const catalog = await getModelCatalog().catch(() => ({}));
  const resolved = resolveSmallModel({
    auth,
    catalog,
    settingsSmallModel: readSmallModelSettingsOverride(),
    configSmallModel: readConfiguredSmallModel(directory),
    preferredProviderID,
    preferredModelID,
  });
  return resolved;
}
