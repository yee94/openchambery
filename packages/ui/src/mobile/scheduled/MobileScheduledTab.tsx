import type { ReactNode } from 'react';

import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

import { MobileTabPageScaffold } from '../MobileSurface';

export type MobileScheduledTabProps = {
  children?: ReactNode;
  content?: ReactNode;
  className?: string;
  contentClassName?: string;
  showHeader?: boolean;
};

/** Page-shaped host for scheduled-task workspace content. */
export function MobileScheduledTab({
  children,
  content,
  className,
  contentClassName,
  showHeader = true,
}: MobileScheduledTabProps) {
  const { t } = useI18n();

  return (
    <MobileTabPageScaffold
      title={t('sessions.scheduledTasks.dialog.title')}
      className={className}
      surface={false}
      scrollsWithPage
      showHeader={showHeader}
      surfaceClassName={cn('oc-mobile-scheduled-content', contentClassName)}
    >
      {children ?? content}
    </MobileTabPageScaffold>
  );
}
