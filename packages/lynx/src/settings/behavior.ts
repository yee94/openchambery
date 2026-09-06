/**
 * Cap Behavior page helpers — response-style presets + agents.md endpoints.
 * Mirror packages/ui/src/lib/responseStyle.ts + BehaviorPage routes.
 */
import type { LynxRuntimeFetch } from '../runtime/fetch';

export const LYNX_RESPONSE_STYLE_PRESETS = [
  'concise',
  'detailed',
  'mentor',
  'pushback',
  'noFiller',
  'matchEnergy',
  'warmPeer',
] as const;

export type LynxResponseStylePreset = typeof LYNX_RESPONSE_STYLE_PRESETS[number];
export type LynxResponseStyleValue = LynxResponseStylePreset | 'custom';

export const isLynxResponseStylePreset = (value: unknown): value is LynxResponseStylePreset => (
  typeof value === 'string'
  && (LYNX_RESPONSE_STYLE_PRESETS as readonly string[]).includes(value)
);

export const sanitizeLynxResponseStylePreset = (value: unknown): LynxResponseStyleValue => {
  if (value === 'custom') return 'custom';
  return isLynxResponseStylePreset(value) ? value : 'concise';
};

export const LYNX_AGENTS_MD_ENDPOINT = '/api/behavior/agents-md';
export const LYNX_SMALL_MODEL_ENDPOINT = '/api/small-model';

export type LynxAgentsMdLoadResult =
  | { status: 'ok'; content: string; exists: boolean }
  | { status: 'no-runtime' }
  | { status: 'failed'; error: Error; httpStatus?: number };

export type LynxAgentsMdSaveResult =
  | { status: 'ok' }
  | { status: 'no-runtime' }
  | { status: 'failed'; error: Error; httpStatus?: number };

export type LynxSmallModelCapabilityResult =
  | { status: 'ok'; callableModels: Record<string, string[]> }
  | { status: 'no-runtime' }
  | { status: 'failed'; error: Error; httpStatus?: number }
  | { status: 'empty'; callableModels: Record<string, string[]> };

export const loadLynxAgentsMd = async (
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  options?: { signal?: AbortSignal },
): Promise<LynxAgentsMdLoadResult> => {
  if (!runtimeFetch) return { status: 'no-runtime' };
  try {
    const response = await runtimeFetch(LYNX_AGENTS_MD_ENDPOINT, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: options?.signal,
    });
    if (response.status === 0) return { status: 'no-runtime' };
    if (!response.ok) {
      return {
        status: 'failed',
        error: new Error(`agents-md GET failed (${response.status})`),
        httpStatus: response.status,
      };
    }
    const data = await response.json() as { content?: unknown; exists?: unknown };
    if (typeof data?.content !== 'string') {
      return { status: 'failed', error: new Error('Invalid agents-md response') };
    }
    return {
      status: 'ok',
      content: data.content,
      exists: data.exists === true,
    };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
};

export const saveLynxAgentsMd = async (
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  content: string,
  options?: { signal?: AbortSignal },
): Promise<LynxAgentsMdSaveResult> => {
  if (!runtimeFetch) return { status: 'no-runtime' };
  try {
    const normalized = content.length > 0 && !content.endsWith('\n') ? `${content}\n` : content;
    const response = await runtimeFetch(LYNX_AGENTS_MD_ENDPOINT, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ content: normalized }),
      signal: options?.signal,
    });
    if (response.status === 0) return { status: 'no-runtime' };
    if (!response.ok) {
      return {
        status: 'failed',
        error: new Error(`agents-md PUT failed (${response.status})`),
        httpStatus: response.status,
      };
    }
    return { status: 'ok' };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
};

export const loadLynxSmallModelCapabilities = async (
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  options?: { signal?: AbortSignal },
): Promise<LynxSmallModelCapabilityResult> => {
  if (!runtimeFetch) return { status: 'no-runtime' };
  try {
    const response = await runtimeFetch(LYNX_SMALL_MODEL_ENDPOINT, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: options?.signal,
    });
    if (response.status === 0) return { status: 'no-runtime' };
    if (!response.ok) {
      return {
        status: 'failed',
        error: new Error(`small-model GET failed (${response.status})`),
        httpStatus: response.status,
      };
    }
    const payload = await response.json() as { callableModels?: unknown };
    if (!payload?.callableModels || typeof payload.callableModels !== 'object') {
      return {
        status: 'failed',
        error: new Error('Summary provider capabilities unavailable'),
      };
    }
    const callableModels = Object.fromEntries(
      Object.entries(payload.callableModels as Record<string, unknown>)
        .map(([providerID, modelIDs]) => [
          providerID,
          Array.isArray(modelIDs)
            ? modelIDs.filter((id): id is string => typeof id === 'string')
            : [],
        ])
        .filter(([, modelIDs]) => (modelIDs as string[]).length > 0),
    ) as Record<string, string[]>;
    if (Object.keys(callableModels).length === 0) {
      return { status: 'empty', callableModels };
    }
    return { status: 'ok', callableModels };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
};
