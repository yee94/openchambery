import { queryClient } from '@/lib/queryRuntime';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import type { SettingsBootstrap, SettingsBootstrapPatch } from './settingsBootstrapDto';
import { parseSettingsBootstrap, parseSettingsBootstrapPatch } from './settingsBootstrapParser';

class SettingsBootstrapRequestError extends Error {
  constructor(readonly status: number) {
    super(`Settings bootstrap request failed (${status})`);
    this.name = 'SettingsBootstrapRequestError';
  }
}

const settingsBootstrapQueryKey = (transport = getRuntimeTransportIdentity()) =>
  [transport, 'settings', 'bootstrap'] as const;

export const settingsBootstrapQueryOptions = (transport = getRuntimeTransportIdentity()) => ({
  queryKey: settingsBootstrapQueryKey(transport),
  queryFn: async ({ signal }: { signal: AbortSignal }): Promise<SettingsBootstrap> => {
    const response = await runtimeFetch('/api/config/settings/bootstrap', {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal,
    });
    if (!response.ok) {
      throw new SettingsBootstrapRequestError(response.status);
    }
    return parseSettingsBootstrap(await response.json());
  },
  retry: (failureCount: number, error: unknown) => (
    !(error instanceof SettingsBootstrapRequestError && (error.status === 404 || error.status === 501))
    && failureCount < 1
  ),
  staleTime: Infinity,
  gcTime: Infinity,
});

export const ensureSettingsBootstrapQuery = (transport = getRuntimeTransportIdentity()): Promise<SettingsBootstrap> =>
  queryClient.fetchQuery(settingsBootstrapQueryOptions(transport));

export const readSettingsBootstrapSnapshot = (transport = getRuntimeTransportIdentity()): SettingsBootstrap | undefined =>
  queryClient.getQueryData<SettingsBootstrap>(settingsBootstrapQueryKey(transport));

export const patchSettingsBootstrapSnapshot = (
  patch: SettingsBootstrapPatch,
  transport = getRuntimeTransportIdentity(),
): SettingsBootstrap => {
  const validatedPatch = parseSettingsBootstrapPatch(patch);
  const key = settingsBootstrapQueryKey(transport);
  const previous = queryClient.getQueryData<SettingsBootstrap>(key);
  const next = parseSettingsBootstrap({ schemaVersion: 1, ...previous, ...validatedPatch });
  queryClient.setQueryData(key, next);
  return next;
};
