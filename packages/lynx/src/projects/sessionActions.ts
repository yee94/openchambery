/**
 * Cap session mutation APIs used by Projects swipe / long-press menus.
 * - pin/unpin: OpenChamber session-index (already in session-index/api)
 * - archive / rename: OpenCode PATCH /session/:id
 * - delete: OpenCode DELETE /session/:id
 * Never fake-success on transport/HTTP failure.
 */
import type { LynxRuntimeFetch } from '../runtime/fetch';
import { pinSession, unpinSession } from '../session-index/api';

export type LynxSessionMutationResult =
  | { status: 'ok' }
  | { status: 'no-runtime' }
  | { status: 'failed'; error: string; httpStatus: number };

const directoryQuery = (directory?: string | null): string => {
  const value = directory?.trim();
  return value ? `?directory=${encodeURIComponent(value)}` : '';
};

const ensureId = (sessionId: string): string => {
  const id = sessionId.trim();
  if (!id) throw new Error('session id required');
  return id;
};

export async function archiveLynxSession(
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  input: { sessionId: string; directory?: string | null; archivedAt?: number },
): Promise<LynxSessionMutationResult> {
  if (!runtimeFetch) return { status: 'no-runtime' };
  try {
    const sessionId = ensureId(input.sessionId);
    const archivedAt = input.archivedAt ?? Date.now();
    const response = await runtimeFetch(
      `/session/${encodeURIComponent(sessionId)}${directoryQuery(input.directory)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ time: { archived: archivedAt } }),
      },
    );
    if (response.status === 0) return { status: 'no-runtime' };
    if (!response.ok) {
      return {
        status: 'failed',
        error: `session.archive failed (${response.status})`,
        httpStatus: response.status,
      };
    }
    return { status: 'ok' };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
      httpStatus: 0,
    };
  }
}

export async function renameLynxSession(
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  input: { sessionId: string; title: string; directory?: string | null },
): Promise<LynxSessionMutationResult> {
  if (!runtimeFetch) return { status: 'no-runtime' };
  try {
    const sessionId = ensureId(input.sessionId);
    const title = input.title.trim();
    if (!title) {
      return { status: 'failed', error: 'session title required', httpStatus: 0 };
    }
    const response = await runtimeFetch(
      `/session/${encodeURIComponent(sessionId)}${directoryQuery(input.directory)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      },
    );
    if (response.status === 0) return { status: 'no-runtime' };
    if (!response.ok) {
      return {
        status: 'failed',
        error: `session.rename failed (${response.status})`,
        httpStatus: response.status,
      };
    }
    return { status: 'ok' };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
      httpStatus: 0,
    };
  }
}

export async function deleteLynxSession(
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  input: { sessionId: string; directory?: string | null },
): Promise<LynxSessionMutationResult> {
  if (!runtimeFetch) return { status: 'no-runtime' };
  try {
    const sessionId = ensureId(input.sessionId);
    const response = await runtimeFetch(
      `/session/${encodeURIComponent(sessionId)}${directoryQuery(input.directory)}`,
      { method: 'DELETE' },
    );
    if (response.status === 0) return { status: 'no-runtime' };
    if (!response.ok) {
      return {
        status: 'failed',
        error: `session.delete failed (${response.status})`,
        httpStatus: response.status,
      };
    }
    return { status: 'ok' };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
      httpStatus: 0,
    };
  }
}

export async function toggleLynxSessionPin(
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  input: { sessionId: string; pinned: boolean },
): Promise<LynxSessionMutationResult> {
  if (!runtimeFetch) return { status: 'no-runtime' };
  try {
    if (input.pinned) {
      await unpinSession(runtimeFetch, input.sessionId);
    } else {
      await pinSession(runtimeFetch, input.sessionId);
    }
    return { status: 'ok' };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
      httpStatus: 0,
    };
  }
}

export type LynxCreateSessionResult =
  | { status: 'ok'; sessionId: string; directory: string | null; title?: string }
  | { status: 'no-runtime' }
  | { status: 'failed'; error: string; httpStatus: number };

/** Cap `session.create` → POST /session. Used by draft composer materialization. */
export async function createLynxSession(
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  input?: {
    directory?: string | null;
    title?: string;
    parentID?: string;
  },
): Promise<LynxCreateSessionResult> {
  if (!runtimeFetch) return { status: 'no-runtime' };
  try {
    const query = directoryQuery(input?.directory);
    const body: Record<string, unknown> = {};
    if (input?.title?.trim()) body.title = input.title.trim();
    if (input?.parentID?.trim()) body.parentID = input.parentID.trim();
    const response = await runtimeFetch(`/session${query}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (response.status === 0) return { status: 'no-runtime' };
    if (!response.ok) {
      return {
        status: 'failed',
        error: `session.create failed (${response.status})`,
        httpStatus: response.status,
      };
    }
    const payload = await response.json().catch(() => null) as {
      id?: unknown;
      directory?: unknown;
      title?: unknown;
      data?: { id?: unknown; directory?: unknown; title?: unknown };
    } | null;
    const record = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
    const sessionId = record && typeof record.id === 'string' ? record.id.trim() : '';
    if (!sessionId) {
      return {
        status: 'failed',
        error: 'session.create returned no id',
        httpStatus: response.status,
      };
    }
    const directory = record && typeof record.directory === 'string'
      ? record.directory
      : (input?.directory ?? null);
    const title = record && typeof record.title === 'string' ? record.title : undefined;
    return { status: 'ok', sessionId, directory, title };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
      httpStatus: 0,
    };
  }
}
