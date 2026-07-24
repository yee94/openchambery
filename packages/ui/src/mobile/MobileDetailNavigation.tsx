import type { ReactNode } from 'react';

import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';

export type MobileDetailNavigationProps = {
  title: ReactNode;
  backAriaLabel: string;
  onBack?: () => void;
  backDisabled?: boolean;
  trailing?: ReactNode;
  sticky?: boolean;
  className?: string;
  contentClassName?: string;
};

/** Shared safe-area navigation for mobile secondary pages. */
export function MobileDetailNavigation({
  title,
  backAriaLabel,
  onBack,
  backDisabled = false,
  trailing,
  sticky = false,
  className,
  contentClassName,
}: MobileDetailNavigationProps) {
  return (
    <header
      className={cn(
        'oc-mobile-detail-navigation relative shrink-0 pt-[max(0.25rem,var(--oc-safe-area-top,0px))]',
        sticky && 'oc-mobile-detail-navigation-sticky',
        className,
      )}
    >
      <div
        className={cn(
          'oc-mobile-detail-navigation-content grid grid-cols-[2.75rem_minmax(0,1fr)_2.75rem] items-center gap-1 px-2',
          contentClassName,
        )}
      >
        {onBack ? (
          <button
            type="button"
            className="oc-mobile-detail-action inline-flex size-10 min-h-10 min-w-10 items-center justify-center justify-self-start p-2 text-muted-foreground hover:bg-interactive-hover/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)] disabled:opacity-50"
            onClick={onBack}
            disabled={backDisabled}
            aria-label={backAriaLabel}
          >
            <Icon name="arrow-left-s" className="size-5" />
          </button>
        ) : <span aria-hidden="true" />}

        <div className="oc-mobile-detail-title w-full max-w-72 min-w-0 justify-self-center truncate px-1 typography-ui-label font-medium text-foreground">
          {title}
        </div>

        <div className="flex min-w-0 items-center justify-end">
          {trailing}
        </div>
      </div>
    </header>
  );
}
