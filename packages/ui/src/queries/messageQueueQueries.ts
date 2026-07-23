import { useInfiniteQuery, useQuery, type InfiniteData, type QueryClient } from '@tanstack/react-query';
import { fetchMessageQueueScope, fetchMessageQueueServerStatus, fetchMessageQueueSnapshot, type MessageQueueScope, type MessageQueueServerStatus, type MessageQueueSnapshot } from '@/lib/message-queue-server';
import { queryClient, queryKeys } from '@/lib/queryRuntime';
import { getRuntimeTransportIdentity } from '@/lib/runtime-switch';

const PAGE_SIZE = 8;
const snapshotKey = (transport = getRuntimeTransportIdentity()) => queryKeys.messageQueue.snapshot(transport);
const statusKey = (transport = getRuntimeTransportIdentity()) => queryKeys.messageQueue.status(transport);
const scopeKey = (scopeID: string, revision: number, transport = getRuntimeTransportIdentity()) => queryKeys.messageQueue.scope(scopeID, revision, transport);

export const messageQueueStatusQueryOptions = (transport = getRuntimeTransportIdentity()) => ({
  queryKey: statusKey(transport), queryFn: ({ signal }: { signal: AbortSignal }) => fetchMessageQueueServerStatus(signal), retry: false, staleTime: 30_000,
});
export const messageQueueSnapshotQueryOptions = (transport = getRuntimeTransportIdentity()) => ({
  queryKey: snapshotKey(transport), queryFn: ({ signal }: { signal: AbortSignal }) => fetchMessageQueueSnapshot(signal), staleTime: 5_000,
});
export const messageQueueScopeQueryOptions = (scopeID: string, revision: number, transport = getRuntimeTransportIdentity()) => ({
  queryKey: scopeKey(scopeID, revision, transport),
  queryFn: ({ signal, pageParam }: { signal: AbortSignal; pageParam: number }) => fetchMessageQueueScope(scopeID, { offset: pageParam, limit: PAGE_SIZE, expectedRevision: revision, signal }),
  initialPageParam: 0,
  getNextPageParam: (page: MessageQueueScope) => page.nextOffset,
  staleTime: 5_000,
});
export const useMessageQueueStatusQuery = (enabled = true) => useQuery({ ...messageQueueStatusQueryOptions(), enabled });
export const useMessageQueueSnapshotQuery = (enabled = true) => useQuery({ ...messageQueueSnapshotQueryOptions(), enabled });
export const useMessageQueueScopeQuery = (scopeID: string, revision: number, enabled = true) => useInfiniteQuery({ ...messageQueueScopeQueryOptions(scopeID, revision), enabled: enabled && Boolean(scopeID) });
export const readMessageQueueStatus = (client: Pick<QueryClient, 'getQueryData'> = queryClient, transport = getRuntimeTransportIdentity()): MessageQueueServerStatus | undefined => client.getQueryData(statusKey(transport));
export const readMessageQueueSnapshot = (client: Pick<QueryClient, 'getQueryData'> = queryClient, transport = getRuntimeTransportIdentity()): MessageQueueSnapshot | undefined => client.getQueryData(snapshotKey(transport));
/** Shared pull for status: concurrent callers share one in-flight Query fetch and honor staleTime. */
export const ensureMessageQueueStatus = (client: Pick<QueryClient, 'fetchQuery'> = queryClient, transport = getRuntimeTransportIdentity()): Promise<MessageQueueServerStatus> => client.fetchQuery(messageQueueStatusQueryOptions(transport));
/** Shared pull for snapshot catalog: concurrent runtime/cutover/worktree callers coalesce. */
export const ensureMessageQueueSnapshot = (client: Pick<QueryClient, 'fetchQuery'> = queryClient, transport = getRuntimeTransportIdentity()): Promise<MessageQueueSnapshot> => client.fetchQuery(messageQueueSnapshotQueryOptions(transport));
export const refreshMessageQueueStatus = async (client: Pick<QueryClient, 'fetchQuery'> = queryClient, transport = getRuntimeTransportIdentity()): Promise<MessageQueueServerStatus> => client.fetchQuery({ ...messageQueueStatusQueryOptions(transport), staleTime: 0 });
export const refreshMessageQueueSnapshot = async (client: Pick<QueryClient, 'fetchQuery'> = queryClient, transport = getRuntimeTransportIdentity()): Promise<MessageQueueSnapshot> => client.fetchQuery({ ...messageQueueSnapshotQueryOptions(transport), staleTime: 0 });
export const replaceMessageQueueScope = (client: Pick<QueryClient, 'setQueryData'>, scope: MessageQueueScope, transport = getRuntimeTransportIdentity()): void => {
  client.setQueryData<InfiniteData<MessageQueueScope, number>>(scopeKey(scope.scopeID, scope.revision, transport), { pages: [scope], pageParams: [0] });
};
export const replaceMessageQueueStatus = (client: Pick<QueryClient, 'setQueryData'>, status: MessageQueueServerStatus, transport = getRuntimeTransportIdentity()): void => {
  client.setQueryData(statusKey(transport), status);
};
export const replaceMessageQueueSnapshot = (client: Pick<QueryClient, 'setQueryData'>, snapshot: MessageQueueSnapshot, transport = getRuntimeTransportIdentity()): void => {
  client.setQueryData(snapshotKey(transport), snapshot);
};
export const readMessageQueueScope = (client: Pick<QueryClient, 'getQueryData'>, scopeID: string, revision: number, transport = getRuntimeTransportIdentity()): MessageQueueScope | undefined => {
  const data = client.getQueryData<InfiniteData<MessageQueueScope, number>>(scopeKey(scopeID, revision, transport));
  if (!data?.pages.length) return undefined;
  const first = data.pages[0];
  if (!first) return undefined;
  const items = data.pages.flatMap((page) => page.items);
  return items.length === first.itemCount && data.pages.every((page) => page.revision === first.revision) ? { ...first, items, nextOffset: undefined } : undefined;
};
export const clearMessageQueueScopes = (client: Pick<QueryClient, 'removeQueries'>, transport = getRuntimeTransportIdentity()): void => client.removeQueries({ queryKey: [transport, 'messageQueue', 'scope'], exact: false });
export const clearMessageQueueScope = (client: Pick<QueryClient, 'removeQueries'>, scopeID: string, transport = getRuntimeTransportIdentity()): void => client.removeQueries({ queryKey: [transport, 'messageQueue', 'scope', scopeID], exact: false });
export const invalidateMessageQueueScope = (client: Pick<QueryClient, 'invalidateQueries'>, scopeID: string, transport = getRuntimeTransportIdentity()): Promise<void> => client.invalidateQueries({ queryKey: [transport, 'messageQueue', 'scope', scopeID], exact: false });
