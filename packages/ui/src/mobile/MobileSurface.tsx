import type { ComponentPropsWithoutRef, ReactNode } from 'react';

import { Slot } from '@/components/ui/slot';
import { cn } from '@/lib/utils';

import { MobileTabPageHeader } from './MobileTabPageHeader';

export type MobileFloatingSurfaceProps = ComponentPropsWithoutRef<'div'> & {
  asChild?: boolean;
};

/** Shared borderless floating material for every phone-tab surface. */
export function MobileFloatingSurface({
  asChild = false,
  className,
  ...props
}: MobileFloatingSurfaceProps) {
  const Comp = asChild ? Slot : 'div';
  return <Comp className={cn('oc-mobile-floating-surface', className)} {...props} />;
}

export type MobileFloatingBottomBarProps = Omit<ComponentPropsWithoutRef<'div'>, 'children'> & {
  as?: 'div' | 'nav' | 'footer';
  children: ReactNode;
  variant?: 'navigation' | 'actions';
  surfaceProps?: Omit<ComponentPropsWithoutRef<'div'>, 'children' | 'className'>;
};

/**
 * Shared phone bottom-bar shell. It owns viewport positioning, the floating
 * glass material, screen-edge clearance, width, height, and outer radius.
 * Callers only select the inner layout for navigation or page actions.
 */
export function MobileFloatingBottomBar({
  as: Component = 'div',
  children,
  className,
  variant = 'actions',
  surfaceProps,
  ...props
}: MobileFloatingBottomBarProps) {
  return (
    <Component className={cn('oc-mobile-floating-bottom-bar-frame', className)} {...props}>
      <MobileFloatingSurface
        {...surfaceProps}
        className={cn(
          'oc-mobile-floating-bottom-bar',
          variant === 'navigation'
            ? 'oc-mobile-floating-bottom-bar-navigation'
            : 'oc-mobile-floating-bottom-bar-actions',
        )}
      >
        {children}
      </MobileFloatingSurface>
    </Component>
  );
}

export type MobileTabPageScaffoldProps = {
  title: string;
  children: ReactNode;
  /** Workspaces with internal grouping own their cards instead of receiving one outer card. */
  surface?: boolean;
  /** Let the enclosing tab panel own one continuous vertical scroll region. */
  scrollsWithPage?: boolean;
  /** Hide the root-page title while a child detail screen owns navigation. */
  showHeader?: boolean;
  trailing?: ReactNode;
  className?: string;
  surfaceClassName?: string;
  surfaceAriaLabel?: string;
};

/**
 * One page rhythm for Assistant, Scheduled Tasks, and Settings. The shell owns
 * all geometry/material tokens; page implementations only provide content.
 */
export function MobileTabPageScaffold({
  title,
  children,
  surface = true,
  scrollsWithPage = false,
  showHeader = true,
  trailing,
  className,
  surfaceClassName,
  surfaceAriaLabel,
}: MobileTabPageScaffoldProps) {
  return (
    <div className={cn('oc-mobile-tab-page', scrollsWithPage && 'oc-mobile-tab-page-flow', !showHeader && 'gap-0', className)}>
      {showHeader ? <MobileTabPageHeader title={title} trailing={trailing} /> : null}
      {surface ? (
        <MobileFloatingSurface
          className={cn('oc-mobile-tab-page-surface', surfaceClassName)}
          aria-label={surfaceAriaLabel}
        >
          {children}
        </MobileFloatingSurface>
      ) : (
        <div className={cn('oc-mobile-tab-page-content', surfaceClassName)} aria-label={surfaceAriaLabel}>
          {children}
        </div>
      )}
    </div>
  );
}

export type MobileLabeledSurfaceGroupProps = {
  /** Compact group heading rendered inside the inset project surface. */
  label: ReactNode;
  children?: ReactNode;
  className?: string;
  cardClassName?: string;
  ariaLabel?: string;
};

/**
 * Reusable inset group for content that belongs to a larger floating surface.
 * The outer shell owns elevation; this component only adds local hierarchy.
 */
export function MobileLabeledSurfaceGroup({
  label,
  children,
  className,
  cardClassName,
  ariaLabel,
}: MobileLabeledSurfaceGroupProps) {
  return (
    <section
      className={cn('oc-mobile-labeled-surface-group', cardClassName, className)}
      aria-label={ariaLabel}
    >
      <div className="oc-mobile-labeled-surface-group-label">{label}</div>
      {children ? <div className="oc-mobile-labeled-surface-group-content">{children}</div> : null}
    </section>
  );
}
