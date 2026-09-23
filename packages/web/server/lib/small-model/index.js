import fs from 'fs';
import os from 'os';
import path from 'path';
import { readConfigLayers } from '../opencode/shared.js';
import { OpenCode } from '@opencode/client';
import { createChatCompletion } from '../llm/completions.js';
import { createModelCatalogLoader } from './catalog.js';
import { resolveSmallModel, parseModelRef } from './resolve.js';
import { generateCustomSummaryText, listCustomSummaryModels, testCustomSummaryApi } from './custom-api.js';

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
// model (or the call goes to a custom API) a conservative default applies.
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
 *   persistSessionMetadata?: (sessionID: string, patch: object) => Promise<unknown>,
 *   onSystemSessionPersisted?: (input: { sessionID: string, directory: string, metadata: object }) => void,
 * }} dependencies
 */
export function createSmallModelService(dependencies) {
  const buildOpenCodeUrl = dependencies.buildOpenCodeUrl;
  const getOpenCodeAuthHeaders = dependencies.getOpenCodeAuthHeaders;
  const persistSessionMetadata = dependencies.persistSessionMetadata || null;
  const onSystemSessionPersisted = dependencies.onSystemSessionPersisted || null;
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

  // Every OpenCode-backed call shares the Assistant LLM gateway: connected
  // catalog check, then a throwaway-session `session.generate`.
  const generateThroughGateway = async ({ resolved, prompt, system, directory }) => {
    const catalog = await getModelCatalog(directory);
    const clamped = clampPromptToModelLimit({ prompt, catalog, providerID: resolved.providerID, modelID: resolved.modelID });
    const { completion } = await runChatCompletion({
      body: {
        providerID: resolved.providerID,
        modelID: resolved.modelID,
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
          { role: 'user', content: clamped.prompt },
        ],
      },
      buildOpenCodeUrl,
      getOpenCodeAuthHeaders,
      clientFactory: openCodeClient,
      persistSessionMetadata,
      onSystemSessionPersisted,
    });
    const text = completion?.choices?.[0]?.message?.content;
    return {
      text: typeof text === 'string' ? text.trim() : '',
      providerID: resolved.providerID,
      modelID: resolved.modelID,
      source: resolved.source,
      ...(clamped.truncated ? { inputTruncated: true } : {}),
    };
  };

  // Summary AI (commit / session-title): the saved OpenCode model or OpenCode's
  // default through the gateway, or the user's custom OpenAI-compatible API.
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
      const text = await generateCustomSummaryText({
        baseURL: custom.baseURL,
        apiToken: custom.apiToken,
        modelID: custom.modelID,
        prompt: clamped.prompt,
        system: effectiveSystem,
        maxOutputTokens,
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
    return generateThroughGateway({ resolved, prompt, system: effectiveSystem, directory });
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
   * Generates text with the user's small model, resolved server-side from
   * OpenChamber settings, the OpenCode config, and the connected catalog.
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

    const explicit = parseModelRef(model);
    const resolved = explicit
      ? { ...explicit, source: 'request' }
      : resolveSmallModel({
        catalog: await getModelCatalog(directory),
        settingsSmallModel: readSmallModelSettingsOverride(),
        configSmallModel: readConfiguredSmallModel(directory),
        preferredProviderID,
        preferredModelID,
      });

    if (!resolved) {
      throw Object.assign(
        new Error('No small model available — no connected OpenCode provider has a suitable model'),
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

    return generateThroughGateway({
      resolved,
      prompt: prompt.trim(),
      system: typeof system === 'string' && system.trim() ? system.trim() : undefined,
      directory,
    });
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
    return resolveSmallModel({
      catalog: await getModelCatalog(directory),
      settingsSmallModel: readSmallModelSettingsOverride(),
      configSmallModel: readConfiguredSmallModel(directory),
      preferredProviderID,
      preferredModelID,
    });
  }

  return {
    generateSmallModelText,
    testCustomApi,
    listCustomModels,
    describeSmallModel,
  };
}
