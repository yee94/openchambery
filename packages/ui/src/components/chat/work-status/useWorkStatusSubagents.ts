import React from 'react';
import { useStore, type StoreApi } from 'zustand';
import { useAllLiveSessions, useDirectoryStore } from '@/sync/sync-context';
import type { DirectoryStore } from '@/sync/child-store';
import { useTranscriptProjection } from '@/sync/transcript-repository-observers';
import {
  mergeWorkStatusSubagents,
  projectTranscriptSubagents,
  transcriptSubagentsEqual,
  type TranscriptSubagentFace,
  type WorkStatusSubagent,
} from './workStatusSubagents';

const EMPTY_BUSY_SET: ReadonlySet<string> = new Set();

const busySessionKey = (status: DirectoryStore['session_status'] | undefined): string => {
  if (!status) return '';
  const ids: string[] = [];
  for (const id of Object.keys(status)) {
    const type = status[id]?.type;
    if (type === 'busy' || type === 'retry') ids.push(id);
  }
  ids.sort();
  return ids.join('\n');
};

const useBusySessionIds = (store: StoreApi<DirectoryStore>, enabled: boolean): ReadonlySet<string> => {
  const busyKey = useStore(store, (state) => enabled ? busySessionKey(state.session_status) : '');
  return React.useMemo(
    () => (busyKey ? new Set(busyKey.split('\n')) : EMPTY_BUSY_SET),
    [busyKey],
  );
};

/** Subagent faces for the work-status column: transcript task rows plus direct child sessions. */
export const useWorkStatusSubagents = (sessionId: string | null, directory: string | null): WorkStatusSubagent[] => {
  const enabled = Boolean(sessionId && directory);
  const liveSessions = useAllLiveSessions({ enabled: Boolean(sessionId) });
  const store = useDirectoryStore(directory || undefined, { bootstrap: false });
  const taskFaces = useTranscriptProjection<readonly TranscriptSubagentFace[]>(
    sessionId ?? '',
    directory ?? '',
    store,
    projectTranscriptSubagents,
    transcriptSubagentsEqual,
    { enabled },
  );
  const busyIds = useBusySessionIds(store, enabled);
  return React.useMemo(() => {
    if (!sessionId) return [];
    const children = liveSessions
      .filter((session) => session.parentID === sessionId)
      .map((session) => ({
        id: session.id,
        title: session.title,
        busy: busyIds.has(session.id),
      }));
    return mergeWorkStatusSubagents(taskFaces, children, busyIds);
  }, [busyIds, liveSessions, sessionId, taskFaces]);
};
