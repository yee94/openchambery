import React from 'react';
import { cn } from '@/lib/utils';

type MobileSurfaceHeaderProps = React.ComponentProps<'header'> & {
  contentClassName?: string;
};

export const MobileSurfaceHeader: React.FC<MobileSurfaceHeaderProps> = ({
  children,
  className,
  contentClassName,
  style,
  ...props
}) => (
  <header
    className={cn('oc-mobile-header relative z-30 shrink-0 border-b border-border/30 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80', className)}
    style={{ paddingTop: 'var(--oc-safe-area-top, 0px)', ...style }}
    {...props}
  >
    <div className={cn('flex h-[var(--oc-header-height,56px)] w-full items-center gap-1 px-2', contentClassName)}>
      {children}
    </div>
  </header>
);
