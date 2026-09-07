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

export type LynxSessionShareResult =
  | { status: 'ok'; shareUrl: string | null }
  | { status: 'no-runtime' }
  | { status: 'failed'; error: string; httpStatus: number };

const parseShareUrl = (payload: unknown): string | null => {
  if (!payload || typeof payload !== 'object') return null;
  const root = payload as Record<string, unknown>;
  const record = root.data && typeof root.data === 'object'
    ? root.data as Record<string, unknown>
    : root;
  const share = record.share;
  if (!share || typeof share !== 'object') return null;
  const url = (share as Record<string, unknown>).url;
  return typeof url === 'string' && url.trim() ? url.trim() : null;
};

/** Cap/OpenCode `POST /session/:id/share`. Never fake-success. */
export async function shareLynxSession(
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  input: { sessionId: string; directory?: string | null },
): Promise<LynxSessionShareResult> {
  if (!runtimeFetch) return { status: 'no-runtime' };
  try {
    const sessionId = ensureId(input.sessionId);
    const response = await runtimeFetch(
      `/session/${encodeURIComponent(sessionId)}/share${directoryQuery(input.directory)}`,
      { method: 'POST' },
    );
    if (response.status === 0) return { status: 'no-runtime' };
    if (!response.ok) {
      return {
        status: 'failed',
        error: `session.share failed (${response.status})`,
        httpStatus: response.status,
      };
    }
    const payload = await response.json().catch(() => null);
    return { status: 'ok', shareUrl: parseShareUrl(payload) };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
      httpStatus: 0,
    };
  }
}

/** Cap/OpenCode `DELETE /session/:id/share`. Never fake-success. */
export async function unshareLynxSession(
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  input: { sessionId: string; directory?: string | null },
): Promise<LynxSessionMutationResult> {
  if (!runtimeFetch) return { status: 'no-runtime' };
  try {
    const sessionId = ensureId(input.sessionId);
    const response = await runtimeFetch(
      `/session/${encodeURIComponent(sessionId)}/share${directoryQuery(input.directory)}`,
      { method: 'DELETE' },
    );
    if (response.status === 0) return { status: 'no-runtime' };
    if (!response.ok) {
      return {
        status: 'failed',
        error: `session.unshare failed (${response.status})`,
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

/** Best-effort read of share URL via GET `/session/:id` (OpenCode Session.share). */
export async function fetchLynxSessionShareUrl(
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  input: { sessionId: string; directory?: string | null },
): Promise<LynxSessionShareResult> {
  if (!runtimeFetch) return { status: 'no-runtime' };
  try {
    const sessionId = ensureId(input.sessionId);
    const response = await runtimeFetch(
      `/session/${encodeURIComponent(sessionId)}${directoryQuery(input.directory)}`,
      { method: 'GET' },
    );
    if (response.status === 0) return { status: 'no-runtime' };
    if (!response.ok) {
      return {
        status: 'failed',
        error: `session.get failed (${response.status})`,
        httpStatus: response.status,
      };
    }
    const payload = await response.json().catch(() => null);
    return { status: 'ok', shareUrl: parseShareUrl(payload) };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
      httpStatus: 0,
    };
  }
}

export type LynxCopyTextResult =
  | { status: 'ok'; method: 'clipboard' }
  | { status: 'unavailable'; error: string };

/** Honest clipboard copy — Lynx has no Cap clipboard plugin; navigator may be absent. */
export async function copyLynxText(text: string): Promise<LynxCopyTextResult> {
  const value = text.trim();
  if (!value) return { status: 'unavailable', error: 'empty text' };
  const nav = typeof globalThis !== 'undefined'
    ? (globalThis as { navigator?: { clipboard?: { writeText?: (v: string) => Promise<void> } } }).navigator
    : undefined;
  if (nav?.clipboard?.writeText) {
    try {
      await nav.clipboard.writeText(value);
      return { status: 'ok', method: 'clipboard' };
    } catch (error) {
      return {
        status: 'unavailable',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return { status: 'unavailable', error: 'clipboard unavailable on this host' };
}
