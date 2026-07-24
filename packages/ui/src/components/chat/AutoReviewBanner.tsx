import React, { memo } from 'react';

import { Icon } from '@/components/icon/Icon';
import { BusyDots } from '@/components/chat/message/parts/BusyDots';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useAutoReviewStore } from '@/stores/useAutoReviewStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { cn } from '@/lib/utils';

export const AutoReviewBanner = memo(() => {
  const { t } = useI18n();
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const run = useAutoReviewStore(React.useCallback((state) => {
    if (!currentSessionId) return null;
    const run = state.runsByOriginalSessionID[currentSessionId] ?? null;
    return run?.runtimeKey === getRuntimeKey() ? run : null;
  }, [currentSessionId]));
  const stopRun = useAutoReviewStore((state) => state.stopRun);
  const openContextPanelTab = useUIStore((state) => state.openContextPanelTab);
  const isMobile = useUIStore((state) => state.isMobile);

  if (!currentSessionId || !run || run.status !== 'running') {
    return null;
  }

  const statusLabel = run.phase === 'waiting_for_reviewer'
    ? t('chat.autoReview.status.waitingForReviewer')
    : t('chat.autoReview.status.waitingForImplementer');

  const handleOpenReviewSession = () => {
    openContextPanelTab(run.directory, {
      mode: 'chat',
      dedupeKey: `session:${run.reviewSessionID}`,
      label: t('chat.autoReview.reviewSessionLabel'),
      readOnly: true,
    });
  };

  return (
    <div className={cn('w-full px-1', isMobile ? 'pb-1 text-xs' : 'pb-2')}>
      <div className={cn(
        'border border-border/60 bg-[var(--surface-elevated)] text-[var(--surface-elevated-foreground)] shadow-sm dark:shadow-none overflow-hidden',
        isMobile ? 'rounded-lg' : 'rounded-xl',
      )}>
        <div className={cn(
          'flex w-full items-center text-left',
          isMobile ? 'gap-1.5 px-2 py-1' : 'gap-2 px-3 py-2',
        )}>
          <Icon name="loader-4" className={cn('animate-spin text-muted-foreground', isMobile ? 'size-3.5' : 'size-4')} aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <span className="typography-ui-label font-medium text-foreground">
              {t('chat.autoReview.title')}
              <BusyDots />
            </span>
            <div className="typography-meta text-muted-foreground">
              {statusLabel}
            </div>
          </div>
          <Button
            type="button"
            variant="secondary"
            size="xs"
            onClick={handleOpenReviewSession}
          >
            {t('chat.autoReview.actions.open')}
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="xs"
            onClick={() => stopRun(currentSessionId)}
          >
            {t('chat.autoReview.actions.stop')}
          </Button>
        </div>
      </div>
    </div>
  );
});

AutoReviewBanner.displayName = 'AutoReviewBanner';
