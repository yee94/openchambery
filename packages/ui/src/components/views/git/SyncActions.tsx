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

const COUNT_CHIP_CLASS =
  'inline-flex h-3.5 shrink-0 items-center gap-0.5 typography-micro font-medium leading-none tabular-nums';

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
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={handleSync}
          disabled={isPrimaryDisabled}
          className="inline-flex h-6 shrink-0 items-center justify-center gap-1 rounded px-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)] disabled:cursor-not-allowed disabled:opacity-50"
          aria-label={
            hasKnownSyncWork
              ? t('gitView.sync.syncChangesTooltip', { ahead: aheadCount, behind: behindCount })
              : t('gitView.sync.syncChanges')
          }
        >
          {syncAction === 'sync' ? (
            <Icon name="loader-4" className="size-3.5 shrink-0 animate-spin" />
          ) : (
            <Icon name="refresh" className="size-3.5 shrink-0" />
          )}
          {behindCount > 0 ? (
            <span aria-hidden="true" className={COUNT_CHIP_CLASS} data-sync-direction="behind">
              <Icon name="arrow-down" className="size-3 shrink-0" />
              <span>{behindCount}</span>
            </span>
          ) : null}
          {aheadCount > 0 ? (
            <span aria-hidden="true" className={COUNT_CHIP_CLASS} data-sync-direction="ahead">
              <Icon name="arrow-up" className="size-3 shrink-0" />
              <span>{aheadCount}</span>
            </span>
          ) : null}
        </button>
      </TooltipTrigger>
      <TooltipContent sideOffset={8}>{tooltipLabel}</TooltipContent>
    </Tooltip>
  );
};
