import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useStore, type StoreApi } from 'zustand';
import { useDirectoryStore } from '@/sync/sync-context';
import type { DirectoryStore } from '@/sync/child-store';
import { useTranscriptProjection } from '@/sync/transcript-repository-observers';
import { workStatusChildrenQueryOptions, type WorkStatusChildTitle } from './workStatusChildrenQuery';
import {
  mergeWorkStatusSubagents,
  projectTranscriptSubagents,
  transcriptSubagentsEqual,
  type TranscriptSubagentFace,
  type WorkStatusChildSession,
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

const childCatalogKey = (
  sessions: ReadonlyArray<{ id?: string; title?: string; parentID?: string | null }>,
  sessionId: string,
): string => {
  const rows: string[] = [];
  for (const session of sessions) {
    if (!session.id || session.parentID !== sessionId) continue;
    rows.push(`${session.id}\u0001${session.title ?? ''}`);
  }
  return rows.join('\u0002');
};

const childrenFromCatalogKey = (key: string): WorkStatusChildTitle[] => {
  if (!key) return [];
  return key.split('\u0002').map((row) => {
    const split = row.indexOf('\u0001');
    return { id: row.slice(0, split), title: row.slice(split + 1) };
  });
};

const mergeChildTitles = (
  catalog: readonly WorkStatusChildTitle[],
  listed: readonly WorkStatusChildTitle[] | undefined,
  busyIds: ReadonlySet<string>,
): WorkStatusChildSession[] => {
  const byId = new Map<string, WorkStatusChildSession>();
  for (const child of catalog) {
    if (!child.id) continue;
    byId.set(child.id, { id: child.id, title: child.title, busy: busyIds.has(child.id) });
  }
  for (const child of listed ?? []) {
    if (!child.id) continue;
    const current = byId.get(child.id);
    const title = child.title?.trim() || current?.title;
    byId.set(child.id, { id: child.id, title, busy: busyIds.has(child.id) });
  }
  return [...byId.values()];
};

/** Subagent faces for the work-status column: transcript task rows plus direct child sessions. */
export const useWorkStatusSubagents = (sessionId: string | null, directory: string | null): WorkStatusSubagent[] => {
  const enabled = Boolean(sessionId && directory);
  const store = useDirectoryStore(directory || undefined, { bootstrap: false });
  const catalogKey = useStore(store, (state) => (
    enabled && sessionId ? childCatalogKey(state.session, sessionId) : ''
  ));
  const listed = useQuery({
    ...workStatusChildrenQueryOptions(directory ?? '', sessionId ?? ''),
    enabled,
  });
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
    return mergeWorkStatusSubagents(
      taskFaces,
      mergeChildTitles(childrenFromCatalogKey(catalogKey), listed.data, busyIds),
      busyIds,
    );
  }, [busyIds, catalogKey, listed.data, sessionId, taskFaces]);
};
