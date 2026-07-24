import type { ReactNode } from 'react';

import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

import { MobileTabPageHeader } from '../MobileTabPageHeader';

export type MobileScheduledTabProps = {
  children?: ReactNode;
  content?: ReactNode;
  className?: string;
  contentClassName?: string;
};

/** Page-shaped host for scheduled-task workspace content. */
export function MobileScheduledTab({
  children,
  content,
  className,
  contentClassName,
}: MobileScheduledTabProps) {
  const { t } = useI18n();

  return (
    <div className={cn('flex h-full min-h-[70dvh] flex-col', className)}>
      <MobileTabPageHeader title={t('sessions.scheduledTasks.dialog.title')} />
      <div
        className={cn(
          'min-h-0 flex-1 overflow-hidden rounded-[26px] border border-border/50 bg-[color:color-mix(in_srgb,var(--surface-elevated)_72%,transparent)] shadow-[0_16px_44px_color-mix(in_srgb,var(--surface-foreground)_7%,transparent)] backdrop-blur-xl supports-[corner-shape:squircle]:rounded-[64px]',
          contentClassName,
        )}
      >
        {children ?? content}
      </div>
    </div>
  );
}
