import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** Keep each editor's actions visible inside its own scroll/save scope. */
export function SettingsActionHeader({ children, actions, className }: {
  children: ReactNode;
  actions: ReactNode;
  className?: string;
}) {
  return (
    <header data-settings-action-header="" className={cn('sticky top-0 z-10 flex shrink-0 items-center justify-between gap-3 bg-background py-3', className)}>
      <div className="min-w-0 flex-1">{children}</div>
      <div className="flex max-w-[70%] shrink-0 flex-wrap items-center justify-end gap-2 [&_button]:max-w-full [&_button]:whitespace-normal">{actions}</div>
    </header>
  );
}
