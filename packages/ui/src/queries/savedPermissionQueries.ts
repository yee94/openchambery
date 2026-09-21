import { useSyncExternalStore } from 'react';
import { queryOptions, useQuery, type QueryClient } from '@tanstack/react-query';
import { getRuntimeGeneration, getRuntimeTransportIdentity, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { deletePermissionSaved, listPermissionSaved, resolvePermissionSavedProject, type PermissionSavedInfo } from '@/sync/permission-saved-api';

// Saved permissions are pull state. Both stages retain their captured runtime
// and directory; only the authoritative project ID enables the rule list.
type RuntimeScope = { transport: string; generation: number; directory: string };
export type SavedPermissionScope = RuntimeScope & { projectID: string };

function assertCurrent(scope: RuntimeScope) {
  if (scope.transport !== getRuntimeTransportIdentity() || scope.generation !== getRuntimeGeneration()) {
    throw new Error('Saved permission runtime changed');
  }
}

export const savedPermissionProjectQueryOptions = (scope: RuntimeScope) => queryOptions({
  queryKey: [scope.transport, scope.generation, 'saved-permission-project', scope.directory] as const,
  queryFn: async ({ signal }) => {
    assertCurrent(scope);
    const id = await resolvePermissionSavedProject(scope.directory, signal);
    assertCurrent(scope);
    return id;
  },
  retry: false,
});

export const savedPermissionListQueryOptions = (scope: SavedPermissionScope) => queryOptions({
  queryKey: [scope.transport, scope.generation, 'saved-permissions', scope.directory, scope.projectID] as const,
  queryFn: async ({ signal }) => {
    assertCurrent(scope);
    if (!scope.directory || !scope.projectID) throw new Error('Saved permission scope required');
    const items = await listPermissionSaved({ projectID: scope.projectID, signal });
    assertCurrent(scope);
    return items;
  },
  retry: false,
});

export function useSavedPermissionsQuery(directory: string) {
  const generation = useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeGeneration, getRuntimeGeneration);
  const runtime = { transport: getRuntimeTransportIdentity(), generation, directory: directory.trim() };
  const project = useQuery({ ...savedPermissionProjectQueryOptions(runtime), enabled: Boolean(runtime.directory) });
  const scope = { ...runtime, projectID: project.data ?? '' };
  const list = useQuery({
    ...savedPermissionListQueryOptions(scope),
    enabled: Boolean(runtime.directory && project.data) && !project.isError,
  });
  return { project, list, scope };
}

export async function deleteSavedPermissionQuery(client: QueryClient, scope: SavedPermissionScope, id: string) {
  assertCurrent(scope);
  const queryKey = savedPermissionListQueryOptions(scope).queryKey;
  const items = client.getQueryData(queryKey);
  if (!items?.some((item) => item.id === id && item.projectID === scope.projectID)) {
    throw new Error('Saved permission is outside the captured scope');
  }
  // Dispatch before yielding so runtimeFetch binds the active endpoint now.
  await deletePermissionSaved({ id });
  if (scope.transport !== getRuntimeTransportIdentity() || scope.generation !== getRuntimeGeneration()) return;
  await client.cancelQueries({ queryKey, exact: true });
  if (scope.transport !== getRuntimeTransportIdentity() || scope.generation !== getRuntimeGeneration()) return;
  client.setQueryData<PermissionSavedInfo[]>(queryKey, (current) => current?.filter((item) => item.id !== id));
}
