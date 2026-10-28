import { queryOptions } from '@tanstack/react-query';
import type { OpenCodeClient } from '@yuriai/opencode-gui-client';

export const guiInventoryOptions = (transport: string, client?: OpenCodeClient) => queryOptions({
  queryKey: [transport, 'plugins', 'gui', null, 'inventory'],
  queryFn: async ({ signal }) => {
    const api = client ?? (await import('@/lib/opencode/gui')).createGuiClient(signal);
    return (await api.plugin.list(undefined, { signal })).data;
  },
  staleTime: 5_000,
  retry: 1,
});

export const guiBundleOptions = (transport: string, id: string, client?: OpenCodeClient) => queryOptions({
  queryKey: [transport, 'plugins', 'gui', null, 'bundle', id],
  queryFn: async ({ signal }) => {
    const api = client ?? (await import('@/lib/opencode/gui')).createGuiClient(signal);
    return (await api.plugin.gui({ id }, { signal })).data;
  },
  staleTime: Infinity,
  retry: 1,
});
