/**
 * Cap composer `/` `@` agent/model chrome catalogs.
 * Loads against real Cap list endpoints — never invents empty success.
 */
import type { LynxRuntimeFetch } from '../runtime/fetch';
import {
  loadAgentsCatalog,
  loadCommandsCatalog,
  loadMagicPromptsCatalog,
  type LynxCatalogItem,
  type LynxCatalogLoadResult,
} from '../settings/catalogs';

export type LynxComposerTrigger = 'slash' | 'mention' | 'model' | 'none';

export type LynxComposerCatalogKind = 'commands' | 'agents' | 'models' | 'magic-prompts';

export type LynxComposerSuggestion = {
  id: string;
  title: string;
  subtitle?: string;
  kind: LynxComposerCatalogKind;
  /** Insert token: `/name` or `@name` */
  insertText: string;
};

export type LynxComposerCatalogBundle = {
  commands: LynxCatalogLoadResult;
  agents: LynxCatalogLoadResult;
  magicPrompts: LynxCatalogLoadResult;
  models: LynxCatalogLoadResult;
};

const toSuggestions = (
  result: LynxCatalogLoadResult,
  kind: LynxComposerCatalogKind,
  prefix: '/' | '@' | '',
): LynxComposerSuggestion[] => {
  if (result.status !== 'ok') return [];
  return result.items.map((item: LynxCatalogItem) => ({
    id: `${kind}:${item.id}`,
    title: item.title,
    subtitle: item.subtitle,
    kind,
    insertText: prefix ? `${prefix}${item.title.replace(/^\//, '')}` : item.id,
  }));
};

/** Detect Cap-style composer trigger from draft text (caret at end). */
export const detectLynxComposerTrigger = (draft: string): {
  trigger: LynxComposerTrigger;
  query: string;
} => {
  const match = draft.match(/(?:^|\s)([/@])([^\s]*)$/);
  if (!match) return { trigger: 'none', query: '' };
  const token = match[1];
  const query = match[2] ?? '';
  if (token === '/') return { trigger: 'slash', query };
  if (token === '@') return { trigger: 'mention', query };
  return { trigger: 'none', query: '' };
};

export const filterLynxComposerSuggestions = (
  suggestions: LynxComposerSuggestion[],
  query: string,
): LynxComposerSuggestion[] => {
  const q = query.trim().toLowerCase();
  if (!q) return suggestions.slice(0, 24);
  return suggestions
    .filter((item) => (
      item.title.toLowerCase().includes(q)
      || item.id.toLowerCase().includes(q)
      || (item.subtitle?.toLowerCase().includes(q) ?? false)
    ))
    .slice(0, 24);
};

/**
 * Load Cap composer catalogs in parallel.
 * Models come from `/api/config/providers` (same as context usage).
 */
export const loadLynxComposerCatalogs = async (
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  options?: { directory?: string | null; signal?: AbortSignal },
): Promise<LynxComposerCatalogBundle> => {
  if (!runtimeFetch) {
    const missing: LynxCatalogLoadResult = { status: 'no-runtime' };
    return {
      commands: missing,
      agents: missing,
      magicPrompts: missing,
      models: missing,
    };
  }

  const [commands, agents, magicPrompts, modelsResult] = await Promise.all([
    loadCommandsCatalog(runtimeFetch, options),
    loadAgentsCatalog(runtimeFetch, options),
    loadMagicPromptsCatalog(runtimeFetch, options),
    loadComposerModels(runtimeFetch, options),
  ]);

  return {
    commands,
    agents,
    magicPrompts,
    models: modelsResult,
  };
};

const loadComposerModels = async (
  runtimeFetch: LynxRuntimeFetch,
  options?: { directory?: string | null; signal?: AbortSignal },
): Promise<LynxCatalogLoadResult> => {
  try {
    const directory = options?.directory?.trim();
    const query = directory ? `?directory=${encodeURIComponent(directory)}` : '';
    const response = await runtimeFetch(`/api/config/providers${query}`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...(directory ? { 'x-opencode-directory': directory } : {}),
      },
      signal: options?.signal,
    });
    if (response.status === 0) return { status: 'no-runtime' };
    if (response.status === 404 || response.status === 501) return { status: 'unsupported' };
    if (!response.ok) {
      return {
        status: 'failed',
        error: new Error(`providers failed (${response.status})`),
        httpStatus: response.status,
      };
    }
    const payload = await response.json();
    const providers = Array.isArray(payload)
      ? payload
      : payload && typeof payload === 'object' && Array.isArray((payload as { providers?: unknown }).providers)
        ? (payload as { providers: unknown[] }).providers
        : [];
    const items: LynxCatalogItem[] = [];
    for (const provider of providers) {
      if (!provider || typeof provider !== 'object') continue;
      const record = provider as Record<string, unknown>;
      const providerID = typeof record.id === 'string'
        ? record.id
        : typeof record.providerID === 'string'
          ? record.providerID
          : '';
      if (!providerID) continue;
      const modelsRaw = record.models;
      const models = Array.isArray(modelsRaw)
        ? modelsRaw
        : modelsRaw && typeof modelsRaw === 'object'
          ? Object.values(modelsRaw as Record<string, unknown>)
          : [];
      for (const model of models) {
        if (!model || typeof model !== 'object') continue;
        const modelRecord = model as Record<string, unknown>;
        const modelID = typeof modelRecord.id === 'string'
          ? modelRecord.id
          : typeof modelRecord.modelID === 'string'
            ? modelRecord.modelID
            : '';
        if (!modelID) continue;
        items.push({
          id: `${providerID}/${modelID}`,
          title: modelID,
          subtitle: providerID,
        });
      }
    }
    return { status: 'ok', items };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
};

export const suggestionsForTrigger = (
  bundle: LynxComposerCatalogBundle,
  trigger: LynxComposerTrigger,
  query: string,
): LynxComposerSuggestion[] => {
  if (trigger === 'slash') {
    const slash = [
      ...toSuggestions(bundle.commands, 'commands', '/'),
      ...toSuggestions(bundle.magicPrompts, 'magic-prompts', '/'),
    ];
    return filterLynxComposerSuggestions(slash, query);
  }
  if (trigger === 'mention') {
    return filterLynxComposerSuggestions(
      toSuggestions(bundle.agents, 'agents', '@'),
      query,
    );
  }
  if (trigger === 'model') {
    return filterLynxComposerSuggestions(
      toSuggestions(bundle.models, 'models', ''),
      query,
    );
  }
  return [];
};

/** Apply a suggestion into the draft (replace trailing trigger token). */
export const applyLynxComposerSuggestion = (
  draft: string,
  suggestion: LynxComposerSuggestion,
): string => {
  const replaced = draft.replace(/(?:^|\s)([/@])([^\s]*)$/, (full, _token: string) => {
    const leadingSpace = full.startsWith(' ') || full.startsWith('\n') ? full[0] : '';
    return `${leadingSpace}${suggestion.insertText} `;
  });
  return replaced === draft ? `${draft}${suggestion.insertText} ` : replaced;
};
