import { queryOptions } from '@tanstack/react-query';

import { opencodeClient } from '@/lib/opencode/client';
import { queryKeys } from '@/lib/queryRuntime';

export type WorkStatusChildTitle = {
  id: string;
  title?: string;
};

type ListWorkStatusChildren = (input: {
  directory: string;
  sessionID: string;
  signal: AbortSignal;
}) => Promise<WorkStatusChildTitle[]>;

const listWorkStatusChildren: ListWorkStatusChildren = async ({ directory, sessionID, signal }) => {
  const response = await opencodeClient.getScopedSdkClient(directory).session.list(
    { directory, parentID: sessionID, limit: 200 },
    { signal },
  );
  if (!Array.isArray(response?.data)) {
    throw new Error('session.list children returned no data');
  }
  return response.data.flatMap((info) => {
    if (!info?.id) return [];
    const title = typeof info.title === 'string' ? info.title : undefined;
    return [{ id: info.id, title }];
  });
};

/**
 * Child session titles for the work-status column. OpenCode keeps these off
 * the live directory catalog, so the panel reads them here instead of the
 * sidebar list. A missing payload is a failure, not an empty child set.
 */
export const workStatusChildrenQueryOptions = (
  directory: string,
  sessionID: string,
  options: { transport?: string; listChildren?: ListWorkStatusChildren } = {},
) => {
  const listChildren = options.listChildren ?? listWorkStatusChildren;
  return queryOptions({
    queryKey: queryKeys.workStatusChildren.list(directory, sessionID, options.transport),
    enabled: Boolean(directory && sessionID),
    queryFn: ({ signal }) => listChildren({ directory, sessionID, signal }),
    staleTime: 5_000,
    refetchInterval: 10_000,
  });
};
