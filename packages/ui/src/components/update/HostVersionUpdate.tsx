import React from 'react';
import { useEvent } from '@reactuses/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
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
  // The Host omits update plans while busy. Retain only presentation data in
  // this runtime/channel scope; commands still require the authoritative plan.
  const presentationScope = JSON.stringify([transport, generation, channel ?? 'current']);
  const [presentationPlan, setPresentationPlan] = React.useState<{ scope: string; update: NonNullable<HostUpdateSnapshot['update']> } | null>(null);
  if (snapshot?.update && (presentationPlan?.scope !== presentationScope || presentationPlan.update !== snapshot.update)) {
    setPresentationPlan({ scope: presentationScope, update: snapshot.update });
  }
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
  // Only watch tasks shown in this view; historical success must not close a
  // newly opened dialog or notify again on later refreshes.
  const [watchedOperationId, setWatchedOperationId] = React.useState<string | null>(null);
  if (open && active && operation && operation.id !== watchedOperationId) setWatchedOperationId(operation.id);
  const completed = operation?.status === 'succeeded' && operation.id === watchedOperationId;
  const successMessage = t('settings.yuri.about.hostUpdate.status.succeeded');
  React.useEffect(() => {
    if (!completed || query.isError || transport !== getRuntimeTransportIdentity() || generation !== getRuntimeGeneration()) return;
    setWatchedOperationId(null);
    setOpen(false);
    toast.success(successMessage, { id: `host-update:${transport}:${generation}:${watchedOperationId}` });
  }, [completed, query.isError, transport, generation, watchedOperationId, successMessage]);
  const pendingCheck = React.useRef<string | null>(null);
  const currentPresentationScope = useEvent(() => presentationScope);
  const checkForUpdates = useEvent(async () => {
    if (active) {
      setOpen(true);
      void query.refetch({ cancelRefetch: false });
      return;
    }
    if (pendingCheck.current === presentationScope) return;
    const scope = presentationScope;
    pendingCheck.current = scope;
    try {
      const result = await query.refetch({ cancelRefetch: false });
      if (scope !== currentPresentationScope() || transport !== getRuntimeTransportIdentity() || generation !== getRuntimeGeneration()) return;
      if (result.isError || !result.data || result.data.checkError) {
        if (result.error?.message === 'host_update_unsupported') toast.info(t('settings.yuri.about.hostUpdate.unsupported'));
        else toast.error(t('settings.yuri.about.toast.checkFailed'));
        return;
      }
      if (isHostUpdateActive(result.data.operation)) setOpen(true);
      else if (!result.data.supported) toast.info(t('settings.yuri.about.hostUpdate.unsupported'));
      else if (result.data.update) setOpen(true);
      else {
        setOpen(false);
        toast.success(t('settings.yuri.about.toast.latestVersion'));
      }
    } finally {
      if (pendingCheck.current === scope) pendingCheck.current = null;
    }
  });
  // During an active task a 404/timeout is the restart gap, not a capability answer.
  const unsupported = snapshot?.supported === false || (!active && query.error?.message === 'host_update_unsupported');
  const failedCheck = query.isError || Boolean(snapshot?.checkError);
  const mutationError = mutation.isError && mutation.variables?.channel === channel;
  const model = toHostUpdateDialogModel(snapshot, {
    versionFallback: version,
    checking: query.isPending ? 'initial' : query.isFetching ? 'refresh' : false,
    submitting: mutation.isPending,
    failure: unsupported ? 'unsupported' : query.isError && (active || mutationError) ? 'disconnected' : failedCheck || mutationError ? 'check' : null,
    completed,
    updateDetails: presentationPlan?.scope === presentationScope ? presentationPlan.update : undefined,
  }, t);
  const handleAction = useEvent((id: string) => {
    if (id === 'confirm' && snapshot?.update) mutation.mutate({ plan: snapshot, channel });
  });
  return <>
    <div className="flex items-center justify-end gap-2" data-settings-item={itemId}>
      <span className="relative typography-ui-label font-mono text-foreground text-right">
        {snapshot?.currentVersion ?? version}
        {snapshot?.update && !active && <span aria-label={t('settings.yuri.about.hostUpdate.available')} className="absolute -right-1.5 -top-0.5 size-1.5 rounded-full bg-[var(--status-error)]" />}
      </span>
      <Button type="button" size="icon" variant="ghost" onClick={checkForUpdates} disabled={query.isFetching && !active}
        aria-label={t('settings.yuri.about.hostUpdate.title')} title={t('settings.yuri.about.hostUpdate.title')}>
        <Icon name={active || query.isFetching ? 'loader' : snapshot?.update ? 'download' : 'refresh'} className={active || query.isFetching ? 'size-4 animate-spin' : 'size-4'} />
      </Button>
    </div>
    <UpdateDialogView open={open} onOpenChange={setOpen} model={model} onAction={handleAction} />
  </>;
}
