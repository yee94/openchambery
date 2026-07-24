import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

export type MobileTabPageHeaderProps = {
  title: string;
  eyebrow?: string;
  trailing?: ReactNode;
  className?: string;
};

/** Large title + trailing actions, matching the design reference header. */
export function MobileTabPageHeader({
  title,
  eyebrow,
  trailing,
  className,
}: MobileTabPageHeaderProps) {
  return (
    <header className={cn('flex shrink-0 items-center gap-4 px-1 pb-0 pt-1.5', className)}>
      <div className="min-w-0 flex-1">
        {eyebrow ? (
          <p className="mb-0.5 truncate typography-micro font-medium text-muted-foreground">
            {eyebrow}
          </p>
        ) : null}
        <h1 className="oc-mobile-root-page-title truncate font-semibold text-foreground">
          {title}
        </h1>
      </div>
      {trailing ? <div className="flex min-h-10 shrink-0 items-center gap-3.5">{trailing}</div> : null}
    </header>
  );
}
