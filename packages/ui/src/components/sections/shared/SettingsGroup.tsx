import type { ReactNode } from 'react';

import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';

export type SettingsGroupProps = {
  label?: ReactNode;
  children: ReactNode;
  description?: ReactNode;
  itemId?: string;
  ariaLabel?: string;
  className?: string;
  cardClassName?: string;
  cardId?: string;
};

/**
 * Shared Settings section for desktop and narrow/mobile detail pages.
 *
 * The section label sits outside one grouped material card. Consumers compose
 * the card from `SettingsRow` so Settings and editor details keep the same
 * vertical rhythm, separators, and responsive alignment. The normative
 * contract is documented in `SETTINGS_DESIGN_SPEC.md`; feature pages must not
 * recreate this structure with local typography or spacing.
 */
export function SettingsGroup({
  label,
  children,
  description,
  itemId,
  ariaLabel,
  className,
  cardClassName,
  cardId,
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
      <div
        id={cardId}
        data-settings-item={itemId}
        className={cn('oc-settings-group-card', cardClassName)}
      >
        {children}
      </div>
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

export type SettingsToggleRowProps = {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  ariaLabel: string;
  description?: ReactNode;
  itemId?: string;
  disabled?: boolean;
  className?: string;
};

/** Standard full-row boolean setting with shared pointer and keyboard behavior. */
export function SettingsToggleRow({
  checked,
  onChange,
  label,
  ariaLabel,
  description,
  itemId,
  disabled = false,
  className,
}: SettingsToggleRowProps) {
  const toggle = () => {
    if (!disabled) onChange(!checked);
  };

  const isInteractiveDescendant = (target: EventTarget | null) => (
    target instanceof HTMLElement
      && target.closest('button, a, input, select, textarea') !== null
  );

  return (
    <div
      data-settings-item={itemId}
      className={cn(
        'oc-settings-group-row group flex items-center gap-2',
        disabled ? 'cursor-not-allowed' : 'cursor-pointer',
        className,
      )}
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-pressed={checked}
      aria-disabled={disabled || undefined}
      onClick={(event) => {
        if (!isInteractiveDescendant(event.target)) toggle();
      }}
      onKeyDown={(event) => {
        if (isInteractiveDescendant(event.target)) return;
        if (event.key === ' ' || event.key === 'Enter') {
          event.preventDefault();
          toggle();
        }
      }}
    >
      <Checkbox
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        ariaLabel={ariaLabel}
      />
      <div className="flex min-w-0 flex-col">
        <span className="typography-ui-label text-foreground">{label}</span>
        {description ? (
          <span className="typography-meta text-muted-foreground">{description}</span>
        ) : null}
      </div>
    </div>
  );
}
