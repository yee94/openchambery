import React from 'react';

import { useSessionUIStore } from '@/sync/session-ui-store';
import { useActiveSessionTreeIds } from '@/sync/sync-context';

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
  return useActiveSessionTreeIds(options?.enabled ?? true);
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
