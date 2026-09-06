import type { LynxRuntimeFetch } from '../runtime/fetch';
import { parseSessionIndexSnapshot } from './parse';
import type { SessionIndexLoadResult, SessionIndexLookupHit, SessionIndexSnapshot } from './types';

const ensureOk = async (response: { ok: boolean; status: number }): Promise<void> => {
  if (response.ok) return;
  throw new Error(`session index request failed (${response.status})`);
};

export const loadSessionIndexSnapshot = async (
  runtimeFetch: LynxRuntimeFetch,
  options?: { signal?: AbortSignal },
): Promise<SessionIndexLoadResult> => {
  try {
    const response = await runtimeFetch('/api/openchamber/session-index', { signal: options?.signal });
    if (response.status === 501) return { status: 'unsupported' };
    await ensureOk(response);
    const payload = await response.json() as Partial<SessionIndexSnapshot> & { available?: boolean };
    const snapshot = parseSessionIndexSnapshot(payload);
    if (!snapshot) {
      return { status: 'failed', error: new Error('session index snapshot unavailable'), previous: null };
    }
    return { status: 'ok', snapshot };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error : new Error(String(error)),
      previous: null,
    };
  }
};

export const lookupSessionIndexById = async (
  runtimeFetch: LynxRuntimeFetch,
  sessionId: string,
  options?: { signal?: AbortSignal },
): Promise<SessionIndexLookupHit | null> => {
  const id = sessionId.trim();
  if (!id) return null;
  try {
    const response = await runtimeFetch(
      `/api/openchamber/session-index/session/${encodeURIComponent(id)}`,
      { signal: options?.signal },
    );
    if (response.status === 404 || response.status === 501) return null;
    await ensureOk(response);
    const payload = await response.json() as {
      available?: boolean;
      session?: { id?: string; directory?: string; title?: string; parentID?: string | null };
    };
    if (payload.available !== true || !payload.session) return null;
    const directory = typeof payload.session.directory === 'string' ? payload.session.directory.trim() : '';
    const sid = typeof payload.session.id === 'string' ? payload.session.id : id;
    if (!directory) return null;
    return {
      id: sid,
      directory,
      title: typeof payload.session.title === 'string' ? payload.session.title : undefined,
      parentID: payload.session.parentID ?? null,
    };
  } catch {
    return null;
  }
};

export const pinSession = async (
  runtimeFetch: LynxRuntimeFetch,
  sessionId: string,
  options?: { signal?: AbortSignal },
): Promise<void> => {
  const id = sessionId.trim();
  if (!id) throw new Error('session index pin requires a session id');
  const response = await runtimeFetch(
    `/api/openchamber/session-index/session/${encodeURIComponent(id)}/pin`,
    { method: 'POST', signal: options?.signal },
  );
  if (response.status === 501) throw new Error('session index pin is unsupported');
  await ensureOk(response);
};

export const unpinSession = async (
  runtimeFetch: LynxRuntimeFetch,
  sessionId: string,
  options?: { signal?: AbortSignal },
): Promise<void> => {
  const id = sessionId.trim();
  if (!id) throw new Error('session index unpin requires a session id');
  const response = await runtimeFetch(
    `/api/openchamber/session-index/session/${encodeURIComponent(id)}/pin`,
    { method: 'DELETE', signal: options?.signal },
  );
  if (response.status === 501) throw new Error('session index unpin is unsupported');
  await ensureOk(response);
};

export const startSessionIndexBackgroundSync = async (
  runtimeFetch: LynxRuntimeFetch,
  directories: string[],
): Promise<SessionIndexSnapshot | null> => {
  const response = await runtimeFetch('/api/openchamber/session-index/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ directories }),
  });
  if (response.status === 501) return null;
  await ensureOk(response);
  return response.json() as Promise<SessionIndexSnapshot>;
};
