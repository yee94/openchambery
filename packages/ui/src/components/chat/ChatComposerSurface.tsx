import React from 'react';
import { cn } from '@/lib/utils';

type ChatComposerSurfaceProps = React.HTMLAttributes<HTMLDivElement> & {
  expanded?: boolean;
};

export const ChatComposerSurface = React.forwardRef<HTMLDivElement, ChatComposerSurfaceProps>(({
  children,
  className,
  expanded = false,
  style,
  ...props
}, ref) => (
  <div
    ref={ref}
    className={cn(
      'relative flex flex-col overflow-visible border border-[color-mix(in_srgb,var(--interactive-border)_50%,transparent)] dark:border-transparent',
      'bg-[var(--surface-background)] shadow-[0_2px_6px_-3px_color-mix(in_srgb,var(--surface-foreground)_4%,transparent),inset_0_1px_0_var(--yuri-mobile-glass-highlight)] transition-colors duration-150 motion-reduce:transition-none',
      'dark:bg-[color-mix(in_srgb,var(--surface-background),var(--surface-foreground)_8%)] dark:shadow-none dark:hover:bg-[color-mix(in_srgb,var(--surface-background),var(--surface-foreground)_11%)] dark:focus-within:bg-[color-mix(in_srgb,var(--surface-background),var(--surface-foreground)_11%)]',
      expanded && 'min-h-0 flex-1',
      className,
    )}
    style={{
      borderRadius: 'var(--radius-xl)',
      ...style,
    }}
    {...props}
  >
    {children}
  </div>
));

ChatComposerSurface.displayName = 'ChatComposerSurface';
