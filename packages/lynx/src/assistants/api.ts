import type { LynxRuntimeFetch } from '../runtime/fetch';
import { parseLynxAssistantCapability, parseLynxAssistantDTO, parseLynxAssistantReadPosition, parseLynxAssistantReadResponse, parseLynxAssistantSnapshot, LynxAssistantParseError } from './parse';
import type {
  LynxAssistantCapability,
  LynxAssistantDTO,
  LynxAssistantLoadResult,
  LynxAssistantMode,
  LynxAssistantReadPosition,
  LynxAssistantReadResponse,
  LynxAssistantSnapshot,
} from './types';
import { LYNX_ASSISTANT_MARK_ALL_BATCH_SIZE, lynxAssistantsEligibleForMarkAll } from './unread';

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

/** Cap `AssistantDraft` create/update body (no expectedRevision — that is PATCH-only). */
export type LynxAssistantDraft = {
  enabled: boolean;
  name: string;
  defaultPrompt: string;
  workspacePath: string | null;
  providerID: string;
  modelID: string;
  agent: string | null;
  variant?: string | null;
  mode: LynxAssistantMode;
};

export type LynxAssistantMutationResult =
  | { status: 'ok' }
  | { status: 'no-runtime' }
  | { status: 'failed'; error: Error; httpStatus?: number };

export type LynxAssistantCreateResult =
  | { status: 'ok'; assistant: LynxAssistantDTO }
  | { status: 'no-runtime' }
  | { status: 'failed'; error: Error; httpStatus?: number };

const mutationFailure = async (
  response: { ok: boolean; status: number; json: () => Promise<unknown> },
  label: string,
): Promise<LynxAssistantMutationResult> => {
  if (response.status === 0) return { status: 'no-runtime' };
  let message = `${label} failed (${response.status})`;
  try {
    const payload = await response.json();
    if (payload && typeof payload === 'object' && typeof (payload as { error?: unknown }).error === 'string') {
      message = (payload as { error: string }).error;
    }
  } catch {
    // keep status message
  }
  return { status: 'failed', error: new Error(message), httpStatus: response.status };
};

/**
 * Cap `POST /api/openchamber/assistants`. Never fake-success — no-runtime / HTTP
 * failures stay explicit. Caller must supply required name + providerID + modelID.
 */
export const createLynxAssistant = async (
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  draft: LynxAssistantDraft,
  options?: { signal?: AbortSignal },
): Promise<LynxAssistantCreateResult> => {
  if (!runtimeFetch) return { status: 'no-runtime' };
  try {
    const response = await runtimeFetch('/api/openchamber/assistants', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        enabled: draft.enabled,
        name: draft.name,
        defaultPrompt: draft.defaultPrompt,
        workspacePath: draft.workspacePath,
        providerID: draft.providerID,
        modelID: draft.modelID,
        agent: draft.agent,
        ...(draft.variant !== undefined ? { variant: draft.variant } : {}),
        mode: draft.mode,
      }),
      signal: options?.signal,
    });
    if (response.status === 0) return { status: 'no-runtime' };
    if (!response.ok) {
      const failed = await mutationFailure(response, 'POST /api/openchamber/assistants');
      if (failed.status === 'no-runtime') return { status: 'no-runtime' };
      if (failed.status === 'failed') {
        return {
          status: 'failed',
          error: failed.error,
          httpStatus: failed.httpStatus,
        };
      }
      return {
        status: 'failed',
        error: new Error('POST /api/openchamber/assistants failed'),
      };
    }
    const assistant = parseLynxAssistantDTO(await response.json());
    return { status: 'ok', assistant };
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

/**
 * Cap `PUT /api/openchamber/assistants/settings` `{ enabled, expectedRevision }`.
 * Revision must come from the latest snapshot — never invent success.
 */
export const setLynxAssistantsEnabled = async (
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  input: { enabled: boolean; expectedRevision: number },
  options?: { signal?: AbortSignal },
): Promise<LynxAssistantMutationResult> => {
  if (!runtimeFetch) return { status: 'no-runtime' };
  try {
    const response = await runtimeFetch('/api/openchamber/assistants/settings', {
      method: 'PUT',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        enabled: input.enabled,
        expectedRevision: input.expectedRevision,
      }),
      signal: options?.signal,
    });
    if (response.status === 0) return { status: 'no-runtime' };
    if (!response.ok) return mutationFailure(response, 'PUT /api/openchamber/assistants/settings');
    return { status: 'ok' };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
};

/**
 * Cap `DELETE /api/openchamber/assistants/:id` + `expectedRevision`.
 * Mirrors entityApi assistants delete; kept here for catalog menus + Vitest.
 */
export const deleteLynxAssistant = async (
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  input: { id: string; expectedRevision: number },
  options?: { signal?: AbortSignal },
): Promise<LynxAssistantMutationResult> => {
  if (!runtimeFetch) return { status: 'no-runtime' };
  const id = input.id.trim();
  if (!id) {
    return { status: 'failed', error: new Error('assistant id required') };
  }
  try {
    const response = await runtimeFetch(
      `/api/openchamber/assistants/${encodeURIComponent(id)}`,
      {
        method: 'DELETE',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ expectedRevision: input.expectedRevision }),
        signal: options?.signal,
      },
    );
    if (response.status === 0) return { status: 'no-runtime' };
    if (!response.ok) {
      return mutationFailure(response, `DELETE /api/openchamber/assistants/${id}`);
    }
    return { status: 'ok' };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
};

/**
 * Resolve Cap create defaults (first provider + first model) from
 * `/api/config/providers`. Failure ≠ invented ids — caller surfaces the error.
 */
