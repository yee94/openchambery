import type { ReactNode } from 'react';

import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export type MobileDetailNavigationAction = {
  icon: IconName;
  ariaLabel: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
};

export type MobileDetailNavigationProps = {
  title: ReactNode;
  backAriaLabel: string;
  onBack?: () => void;
  backDisabled?: boolean;
  actions?: readonly MobileDetailNavigationAction[];
  sticky?: boolean;
  overlay?: boolean;
};

/** Shared safe-area navigation for mobile secondary pages. */
export function MobileDetailNavigation({
  title,
  backAriaLabel,
  onBack,
  backDisabled = false,
  actions = [],
  sticky = false,
  overlay = false,
}: MobileDetailNavigationProps) {
  return (
    <header
      className={cn(
        'oc-mobile-detail-navigation relative shrink-0 pt-[max(0.25rem,var(--oc-safe-area-top,0px))]',
        sticky && 'oc-mobile-detail-navigation-sticky',
        overlay && 'absolute inset-x-0 top-0 z-30',
      )}
    >
      <div
        className="oc-mobile-detail-navigation-content grid grid-cols-[2.75rem_minmax(0,1fr)_2.75rem] items-center gap-1 px-4"
      >
        {onBack ? (
          <Button
            type="button"
            variant="mobileGlass"
            size="mobileIcon"
            className="justify-self-start"
            onClick={onBack}
            disabled={backDisabled}
            aria-label={backAriaLabel}
          >
            <Icon name="arrow-left-s" className="size-5" />
          </Button>
        ) : <span aria-hidden="true" />}

        <div className="oc-mobile-detail-title w-full max-w-72 min-w-0 justify-self-center truncate px-1 typography-ui-label font-medium text-foreground">
          {title}
        </div>

        <div className="flex min-w-0 items-center justify-end">
          {actions.map((action, index) => (
            <Button
              key={`${action.icon}:${index}`}
              type="button"
              variant="mobileGlass"
              size="mobileIcon"
              onClick={action.onClick}
              disabled={action.disabled}
              aria-label={action.ariaLabel}
              title={action.title}
            >
              <Icon name={action.icon} className="size-5" />
            </Button>
          ))}
        </div>
      </div>
    </header>
  );
}
