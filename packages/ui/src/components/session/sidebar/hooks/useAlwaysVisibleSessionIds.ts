import React from 'react';

import { useGlobalSessionStatusStore } from '@/sync/global-session-status';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useAllSessionStatuses } from '@/sync/sync-context';

const EMPTY_STRING_SET: ReadonlySet<string> = new Set();
const EMPTY_STATUS_BY_ID = new Map<string, { status: 'busy' | 'retry'; directory: string }>();

/**
 * Collect busy/retry session ids from live statuses, plus fallback global-status
 * entries that are not already covered by a live child-store status.
 */
export function collectRunningSessionIds(
  liveStatuses: Record<string, { type: string }>,
  fallbackStatusById: ReadonlyMap<string, unknown>,
): Set<string> {
  const ids = new Set<string>();
  for (const [sessionId, status] of Object.entries(liveStatuses)) {
    if (status.type === 'busy' || status.type === 'retry') ids.add(sessionId);
  }
  for (const sessionId of fallbackStatusById.keys()) {
    if (liveStatuses[sessionId] === undefined) ids.add(sessionId);
  }
  return ids;
}

/** Running ∪ optional current viewing session. */
export function mergeAlwaysVisibleSessionIds(
  runningSessionIds: ReadonlySet<string>,
  currentSessionId: string | null | undefined,
): ReadonlySet<string> {
  if (!currentSessionId) return runningSessionIds;
  if (runningSessionIds.has(currentSessionId)) return runningSessionIds;
  const ids = new Set(runningSessionIds);
  ids.add(currentSessionId);
  return ids;
}

type RunningOptions = {
  enabled?: boolean;
};

type AlwaysVisibleOptions = RunningOptions & {
  /** Include the current viewing session (default true). */
  includeCurrentSession?: boolean;
};

export function useRunningSessionIds(options?: RunningOptions): ReadonlySet<string> {
  const enabled = options?.enabled ?? true;
  const liveSessionStatuses = useAllSessionStatuses({ enabled });
  const fallbackSessionStatuses = useGlobalSessionStatusStore((state) =>
    enabled ? state.statusById : EMPTY_STATUS_BY_ID,
  );

  return React.useMemo(() => {
    if (!enabled) {
      return EMPTY_STRING_SET;
    }
    return collectRunningSessionIds(liveSessionStatuses, fallbackSessionStatuses);
  }, [enabled, fallbackSessionStatuses, liveSessionStatuses]);
}

/**
 * Viewing + running sessions stay in the visible window of already-loaded
 * lists (does not fetch more sessions from the server).
 */
export function useAlwaysVisibleSessionIds(options?: AlwaysVisibleOptions): ReadonlySet<string> {
  const includeCurrentSession = options?.includeCurrentSession ?? true;
  const runningSessionIds = useRunningSessionIds(options);
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);

  return React.useMemo(() => {
    if (!includeCurrentSession) return runningSessionIds;
    return mergeAlwaysVisibleSessionIds(runningSessionIds, currentSessionId);
  }, [currentSessionId, includeCurrentSession, runningSessionIds]);
}
