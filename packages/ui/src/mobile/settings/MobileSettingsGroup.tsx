import type { ReactNode } from 'react';

import {
  SettingsGroup,
  SettingsRow,
} from '@/components/sections/shared/SettingsGroup';
import { cn } from '@/lib/utils';

export type MobileSettingsGroupProps = {
  label: ReactNode;
  children: ReactNode;
  ariaLabel?: string;
  className?: string;
  borderless?: boolean;
};

/** iOS-style settings section: a quiet label followed by one grouped card. */
export function MobileSettingsGroup({
  label,
  children,
  ariaLabel,
  className,
  borderless = false,
}: MobileSettingsGroupProps) {
  return (
    <SettingsGroup
      label={label}
      ariaLabel={ariaLabel}
      className={cn('yuri-mobile-settings-group', className)}
      cardClassName={cn(
        'yuri-mobile-settings-card',
        borderless && 'yuri-mobile-settings-card-borderless',
      )}
    >
      {children}
    </SettingsGroup>
  );
}

export type MobileSettingsRowProps = {
  label?: ReactNode;
  children: ReactNode;
  description?: ReactNode;
  itemId?: string;
  className?: string;
};

/** Shared two-column row for mobile Settings home and detail surfaces. */
export function MobileSettingsRow({
  label,
  children,
  description,
  itemId,
  className,
}: MobileSettingsRowProps) {
  return (
    <SettingsRow
      itemId={itemId}
      label={label}
      description={description}
      className={cn('yuri-mobile-settings-row yuri-mobile-settings-detail-row', className)}
    >
      {children}
    </SettingsRow>
  );
}
