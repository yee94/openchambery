import {
  resolveGlobalSessionDirectory,
  useGlobalSessionsStore,
} from '@/stores/useGlobalSessionsStore';
import { lookupSessionIndexById } from '@/lib/session-index-api';
import { opencodeClient } from '@/lib/opencode/client';
import type { Session } from '@opencode-ai/sdk/v2';

export type SessionLookupResult = {
  sessionId: string;
  directory: string;
  session?: Session | null;
  /** true when found in in-memory lists (seed or authoritative), without waiting for hasLoaded */
  fromCache: boolean;
  source: 'memory' | 'session-index' | 'session-get';
};

/**
 * Locate a session by id from the global session index lists.
 * Does **not** require `hasLoaded` — seed/cache rows are enough to start loading.
 * Returns null when the id is absent from both active and archived lists.
 */
export function findSessionById(sessionId: string): SessionLookupResult | null {
  if (!sessionId || sessionId.trim().length === 0) return null;

  const state = useGlobalSessionsStore.getState();
  const session =
    state.activeSessions.find((candidate) => candidate.id === sessionId)
    ?? state.archivedSessions.find((candidate) => candidate.id === sessionId)
    ?? null;

  if (!session) return null;

  const directory = resolveGlobalSessionDirectory(session);
  if (!directory) return null;

  return {
    sessionId,
    directory,
    session,
    fromCache: !state.hasLoaded,
    source: 'memory',
  };
}

/**
 * Resolve directory for a route session id as soon as any list entry exists.
 * Prefer this over gating solely on `hasLoaded` for deep-link open.
 */
export function resolveSessionDirectoryForRoute(sessionId: string): string | null {
  return findSessionById(sessionId)?.directory ?? null;
}

const inflightById = new Map<string, Promise<SessionLookupResult | null>>();

/**
 * Full deep-link resolution:
 * 1. memory lists (sync)
 * 2. GET /api/openchamber/session-index/session/:id
 * 3. optional OpenCode session.get with current directory (last resort)
 *
 * Concurrent callers for the same id share one in-flight promise.
 */
export async function resolveSessionForRoute(
  sessionId: string,
  options?: { signal?: AbortSignal; trySessionGet?: boolean },
): Promise<SessionLookupResult | null> {
  const id = sessionId.trim();
  if (!id) return null;

  const memory = findSessionById(id);
  if (memory) return memory;

  const existing = inflightById.get(id);
  if (existing) return existing;

  const flight = (async (): Promise<SessionLookupResult | null> => {
    // Re-check memory after await scheduling (index may have hydrated).
    const again = findSessionById(id);
    if (again) return again;

    const hit = await lookupSessionIndexById(id, { signal: options?.signal });
    if (hit?.directory) {
      return {
        sessionId: hit.id,
        directory: hit.directory,
        session: null,
        fromCache: false,
        source: 'session-index',
      };
    }

    if (options?.trySessionGet === false) return null;

    // Last resort: session.get under current OpenCode directory (may fail if
    // the session lives elsewhere — caller surfaces the error).
    try {
      const session = await opencodeClient.getSession(id);
      const directory =
        (typeof session.directory === 'string' && session.directory.trim())
        || (typeof (session as { project?: { worktree?: string } }).project?.worktree === 'string'
          ? (session as { project?: { worktree?: string } }).project!.worktree!.trim()
          : '')
        || null;
      if (!directory) return null;
      return {
        sessionId: id,
        directory,
        session,
        fromCache: false,
        source: 'session-get',
      };
    } catch {
      return null;
    }
  })();

  const shared = flight.finally(() => {
    if (inflightById.get(id) === shared) inflightById.delete(id);
  });
  inflightById.set(id, shared);
  return shared;
}
