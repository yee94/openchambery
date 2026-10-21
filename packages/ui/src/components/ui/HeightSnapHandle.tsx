import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export function HeightSnapHandle({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="horizontal"
      className={cn('flex cursor-ns-resize touch-none justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--interactive-focus-ring)]', className)}
      {...props}
    >
      <div className="pointer-events-none h-1.5 w-11 rounded-full bg-[var(--interactive-border)]" />
    </div>
  );
}
