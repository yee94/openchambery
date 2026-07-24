import type { ReactNode } from 'react';
import { useEvent } from '@reactuses/core';

import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { MobileDetailNavigation } from '@/mobile/MobileDetailNavigation';

export type MobileChatHeaderProps = {
  title: string;
  onBack: () => void;
  onOpenMenu: () => void;
  trailing?: ReactNode;
  className?: string;
};

/** Safe-area-aware navigation bar for the mobile chat page. */
export function MobileChatHeader({
  title,
  onBack,
  onOpenMenu,
  trailing,
  className,
}: MobileChatHeaderProps) {
  const { t } = useI18n();
  const handleBack = useEvent(onBack);
  const handleOpenMenu = useEvent(onOpenMenu);

  return (
    <MobileDetailNavigation
      title={title}
      backAriaLabel={t('header.actions.backAria')}
      onBack={handleBack}
      className={cn('absolute inset-x-0 top-0 z-30', className)}
      trailing={(
        <>
          {trailing}
          <button
            type="button"
            className="oc-mobile-detail-action inline-flex size-10 min-h-10 min-w-10 items-center justify-center p-2 text-muted-foreground hover:bg-interactive-hover/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]"
            aria-label={t('mobile.menu.titleAria')}
            onClick={handleOpenMenu}
          >
            <Icon name="more-2" className="size-5" />
          </button>
        </>
      )}
    />
  );
}
