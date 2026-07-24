import React, { useState, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { Icon } from "@/components/icon/Icon";
import { SettingsGroup } from '@/components/sections/shared/SettingsGroup';

interface SidebarGroupProps {
  /** Group display label (e.g. "business", "automation-ai") */
  label: string;
  /** Number of items in this group */
  count: number;
  /** Unique storage key prefix for persisting collapse state */
  storageKey: string;
  /** Whether to start expanded. Defaults to true. */
  defaultExpanded?: boolean;
  /** Render with the shared Settings label/card grammar instead of a flat sidebar indent. */
  variant?: 'sidebar' | 'settings-card';
  /** Optional collection label shown before the folder label in Settings card mode. */
  labelPrefix?: string;
  children: React.ReactNode;
}

function getStorageKey(storageKey: string, label: string): string {
  return `opencode:sidebar-group:${storageKey}:${label}`;
}

/**
 * Collapsible sidebar group with persisted expand/collapse state.
 * Used in Agents and Skills sidebars to group items by subfolder.
 */
export const SidebarGroup: React.FC<SidebarGroupProps> = ({
  label,
  count,
  storageKey,
  defaultExpanded = true,
  variant = 'sidebar',
  labelPrefix,
  children,
}) => {
  const key = getStorageKey(storageKey, label);
  const contentId = React.useId();

  const [expanded, setExpanded] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem(key);
      if (stored !== null) return stored === 'true';
    } catch {
      // ignore storage errors
    }
    return defaultExpanded;
  });

  useEffect(() => {
    try {
      localStorage.setItem(key, String(expanded));
    } catch {
      // ignore storage errors
    }
  }, [key, expanded]);

  if (variant === 'settings-card') {
    return (
      <SettingsGroup
        label={(
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded}
            aria-controls={contentId}
            className={cn(
              'flex w-full items-center gap-1 text-left',
              'text-inherit transition-colors duration-150 hover:text-foreground',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
            )}
          >
            <Icon
              name="arrow-down-s"
              className={cn(
                'h-3.5 w-3.5 flex-shrink-0 transition-transform duration-200',
                !expanded && '-rotate-90',
              )}
            />
            <span className="min-w-0 flex-1 truncate">
              {labelPrefix ? `${labelPrefix} · ` : ''}{label}
            </span>
            <span className="ml-1 tabular-nums opacity-60">{count}</span>
          </button>
        )}
        cardClassName={cn(!expanded && 'hidden')}
        cardId={contentId}
      >
        {children}
      </SettingsGroup>
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-controls={contentId}
        className={cn(
          'flex w-full items-center gap-1 rounded-md px-2 py-1 text-left',
          'text-xs font-semibold uppercase tracking-wide text-muted-foreground',
          'hover:bg-[var(--interactive-hover)] transition-colors duration-150',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
        )}
      >
        <Icon name="arrow-down-s"
          className={cn(
            'h-3.5 w-3.5 flex-shrink-0 transition-transform duration-200',
            !expanded && '-rotate-90',
          )}
        />
        <span className="flex-1 truncate">{label}</span>
        <span className="ml-1 tabular-nums opacity-60">{count}</span>
      </button>

      <div
        id={contentId}
        hidden={!expanded}
        className="mt-0.5 space-y-0.5 ml-2 pl-3 border-l-2 border-[var(--interactive-border)]"
      >
        {children}
      </div>
    </div>
  );
};
