import React from 'react';
import { useEvent } from '@reactuses/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { UpdateDialogView } from '@/components/ui/UpdateDialogView';
import { useUIStore } from '@/stores/useUIStore';
import { useI18n } from '@/lib/i18n';
import { getRuntimeGeneration, getRuntimeTransportIdentity, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { hostUpdateQueryOptions, isHostUpdateActive, startHostUpdate, useHostUpdate, type HostUpdateSnapshot, type UpdateChannel } from '@/queries/hostUpdateQueries';
import { toHostUpdateDialogModel } from './hostUpdateDialogModel';

export function ConnectedHostVersionUpdate() {
  const { t } = useI18n();
  const transport = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeTransportIdentity, getRuntimeTransportIdentity);
  const generation = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeGeneration, getRuntimeGeneration);
  return <HostVersionUpdate key={`${transport}:${generation}`} transport={transport} generation={generation} version={t('settings.yuri.about.state.unknown')} />;
}

export function HostVersionUpdate({ version, transport, generation, itemId, channel: requestedChannel }: { version: string; transport: string; generation: number; itemId?: string; channel?: UpdateChannel }) {
  const { t } = useI18n();
  const client = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const channelOverride = useUIStore((state) => state.otaChannelOverride);
  const channel = requestedChannel ?? channelOverride ?? undefined;
  const query = useHostUpdate(transport, generation, channel);
  const snapshot = query.data;
  const operation = snapshot?.operation;
  const active = isHostUpdateActive(operation);
  const mutation = useMutation({
    mutationFn: ({ plan }: { plan: HostUpdateSnapshot; channel: UpdateChannel | undefined }) => startHostUpdate(plan, transport, generation),
    onSuccess: (operation, request) => {
      if (transport !== getRuntimeTransportIdentity() || generation !== getRuntimeGeneration()) return;
      client.setQueryData<HostUpdateSnapshot>(hostUpdateQueryOptions(transport, generation, request.channel).queryKey, (previous) => previous ? { ...previous, operation } : previous);
    },
    onSettled: (_data, _error, request) => {
      if (transport === getRuntimeTransportIdentity() && generation === getRuntimeGeneration()) void client.invalidateQueries({ queryKey: hostUpdateQueryOptions(transport, generation, request.channel).queryKey, exact: true });
    },
  });
  // Remember the task this view watched so its terminal state finishes the bar
  // instead of a persisted old result reappearing as fresh progress.
  const [watchedOperationId, setWatchedOperationId] = React.useState<string | null>(null);
  if (active && operation && operation.id !== watchedOperationId) setWatchedOperationId(operation.id);
  const show = useEvent(() => { setOpen(true); void query.refetch(); });
  // During an active task a 404/timeout is the restart gap, not a capability answer.
  const unsupported = snapshot?.supported === false || (!active && query.error?.message === 'host_update_unsupported');
  const failedCheck = query.isError || Boolean(snapshot?.checkError);
  const mutationError = mutation.isError && mutation.variables?.channel === channel;
  const model = toHostUpdateDialogModel(snapshot, {
    versionFallback: version,
    checking: query.isPending ? 'initial' : query.isFetching ? 'refresh' : false,
    submitting: mutation.isPending,
    failure: unsupported ? 'unsupported' : query.isError && (active || mutationError) ? 'disconnected' : failedCheck || mutationError ? 'check' : null,
    completed: operation?.status === 'succeeded' && operation.id === watchedOperationId,
  }, t);
  const handleAction = useEvent((id: string) => {
    if (id === 'check') void query.refetch();
    if (id === 'confirm' && snapshot?.update) mutation.mutate({ plan: snapshot, channel });
  });
  return <>
    <div className="flex items-center justify-end gap-2" data-settings-item={itemId}>
      <span className="relative typography-ui-label font-mono text-foreground text-right">
        {snapshot?.currentVersion ?? version}
        {snapshot?.update && !active && <span aria-label={t('settings.yuri.about.hostUpdate.available')} className="absolute -right-1.5 -top-0.5 size-1.5 rounded-full bg-[var(--status-error)]" />}
      </span>
      <Button type="button" size="icon" variant="ghost" onClick={show}
        aria-label={t('settings.yuri.about.hostUpdate.title')} title={t('settings.yuri.about.hostUpdate.title')}>
        <Icon name={active || query.isFetching ? 'loader' : snapshot?.update ? 'download' : 'refresh'} className={active || query.isFetching ? 'size-4 animate-spin' : 'size-4'} />
      </Button>
    </div>
    <UpdateDialogView open={open} onOpenChange={setOpen} model={model} onAction={handleAction} />
  </>;
}
