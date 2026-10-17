import { queryClient } from '@/lib/queryRuntime';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import type { DesktopSettings } from '@/lib/desktop';
import { withConfigQueryDeadline } from './configQueryDeadline';

const projectOrderQueryOptions = (transport = getRuntimeTransportIdentity()) => ({
  queryKey: [transport, 'settings', 'project-order'] as const,
  queryFn: ({ signal }: { signal: AbortSignal }) => withConfigQueryDeadline(signal, async (signal) => {
    if (getRuntimeTransportIdentity() !== transport) throw new Error('Project order runtime changed');
    const response = await runtimeFetch('/api/config/settings', { signal });
    if (!response.ok) throw new Error(`Project order request failed (${response.status})`);
    const settings = await response.json();
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)
      || !Array.isArray(settings.projects)
      || settings.projects.some((project: unknown) => !project || typeof project !== 'object'
        || !('path' in project) || typeof project.path !== 'string' || !project.path.trim())) {
      throw new Error('Invalid project order snapshot');
    }
    // Cache only the shared project fields, never the full settings response.
    return {
      projects: settings.projects,
      projectSortOrder: settings.projectSortOrder,
    } as Pick<DesktopSettings, 'projects' | 'projectSortOrder'>;
  }),
  staleTime: 0,
  retry: 1,
});

export const refreshProjectOrderSnapshot = (transport = getRuntimeTransportIdentity()) =>
  queryClient.fetchQuery(projectOrderQueryOptions(transport));
