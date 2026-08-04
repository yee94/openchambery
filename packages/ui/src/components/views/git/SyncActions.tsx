import React from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Icon } from "@/components/icon/Icon";
import type { GitRemote } from '@/lib/gitApi';
import { useI18n } from '@/lib/i18n';

type SyncAction = 'fetch' | 'pull' | 'push' | 'sync' | null;

interface SyncActionsProps {
  syncAction: SyncAction;
  remotes: GitRemote[];
  onSync: (remote: GitRemote) => void;
  disabled: boolean;
  aheadCount?: number;
  behindCount?: number;
  trackingRemoteName?: string;
  hasUncommittedChanges?: boolean;
}

export const SyncActions: React.FC<SyncActionsProps> = ({
  syncAction,
  remotes = [],
  onSync,
  disabled,
  aheadCount = 0,
  behindCount = 0,
  trackingRemoteName,
  hasUncommittedChanges = false,
}) => {
  const { t } = useI18n();
  const trackingRemote = remotes.find((remote) => remote.name === trackingRemoteName) ?? remotes[0];
  const blocksRebaseSync = behindCount > 0 && hasUncommittedChanges;
  const isPrimaryDisabled = disabled || syncAction !== null || !trackingRemote || blocksRebaseSync;
  const hasKnownSyncWork = aheadCount > 0 || behindCount > 0;
  const tooltipLabel = blocksRebaseSync
    ? t('gitView.sync.commitOrStashTooltip')
    : trackingRemote
    ? hasKnownSyncWork
      ? t('gitView.sync.syncChangesTooltip', { ahead: aheadCount, behind: behindCount })
      : t('gitView.sync.syncChanges')
    : t('gitView.sync.noRemoteTooltip');

  const handleSync = () => {
    if (!trackingRemote) {
      return;
    }
    onSync(trackingRemote);
  };

  return (
    <Tooltip delayDuration={hasKnownSyncWork ? 0 : undefined}>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={handleSync}
          disabled={isPrimaryDisabled}
          className="inline-flex h-6 w-fit shrink-0 items-center justify-center gap-1 rounded px-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)] disabled:cursor-not-allowed disabled:opacity-50"
          aria-label={
            hasKnownSyncWork
              ? t('gitView.sync.syncChangesTooltip', { ahead: aheadCount, behind: behindCount })
              : t('gitView.sync.syncChanges')
          }
        >
          <span className="relative flex size-3.5 shrink-0">
            {syncAction === 'sync' ? (
              <Icon name="loader-4" className="size-3.5 animate-spin" />
            ) : (
              <Icon name="refresh" className="size-3.5" />
            )}
            {hasKnownSyncWork ? (
              <span
                aria-hidden="true"
                className="absolute -right-0.5 top-0 size-1 rounded-full bg-[var(--status-error)] ring-1 ring-[var(--surface-background)]"
              />
            ) : null}
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={8}>{tooltipLabel}</TooltipContent>
    </Tooltip>
  );
};
