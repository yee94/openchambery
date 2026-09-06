import type { LynxRuntimeFetch } from '../runtime/fetch';
import { parseLynxAssistantCapability, parseLynxAssistantSnapshot, LynxAssistantParseError } from './parse';
import type {
  LynxAssistantCapability,
  LynxAssistantLoadResult,
  LynxAssistantSnapshot,
} from './types';

const ensureOk = async (response: { ok: boolean; status: number }): Promise<void> => {
  if (response.ok) return;
  throw new Error(`assistants request failed (${response.status})`);
};

/**
 * Cap `GET /api/openchamber/assistants/snapshot`. Failure ≠ empty catalog.
 * Missing runtime returns `no-runtime` (never fake-success empty).
 */
export const loadAssistantSnapshot = async (
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  options?: { signal?: AbortSignal },
): Promise<LynxAssistantLoadResult> => {
  if (!runtimeFetch) return { status: 'no-runtime' };
  try {
    const response = await runtimeFetch('/api/openchamber/assistants/snapshot', {
      signal: options?.signal,
    });
    if (response.status === 0) return { status: 'no-runtime' };
    if (response.status === 501) return { status: 'unsupported' };
    await ensureOk(response);
    const payload = await response.json();
    return { status: 'ok', snapshot: parseLynxAssistantSnapshot(payload) };
  } catch (error) {
    if (error instanceof LynxAssistantParseError) {
      return { status: 'failed', error };
    }
    return {
      status: 'failed',
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
};

export const loadAssistantCapability = async (
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  options?: { signal?: AbortSignal },
): Promise<LynxAssistantCapability | null> => {
  if (!runtimeFetch) return null;
  try {
    const response = await runtimeFetch('/api/openchamber/assistants/capability', {
      signal: options?.signal,
    });
    if (!response.ok) return null;
    return parseLynxAssistantCapability(await response.json());
  } catch {
    return null;
  }
};

export type LynxAssistantSessionBinding = {
  sessionID: string | null;
  directory: string;
  sessionGeneration: number;
};

/**
 * Cap `POST …/session/ensure`. Labeled stub caller must not invent a session id
 * when this fails — surface the error instead.
 */
export const ensureAssistantSession = async (
  runtimeFetch: LynxRuntimeFetch,
  assistantId: string,
  options?: { signal?: AbortSignal },
): Promise<LynxAssistantSessionBinding> => {
  const id = assistantId.trim();
  if (!id) throw new Error('assistant id required');
  const response = await runtimeFetch(
    `/api/openchamber/assistants/${encodeURIComponent(id)}/session/ensure`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: options?.signal,
    },
  );
  await ensureOk(response);
  const payload = await response.json() as {
    sessionID?: string | null;
    directory?: string;
    sessionGeneration?: number;
  };
  if (typeof payload.directory !== 'string' || typeof payload.sessionGeneration !== 'number') {
    throw new Error('invalid assistant session binding');
  }
  return {
    sessionID: typeof payload.sessionID === 'string' ? payload.sessionID : payload.sessionID ?? null,
    directory: payload.directory,
    sessionGeneration: payload.sessionGeneration,
  };
};

export type { LynxAssistantSnapshot, LynxAssistantLoadResult };
