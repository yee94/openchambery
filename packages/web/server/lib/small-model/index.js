import fs from 'fs';
import os from 'os';
import path from 'path';
import { readAuthFile } from '../opencode/auth.js';
import { readConfigLayers } from '../opencode/shared.js';
import { OpenCode } from '@opencode/client';
import { createChatCompletion } from '../llm/completions.js';
import { createModelCatalogLoader } from './catalog.js';
import { resolveSmallModel, parseModelRef, isUsableAuthEntry, getAuthEntryForProvider } from './resolve.js';
import { callSmallModel } from './call.js';
import { generateViaOpenCodeSession, stop as stopOpenCodeSessionTemp } from './opencode-session.js';
import { listCustomSummaryModels, testCustomSummaryApi } from './custom-api.js';

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
    const customModelID = typeof settings.summaryCustomModelID === 'string'
      ? settings.summaryCustomModelID.trim()
      : '';
    const effectiveCustomModelID = customModelID || modelID;
    const baseURL = typeof settings.summaryCustomBaseURL === 'string' ? settings.summaryCustomBaseURL.trim() : '';
    const apiToken = typeof settings.summaryCustomAPIToken === 'string' ? settings.summaryCustomAPIToken.trim() : '';
    return {
      mode,
      providerID,
      modelID,
      custom: baseURL && apiToken && effectiveCustomModelID
        ? { baseURL, apiToken, modelID: effectiveCustomModelID }
        : null,
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

// Dedicated adapters keep the direct wire-format path. Everything else
// (plugin providers, credential-chain, missing api.url, …) goes through a
// temporary OpenCode session so auth/endpoint rewrite stay in the runtime.
const DEDICATED_DIRECT_PROVIDERS = new Set(['openai', 'anthropic', 'google', 'github-copilot']);

// Mirrors pickWithinProvider / callSmallModel auth gates so Settings pickers
// never list dedicated providers that would only fail at dispatch time.
const isCallableDedicatedAuth = (auth, providerID) => {
  if (providerID === 'openai') {
    const entry = auth?.openai;
    return isUsableAuthEntry(entry) && (entry.type === 'api' || entry.type === 'oauth');
  }
  if (providerID === 'anthropic') {
    const entry = auth?.anthropic;
    return entry?.type === 'api' && isUsableAuthEntry(entry);
  }
  if (providerID === 'google') {
    const entry = auth?.google;
    return entry?.type === 'api' && isUsableAuthEntry(entry);
  }
  if (providerID === 'github-copilot') {
    return isUsableAuthEntry(getAuthEntryForProvider(auth, 'github-copilot'));
  }
  return false;
};

const shouldUseDirectAdapter = (providerID, auth) => {
  if (!DEDICATED_DIRECT_PROVIDERS.has(providerID)) return false;
  return isCallableDedicatedAuth(auth, providerID);
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
 * Creates the small-model service bound to an OpenCode catalog loader.
 * Production code obtains the singleton via the server composition root;
 * tests may call this factory with mocks.
 *
 * @param {{
 *   buildOpenCodeUrl: (pathname: string, search?: string) => string,
 *   getOpenCodeAuthHeaders: () => Record<string, string>,
 *   getModelCatalog?: (directory?: string) => Promise<object>,
 *   openCodeClientFactory?: () => object,
 *   createChatCompletion?: typeof createChatCompletion,
 * }} dependencies
 */
export function createSmallModelService(dependencies) {
  const buildOpenCodeUrl = dependencies.buildOpenCodeUrl;
  const getOpenCodeAuthHeaders = dependencies.getOpenCodeAuthHeaders;
  const getModelCatalog = dependencies.getModelCatalog
    || createModelCatalogLoader({
      buildOpenCodeUrl,
      getOpenCodeAuthHeaders,
    }).getModelCatalog;
  const openCodeClient = dependencies.openCodeClientFactory || (() => OpenCode.make({
    baseUrl: buildOpenCodeUrl('/', '').replace(/\/$/, ''),
    headers: getOpenCodeAuthHeaders(),
  }));
  const runChatCompletion = dependencies.createChatCompletion || createChatCompletion;

  // No saved Summary AI model follows OpenCode's own default model.
  const resolveSummaryProviderModel = async (summarySettings, directory) => {
    if (summarySettings?.providerID && summarySettings?.modelID) {
      return { providerID: summarySettings.providerID, modelID: summarySettings.modelID, source: 'summary-provider' };
    }
    let result;
    try {
      result = await openCodeClient().model.default(directory ? { location: { directory } } : undefined);
    } catch (error) {
      throw Object.assign(
        new Error(`OpenCode default model is unavailable (${error?.message || error})`),
        { statusCode: 502 },
      );
    }
    const providerID = typeof result?.data?.providerID === 'string' ? result.data.providerID : '';
    const modelID = typeof result?.data?.id === 'string' ? result.data.id : '';
    if (!providerID || !modelID) {
      throw Object.assign(new Error('No OpenCode default model is configured'), { statusCode: 404 });
    }
    return { providerID, modelID, source: 'summary-default' };
  };

  // Summary AI (commit / session-title) shares the Assistant LLM gateway:
  // connected-catalog check, then OpenCode generate.text. Custom mode keeps
  // its direct OpenAI-compatible call.
  async function generateSummaryText({ prompt, system, maxOutputTokens, directory, purpose }) {
    const summarySettings = readSummarySettings();
    const effectiveSystem = summarySettings?.prompts?.[purpose]
      || (typeof system === 'string' && system.trim() ? system.trim() : undefined);

    if (summarySettings?.mode === 'custom') {
      const custom = summarySettings.custom;
      if (!custom) {
        throw Object.assign(
          new Error('Custom summary API requires a Base URL, model ID, and API token'),
          { statusCode: 400 },
        );
      }
      const clamped = clampPromptToModelLimit({ prompt, catalog: {}, providerID: 'custom', modelID: custom.modelID });
      const text = await callSmallModel({
        auth: {},
        catalog: {},
        workingDirectory: directory,
        providerID: 'custom',
        modelID: custom.modelID,
        prompt: clamped.prompt,
        system: effectiveSystem,
        maxOutputTokens,
        custom,
      });
      return {
        text: text.trim(),
        providerID: 'custom',
        modelID: custom.modelID,
        source: 'summary-custom',
        ...(clamped.truncated ? { inputTruncated: true } : {}),
      };
    }

    const resolved = await resolveSummaryProviderModel(summarySettings, directory);
    const catalog = await getModelCatalog(directory);
    const clamped = clampPromptToModelLimit({ prompt, catalog, providerID: resolved.providerID, modelID: resolved.modelID });
    const { completion } = await runChatCompletion({
      body: {
        providerID: resolved.providerID,
        modelID: resolved.modelID,
        messages: [
          ...(effectiveSystem ? [{ role: 'system', content: effectiveSystem }] : []),
          { role: 'user', content: clamped.prompt },
        ],
      },
      buildOpenCodeUrl,
      getOpenCodeAuthHeaders,
      clientFactory: openCodeClient,
    });
    const text = completion?.choices?.[0]?.message?.content;
    return {
      text: typeof text === 'string' ? text.trim() : '',
      providerID: resolved.providerID,
      modelID: resolved.modelID,
      source: resolved.source,
      ...(clamped.truncated ? { inputTruncated: true } : {}),
    };
  }

  const resolveCustomApiInput = (body = {}) => {
    const summarySettings = readSummarySettings();
    const baseURL = typeof body.baseURL === 'string' && body.baseURL.trim()
      ? body.baseURL.trim()
      : (summarySettings?.custom?.baseURL || '');
    const modelID = typeof body.modelID === 'string' && body.modelID.trim()
      ? body.modelID.trim()
      : (summarySettings?.custom?.modelID || '');
    const apiToken = typeof body.apiToken === 'string' && body.apiToken.trim()
      ? body.apiToken.trim()
      : (summarySettings?.custom?.apiToken || '');
    return { baseURL, modelID, apiToken };
  };

  /**
   * Generates text with the user's small model, resolved and authenticated
   * entirely server-side from the OpenCode config and auth store.
   */
  async function generateSmallModelText({
    prompt,
    system,
    maxOutputTokens,
    model,
    directory,
    preferredProviderID,
    preferredModelID,
    restrictToPreferredProvider = false,
    purpose,
  }) {
    if (typeof prompt !== 'string' || !prompt.trim()) {
      throw Object.assign(new Error('prompt is required'), { statusCode: 400 });
    }

    if (SUMMARY_PURPOSES.has(purpose)) {
      return generateSummaryText({ prompt: prompt.trim(), system, maxOutputTokens, directory, purpose });
    }

    const auth = readAuthFile();
    const catalog = await getModelCatalog(directory);
    const explicit = parseModelRef(model);
    const resolved = explicit
      ? { ...explicit, source: 'request' }
      : resolveSmallModel({
        auth,
        catalog,
        settingsSmallModel: readSmallModelSettingsOverride(),
        configSmallModel: readConfiguredSmallModel(directory),
        preferredProviderID,
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
      && !['settings', 'config', 'request'].includes(resolved.source)
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

    const effectiveSystem = typeof system === 'string' && system.trim() ? system.trim() : undefined;

    let text;
    if (shouldUseDirectAdapter(resolved.providerID, auth)) {
      text = await callSmallModel({
        auth,
        catalog,
        workingDirectory: directory,
        providerID: resolved.providerID,
        modelID: resolved.modelID,
        prompt: clamped.prompt,
        system: effectiveSystem,
        maxOutputTokens,
      });
    } else {
      text = await generateViaOpenCodeSession({
        buildOpenCodeUrl,
        getOpenCodeAuthHeaders,
        providerID: resolved.providerID,
        modelID: resolved.modelID,
        prompt: clamped.prompt,
        system: effectiveSystem,
        purpose: typeof purpose === 'string' && purpose.trim() ? purpose.trim() : 'generate',
        directory,
      });
    }

    return {
      text: text.trim(),
      providerID: resolved.providerID,
      modelID: resolved.modelID,
      source: resolved.source,
      ...(clamped.truncated ? { inputTruncated: true } : {}),
    };
  }

  async function testCustomApi(body) {
    return testCustomSummaryApi(resolveCustomApiInput(body));
  }

  async function listCustomModels(body) {
    const { baseURL, apiToken } = resolveCustomApiInput(body);
    return listCustomSummaryModels({ baseURL, apiToken });
  }

  /**
   * Reports which model would be used, without calling it.
   */
  async function describeSmallModel({ directory, preferredProviderID, preferredModelID } = {}) {
    const auth = readAuthFile();
    const catalog = await getModelCatalog(directory);
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

  return {
    generateSmallModelText,
    testCustomApi,
    listCustomModels,
    describeSmallModel,
    stop: stopOpenCodeSessionTemp,
  };
}
