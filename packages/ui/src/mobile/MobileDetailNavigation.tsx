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
  /** Raised above modal backdrops while a menu owned by this control is open. */
  elevated?: boolean;
  pressed?: boolean;
};

export type MobileDetailNavigationProps = {
  title: ReactNode;
  /** WeChat-style whisper under the title (e.g. syncing messages). */
  subtitle?: ReactNode;
  backAriaLabel: string;
  onBack?: () => void;
  backDisabled?: boolean;
  actions?: readonly MobileDetailNavigationAction[];
  /** Custom trailing nodes rendered before icon actions (e.g. context ring). */
  trailing?: ReactNode;
  sticky?: boolean;
  overlay?: boolean;
  /**
   * Raise the whole header above modal backdrops. Child `z-index` alone cannot
   * escape the header stacking context, so re-tap-to-close needs this.
   */
  elevated?: boolean;
};

/** Shared safe-area navigation for mobile secondary pages. */
export function MobileDetailNavigation({
  title,
  subtitle,
  backAriaLabel,
  onBack,
  backDisabled = false,
  actions = [],
  trailing,
  sticky = false,
  overlay = false,
  elevated = false,
}: MobileDetailNavigationProps) {
  const hasTrailingActions = Boolean(trailing) || actions.length > 0;
  const actionElevated = elevated || actions.some((action) => action.elevated);

  return (
    <header
      className={cn(
        'oc-mobile-detail-navigation relative shrink-0 pt-[max(0.25rem,var(--oc-safe-area-top,0px))]',
        sticky && 'oc-mobile-detail-navigation-sticky',
        overlay && 'absolute inset-x-0 top-0',
        // Single z-index: elevated menus must sit above the z-50 overflow
        // backdrop so a second tap on the same control can toggle closed.
        actionElevated ? 'z-[60]' : overlay ? 'z-30' : undefined,
      )}
    >
      <div
        className={cn(
          'oc-mobile-detail-navigation-content grid items-center gap-1 px-4',
          hasTrailingActions && actions.length + (trailing ? 1 : 0) > 1
            ? 'grid-cols-[2.75rem_minmax(0,1fr)_auto]'
            : 'grid-cols-[2.75rem_minmax(0,1fr)_2.75rem]',
        )}
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

        <div className="flex w-full max-w-72 min-w-0 flex-col items-center justify-center justify-self-center px-1">
          <div className="oc-mobile-detail-title w-full truncate typography-ui-label font-medium text-foreground">
            {title}
          </div>
          {subtitle ? (
            <div className="oc-mobile-detail-subtitle w-full truncate text-muted-foreground" aria-live="polite">
              {subtitle}
            </div>
          ) : null}
        </div>

        <div className="flex min-w-0 items-center justify-end gap-2">
          {trailing}
          {actions.map((action, index) => (
            <Button
              key={`${action.icon}:${index}`}
              type="button"
              variant="mobileGlass"
              size="mobileIcon"
              className={cn(action.elevated && 'relative z-[60]')}
              onClick={action.onClick}
              disabled={action.disabled}
              aria-label={action.ariaLabel}
              aria-expanded={action.pressed}
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
