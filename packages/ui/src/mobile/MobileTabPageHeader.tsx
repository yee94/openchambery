import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

export type MobileTabPageHeaderProps = {
  title: string;
  eyebrow?: string;
  trailing?: ReactNode;
  className?: string;
};

/** Large-title header for primary pages hosted by MobileTabsRoot. */
export function MobileTabPageHeader({
  title,
  eyebrow,
  trailing,
  className,
}: MobileTabPageHeaderProps) {
  return (
    <header className={cn('flex shrink-0 items-end gap-4 px-1 pb-5 pt-2', className)}>
      <div className="min-w-0 flex-1">
        {eyebrow ? (
          <p className="mb-1 truncate typography-micro font-medium uppercase tracking-[0.14em] text-muted-foreground">
            {eyebrow}
          </p>
        ) : null}
        <h1 className="truncate text-[2rem] font-semibold leading-[1.08] tracking-[-0.035em] text-foreground">
          {title}
        </h1>
      </div>
      {trailing ? <div className="flex min-h-11 shrink-0 items-center">{trailing}</div> : null}
    </header>
  );
}
