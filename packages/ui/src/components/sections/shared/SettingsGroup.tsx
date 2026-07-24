import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

export type SettingsGroupProps = {
  label?: ReactNode;
  children: ReactNode;
  description?: ReactNode;
  ariaLabel?: string;
  className?: string;
  cardClassName?: string;
};

/**
 * Shared Settings section for desktop and narrow/mobile detail pages.
 *
 * The section label sits outside one grouped material card. Consumers compose
 * the card from `SettingsRow` so Settings and editor details keep the same
 * vertical rhythm, separators, and responsive alignment.
 */
export function SettingsGroup({
  label,
  children,
  description,
  ariaLabel,
  className,
  cardClassName,
}: SettingsGroupProps) {
  const labelScript = typeof label === 'string'
    && /^[\p{Script=Latin}\p{Number}\p{Punctuation}\p{Separator}]+$/u.test(label)
    ? 'latin'
    : undefined;

  return (
    <section className={cn('oc-settings-group', className)} aria-label={ariaLabel}>
      {label ? (
        <div
          className="oc-settings-group-label"
          data-settings-label-script={labelScript}
        >
          {label}
        </div>
      ) : null}
      <div className={cn('oc-settings-group-card', cardClassName)}>{children}</div>
      {description ? (
        <p className="oc-settings-group-description text-muted-foreground">
          {description}
        </p>
      ) : null}
    </section>
  );
}

export type SettingsFieldProps = Omit<SettingsRowProps, 'label' | 'description'> & {
  label: ReactNode;
  description?: ReactNode;
  descriptionPlacement?: 'inside' | 'outside';
  ariaLabel?: string;
  groupClassName?: string;
  cardClassName?: string;
};

/**
 * Standard single-setting form surface.
 *
 * The field name and control live inside the card. Short helper text may stay
 * with the label; explanatory copy uses `descriptionPlacement="outside"` so
 * desktop and mobile render the same quiet caption below the card.
 */
export function SettingsField({
  label,
  description,
  descriptionPlacement = 'inside',
  ariaLabel,
  groupClassName,
  cardClassName,
  children,
  ...rowProps
}: SettingsFieldProps) {
  return (
    <SettingsGroup
      ariaLabel={ariaLabel}
      className={groupClassName}
      cardClassName={cardClassName}
      description={descriptionPlacement === 'outside' ? description : undefined}
    >
      <SettingsRow
        label={label}
        description={descriptionPlacement === 'inside' ? description : undefined}
        {...rowProps}
      >
        {children}
      </SettingsRow>
    </SettingsGroup>
  );
}

export type SettingsRowProps = {
  label?: ReactNode;
  children: ReactNode;
  description?: ReactNode;
  itemId?: string;
  className?: string;
  copyClassName?: string;
  controlClassName?: string;
};

/** Shared label/value row. The value column owns alignment and overflow. */
export function SettingsRow({
  label,
  children,
  description,
  itemId,
  className,
  copyClassName,
  controlClassName,
}: SettingsRowProps) {
  return (
    <div
      data-settings-item={itemId}
      className={cn('oc-settings-group-row oc-settings-split-row', className)}
    >
      <div className={cn('oc-settings-split-row-copy', copyClassName)}>
        {label ? (
          <div className="typography-ui-label text-foreground">{label}</div>
        ) : null}
        {description ? (
          <span className="typography-meta text-muted-foreground">{description}</span>
        ) : null}
      </div>
      <div
        data-settings-value=""
        className={cn('oc-settings-split-row-control', controlClassName)}
      >
        {children}
      </div>
    </div>
  );
}