export const resolveLynxAssistantCreateDefaults = async (
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  options?: { signal?: AbortSignal },
): Promise<
  | { status: 'ok'; providerID: string; modelID: string }
  | { status: 'no-runtime' }
  | { status: 'failed'; error: Error }
> => {
  if (!runtimeFetch) return { status: 'no-runtime' };
  try {
    const response = await runtimeFetch('/api/config/providers', {
      signal: options?.signal,
    });
    if (response.status === 0) return { status: 'no-runtime' };
    if (!response.ok) {
      return {
        status: 'failed',
        error: new Error(`providers failed (${response.status})`),
      };
    }
    const payload = await response.json();
    const providers = Array.isArray(payload)
      ? payload
      : payload && typeof payload === 'object' && Array.isArray((payload as { providers?: unknown }).providers)
        ? (payload as { providers: unknown[] }).providers
        : [];
    for (const provider of providers) {
      if (!provider || typeof provider !== 'object') continue;
      const record = provider as Record<string, unknown>;
      const providerID = typeof record.id === 'string'
        ? record.id
        : typeof record.providerID === 'string'
          ? record.providerID
          : '';
      if (!providerID.trim()) continue;
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
        if (!modelID.trim()) continue;
        return { status: 'ok', providerID: providerID.trim(), modelID: modelID.trim() };
      }
    }
    return {
      status: 'failed',
      error: new Error('no provider/model available for assistant create'),
    };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
};

export type LynxAssistantMarkReadResult =
  | { status: 'ok'; read: LynxAssistantReadResponse; snapshot: LynxAssistantSnapshot | null }
  | { status: 'no-runtime' }
  | { status: 'failed'; error: Error; httpStatus?: number };

export type LynxAssistantMarkAllReadResult =
  | { status: 'ok'; failed: number; snapshot: LynxAssistantSnapshot | null }
  | { status: 'no-runtime' };

const refreshAssistantSnapshot = async (
  runtimeFetch: LynxRuntimeFetch,
  options?: { signal?: AbortSignal },
): Promise<LynxAssistantSnapshot | null> => {
  const refresh = await loadAssistantSnapshot(runtimeFetch, options);
  return refresh.status === 'ok' ? refresh.snapshot : null;
};

/**
 * Cap `POST /api/openchamber/assistants/:id/contact/read` `{ generation, ordinal, messageID }`.
 * Real POST only — no-runtime / HTTP / parse failures stay explicit. Snapshot
 * refresh is best-effort after a confirmed POST; refresh failure does not
 * invent an empty catalog.
 */
export const markLynxAssistantContactRead = async (
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  assistantID: string,
  position: LynxAssistantReadPosition,
  options?: { signal?: AbortSignal; refreshSnapshot?: boolean },
): Promise<LynxAssistantMarkReadResult> => {
  if (!runtimeFetch) return { status: 'no-runtime' };
  const id = assistantID.trim();
  if (!id) {
    return { status: 'failed', error: new Error('assistant id required') };
  }
  try {
    const captured = parseLynxAssistantReadPosition(position);
    const response = await runtimeFetch(
      `/api/openchamber/assistants/${encodeURIComponent(id)}/contact/read`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(captured),
        signal: options?.signal,
      },
    );
    if (response.status === 0) return { status: 'no-runtime' };
    if (!response.ok) {
      const failed = await mutationFailure(response, `POST /api/openchamber/assistants/${id}/contact/read`);
      if (failed.status === 'no-runtime') return { status: 'no-runtime' };
      if (failed.status === 'failed') {
        return { status: 'failed', error: failed.error, httpStatus: failed.httpStatus };
      }
      return { status: 'failed', error: new Error('contact/read failed') };
    }
    const read = parseLynxAssistantReadResponse(await response.json());
    if (read.assistantID !== id) {
      return {
        status: 'failed',
        error: new Error('invalid_assistant_read_response'),
      };
    }
    const shouldRefresh = options?.refreshSnapshot !== false;
    const snapshot = shouldRefresh ? await refreshAssistantSnapshot(runtimeFetch, options) : null;
    return { status: 'ok', read, snapshot };
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

/**
 * Cap `markAllAssistantsRead`: fanout over unread + readTip, batch size 4,
 * return `{ failed }`. Refresh snapshot after. Never fake-success a failed POST.
 */
export const markAllLynxAssistantsRead = async (
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  snapshot: LynxAssistantSnapshot,
  options?: { signal?: AbortSignal },
): Promise<LynxAssistantMarkAllReadResult> => {
  if (!runtimeFetch) return { status: 'no-runtime' };
  const targets = lynxAssistantsEligibleForMarkAll(snapshot);
  const results: PromiseSettledResult<LynxAssistantMarkReadResult>[] = [];
  for (let index = 0; index < targets.length; index += LYNX_ASSISTANT_MARK_ALL_BATCH_SIZE) {
    const batch = targets.slice(index, index + LYNX_ASSISTANT_MARK_ALL_BATCH_SIZE);
    results.push(...await Promise.allSettled(batch.map(async (target) => {
      const outcome = await markLynxAssistantContactRead(runtimeFetch, target.id, target.position, {
        signal: options?.signal,
        refreshSnapshot: false,
      });
      if (outcome.status !== 'ok') {
        throw outcome.status === 'failed'
          ? outcome.error
          : new Error(outcome.status);
      }
      return outcome;
    })));
  }
  const failed = results.filter((result) => result.status === 'rejected').length;
  const nextSnapshot = await refreshAssistantSnapshot(runtimeFetch, options);
  return { status: 'ok', failed, snapshot: nextSnapshot };
};

export type { LynxAssistantSnapshot, LynxAssistantLoadResult };
