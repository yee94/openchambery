/**
 * Cap MobileDeleteWorktreeDialog / NewWorktreeDialog helpers for Lynx.
 * Pure portable TS — archive linked sessions + dirty probe via Cap git status.
 * Remote-branch delete stays deferred (separate Cap deleteRemoteBranch API; no Lynx helper yet).
 */
import { loadLynxGitStatus } from '../chat/changesSurface';
import type { LynxRuntimeFetch } from '../runtime/fetch';
import { archiveLynxSession } from './sessionActions';

export type LynxWorktreeLinkedSession = {
  id: string;
  directory?: string | null;
};

const normalizePath = (value?: string | null): string => {
  const raw = (value || '').trim().replace(/\\/g, '/');
  if (!raw) return '';
  if (raw === '/') return '/';
  return raw.replace(/\/+$/, '');
};

/** Cap MobileDeleteWorktreeDialog linked-session filter by directory. */
export function collectLynxWorktreeLinkedSessions(
  worktreePath: string,
  sessions: LynxWorktreeLinkedSession[],
): LynxWorktreeLinkedSession[] {
  const target = normalizePath(worktreePath);
  if (!target) return [];
  const seen = new Set<string>();
  const out: LynxWorktreeLinkedSession[] = [];
  for (const session of sessions) {
    const id = session.id.trim();
    if (!id || seen.has(id)) continue;
    if (normalizePath(session.directory) !== target) continue;
    seen.add(id);
    out.push({ id, directory: session.directory ?? null });
  }
  return out;
}

export type LynxArchiveWorktreeSessionsResult =
  | { status: 'ok'; archivedIds: string[] }
  | { status: 'no-runtime' }
  | { status: 'partial'; archivedIds: string[]; failedIds: string[]; error: string }
  | { status: 'failed'; archivedIds: string[]; failedIds: string[]; error: string };

/** Cap archiveSessions spirit — archive each linked session before worktree remove. */
export async function archiveLynxWorktreeLinkedSessions(
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  sessions: LynxWorktreeLinkedSession[],
): Promise<LynxArchiveWorktreeSessionsResult> {
  if (!runtimeFetch) return { status: 'no-runtime' };
  if (sessions.length === 0) return { status: 'ok', archivedIds: [] };
  const archivedIds: string[] = [];
  const failedIds: string[] = [];
  let lastError = '';
  for (const session of sessions) {
    const result = await archiveLynxSession(runtimeFetch, {
      sessionId: session.id,
      directory: session.directory,
    });
    if (result.status === 'ok') {
      archivedIds.push(session.id);
      continue;
    }
    if (result.status === 'no-runtime') {
      failedIds.push(session.id);
      return archivedIds.length > 0
        ? {
          status: 'partial',
          archivedIds,
          failedIds: [...failedIds, ...sessions.slice(sessions.indexOf(session) + 1).map((s) => s.id)],
          error: 'no-runtime',
        }
        : { status: 'no-runtime' };
    }
    failedIds.push(session.id);
    lastError = result.error;
  }
  if (failedIds.length === 0) return { status: 'ok', archivedIds };
  if (archivedIds.length > 0) {
    return { status: 'partial', archivedIds, failedIds, error: lastError || 'archive partial failure' };
  }
  return { status: 'failed', archivedIds, failedIds, error: lastError || 'archive failed' };
}

export type LynxWorktreeDirtyProbeResult =
  | { status: 'ok'; isDirty: boolean }
  | { status: 'no-runtime' }
  | { status: 'unavailable' }
  | { status: 'failed'; error: string };

/**
 * Cap getWorktreeStatus spirit via existing Lynx `loadLynxGitStatus`
 * (Cap GET `/api/git/status?directory=`). Dirty = any change entries.
 */
export async function probeLynxWorktreeDirty(
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  worktreeDirectory: string,
): Promise<LynxWorktreeDirtyProbeResult> {
  const result = await loadLynxGitStatus(runtimeFetch, worktreeDirectory, { mode: 'light' });
  if (result.status === 'no-runtime') return { status: 'no-runtime' };
  if (result.status === 'no-directory') return { status: 'unavailable' };
  if (result.status === 'failed') {
    // Cap falls back silently; Lynx omits dirty warning rather than inventing clean/dirty.
    return { status: 'unavailable' };
  }
  return { status: 'ok', isDirty: result.entries.length > 0 };
}

export const lynxWorktreeHasBranch = (branch?: string | null): boolean =>
  typeof branch === 'string' && branch.trim().length > 0;
