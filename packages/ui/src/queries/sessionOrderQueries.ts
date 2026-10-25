import React from 'react';
import { replaceEqualDeep, useQuery } from '@tanstack/react-query';
import { queryClient } from '@/lib/queryRuntime';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeGeneration, getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import { subscribeYuriEvents } from '@/lib/yuriEvents';
import { isVSCodeRuntime } from '@/lib/desktop';

export type SessionOrderSnapshot = {
  revision: number;
  sessionOrderByScope: Record<string, string[]>;
  sessionOrderActivityByScope: Record<string, Record<string, number>>;
};
const endpoint = '/api/session-folders/order';
const key = (transport: string) => ['session-order', transport] as const;
const parse = async (response: Response): Promise<SessionOrderSnapshot> => {
  if (!response.ok) throw new Error(`Session order: ${response.status}`);
  const value = await response.json() as SessionOrderSnapshot;
  if (!Number.isFinite(value.revision) || !value.sessionOrderByScope || !value.sessionOrderActivityByScope) {
    throw new Error('Invalid session order snapshot');
  }
  if (!Object.values(value.sessionOrderByScope).every((ids) => Array.isArray(ids) && ids.every((id) => typeof id === 'string'))
    || !Object.values(value.sessionOrderActivityByScope).every((activity) => activity && typeof activity === 'object'
      && !Array.isArray(activity) && Object.values(activity).every((time) => typeof time === 'number' && Number.isFinite(time)))) {
    throw new Error('Invalid session order entries');
  }
  return value;
};
export const sessionOrderQueryOptions = (transport = getRuntimeTransportIdentity()) => ({
  queryKey: key(transport),
  queryFn: async ({ signal }: { signal: AbortSignal }) => parse(await runtimeFetch(endpoint, { signal })),
  staleTime: 0,
  retry: 2,
  refetchOnWindowFocus: true,
  structuralSharing: (oldData: unknown, newData: unknown) => {
    const previous = oldData as SessionOrderSnapshot | undefined;
    const next = newData as SessionOrderSnapshot;
    return previous && previous.revision > next.revision ? previous : replaceEqualDeep(previous, next);
  },
});
export const getSessionOrderSnapshot = () => queryClient.getQueryData<SessionOrderSnapshot>(key(getRuntimeTransportIdentity()));

const writes = new Map<string, Promise<unknown>>();
export const saveSessionOrder = (
  scopeKey: string,
  order: string[],
  activity: Record<string, number>,
  onlyIfAbsent = false,
): Promise<SessionOrderSnapshot> => {
  const transport = getRuntimeTransportIdentity();
  const generation = getRuntimeGeneration();
  const isCurrent = () => transport === getRuntimeTransportIdentity() && generation === getRuntimeGeneration();
  const previous = writes.get(transport) ?? Promise.resolve();
  const write = previous.catch(() => {}).then(async () => {
    if (!isCurrent()) throw new Error('Runtime changed');
    await queryClient.cancelQueries({ queryKey: key(transport), exact: true });
    const snapshot = await parse(await runtimeFetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scopeKey, order, activity, onlyIfAbsent }),
    }));
    if (!isCurrent()) throw new Error('Runtime changed');
    queryClient.setQueryData<SessionOrderSnapshot>(key(transport), (current) => (
      current && current.revision > snapshot.revision ? current : snapshot
    ));
    return snapshot;
  });
  writes.set(transport, write);
  void write.finally(() => {
    if (writes.get(transport) === write) writes.delete(transport);
  }).catch(() => {});
  return write;
};

export const useSessionOrderQuery = () => {
  const transport = getRuntimeTransportIdentity();
  const enabled = !isVSCodeRuntime();
  const query = useQuery({ ...sessionOrderQueryOptions(transport), enabled });
  React.useEffect(() => {
    if (!enabled) return;
    return subscribeYuriEvents((event) => {
      if (transport !== getRuntimeTransportIdentity()) return;
      if (event.type === 'session-order-changed' || event.type === 'event-stream-ready') {
        void queryClient.invalidateQueries({ queryKey: key(transport), exact: true });
      }
    });
  }, [enabled, transport]);
  return query;
};
