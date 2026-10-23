import { useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { hasDesktopInvoke, invokeDesktop, isDesktopShell } from '@/lib/desktop';
import { getRuntimeKey, getRuntimeTransportIdentity, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';

export const sshEditorQueryOptions = (runtimeKey = getRuntimeKey(), transport = getRuntimeTransportIdentity()) => {
  const hostId = runtimeKey.startsWith('host:') ? runtimeKey.slice(5) : null;
  return {
    queryKey: [transport, 'ssh-editor-apps', hostId],
    enabled: isDesktopShell() && hasDesktopInvoke() && hostId !== null,
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      const result = await invokeDesktop<{ appIds: string[] } | null>('desktop_ssh_editor_apps', { hostId });
      signal.throwIfAborted();
      return result ? { hostId: hostId!, appIds: result.appIds } : null;
    },
  };
};

export const useSshEditorQuery = () => {
  const runtimeKey = useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeKey, () => '');
  const transport = useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeTransportIdentity, () => '');
  return useQuery(sshEditorQueryOptions(runtimeKey, transport));
};
