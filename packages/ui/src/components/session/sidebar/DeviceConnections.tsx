import { useState } from 'react';
import { Popover } from '@base-ui/react/popover';
import { queryOptions, useQuery } from '@tanstack/react-query';
import { useEvent } from '@reactuses/core';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useI18n } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeTransportIdentity, getRuntimeGeneration } from '@/lib/runtime-switch';
import type { RemoteClientRecord } from '@/lib/api/types';
import { useUIStore } from '@/stores/useUIStore';

const deviceConnectionsQueryOptions = () => queryOptions({
  queryKey: [getRuntimeTransportIdentity(), getRuntimeGeneration(), 'device-connections'],
  queryFn: async ({ signal }) => {
    const response = await runtimeFetch('/api/client-auth/clients', { signal });
    if (!response.ok) throw new Error('Device list unavailable');
    const data = await response.json() as { clients?: RemoteClientRecord[] };
    if (!Array.isArray(data.clients)) throw new Error('Invalid device list');
    if (data.clients.some((client) => typeof client.connected !== 'boolean')) throw new Error('Presence unavailable');
    return data.clients.filter((client) => !client.revokedAt && client.connected && client.clientKind !== 'desktop-local');
  },
  staleTime: 0,
  retry: false,
});

export function DeviceConnections() {
  const { t } = useI18n();
  const { clientAuth } = useRuntimeAPIs();
  const [open, setOpen] = useState(false);
  const query = useQuery({ ...deviceConnectionsQueryOptions(), enabled: open && Boolean(clientAuth), refetchInterval: open ? 5000 : false });
  const createConnection = useEvent(() => {
    setOpen(false);
    const ui = useUIStore.getState();
    ui.setSettingsRemoteInstancesSelectedId(null);
    ui.setSettingsPage('remote-instances');
    useUIStore.setState({ devicePairingRequested: true });
    ui.setSettingsDialogOpen(true);
  });
  if (!clientAuth) return null;

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger openOnHover delay={180} closeDelay={200} render={
        <Button variant="ghost" size="icon" className="group size-7 rounded-md text-foreground/55 hover:bg-interactive-hover hover:text-foreground" aria-label={t('settings.remoteInstances.quick.title')} />
      }>
        <Icon name="devices-connected" className="size-[18px]" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="top" align="start" sideOffset={10} className="z-50">
          <Popover.Popup className="w-72 max-w-[calc(100vw-24px)] origin-[var(--transform-origin)] overflow-hidden rounded-2xl border border-[var(--interactive-border)] bg-[var(--surface-elevated)] text-foreground shadow-lg outline-none transition-[opacity,transform] duration-150 data-[starting-style]:translate-y-1 data-[starting-style]:opacity-0 data-[ending-style]:opacity-0">
            <div className="flex items-center gap-2 px-4 pb-2 pt-4">
              <Popover.Title className="typography-ui-label font-medium">{t('settings.remoteInstances.quick.title')}</Popover.Title>
              {query.data && query.data.length > 0 ? <span className="typography-micro text-muted-foreground tabular-nums">{query.data.length}</span> : null}
            </div>
            <div className="max-h-64 overflow-y-auto px-2 pb-2" aria-live="polite">
              {query.isPending ? <p className="px-2 py-3 typography-meta text-muted-foreground">{t('common.loading')}</p> : null}
              {query.isError ? <p className="px-2 py-3 typography-meta text-muted-foreground">{t('settings.remoteInstances.quick.error')}</p> : null}
              {!query.isError && query.data?.length === 0 ? (
                <div className="flex flex-col items-center px-5 pb-5 pt-6 text-center">
                  <Icon name="devices-connected" className="mb-4 size-16 text-muted-foreground/45" />
                  <p className="typography-ui-label text-foreground">{t('settings.remoteInstances.clientAuth.state.empty')}</p>
                  <p className="mt-2 typography-meta leading-relaxed text-muted-foreground">{t('settings.remoteInstances.quick.emptyHint')}</p>
                </div>
              ) : null}
              {query.data?.map((client) => {
                const platform = client.devicePlatform?.toLowerCase();
                return (
                  <div key={client.id} className="flex items-center gap-3 rounded-xl px-2 py-2.5">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-[var(--surface-muted)] text-muted-foreground">
                      <Icon name={platform === 'ios' ? 'device-ios' : platform === 'android' ? 'device-android' : 'device-desktop'} className="size-5" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate typography-ui-label">{client.label}</p>
                      <p className="mt-0.5 truncate typography-micro text-muted-foreground">
                        {t('desktopHostSwitcher.status.connected')}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="px-3 pb-3 pt-1">
              <Button variant="secondary" size="sm" className="w-full justify-center gap-2 rounded-xl" onClick={createConnection}>
                <Icon name="add" className="size-4" />
                {t('settings.remoteInstances.clientAuth.actions.addDevice')}
              </Button>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
