import React from 'react';
import { cn } from '@/lib/utils';

type ChatComposerSurfaceProps = React.HTMLAttributes<HTMLDivElement> & {
  expanded?: boolean;
  focusedTone?: 'primary' | 'info';
};

export const ChatComposerSurface = React.forwardRef<HTMLDivElement, ChatComposerSurfaceProps>(({
  children,
  className,
  expanded = false,
  focusedTone = 'primary',
  style,
  ...props
}, ref) => (
  <div
    ref={ref}
    className={cn(
      'relative flex flex-col overflow-visible border border-border/80 focus-within:ring-1',
      expanded && 'min-h-0 flex-1',
      focusedTone === 'info' ? 'focus-within:ring-[var(--status-info)]' : 'focus-within:ring-primary/50',
      className,
    )}
    style={{
      borderRadius: 'var(--radius-xl)',
      backgroundColor: 'var(--surface-subtle)',
      ...style,
    }}
    {...props}
  >
    {children}
  </div>
));

ChatComposerSurface.displayName = 'ChatComposerSurface';
