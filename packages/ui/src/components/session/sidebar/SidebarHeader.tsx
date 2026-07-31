import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';

type Props = {
  hideDirectoryControls: boolean;
  isSessionSearchOpen: boolean;
  setIsSessionSearchOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
  sessionSearchInputRef: React.RefObject<HTMLInputElement | null>;
  sessionSearchQuery: string;
  setSessionSearchQuery: (value: string) => void;
  hasSessionSearchQuery: boolean;
  searchMatchCount: number;
};

/**
 * Sidebar search field only. The old action toolbar (new session / multi-run /
 * scheduled / search / selection) was removed; project controls live on the
 * Projects section header.
 */
export function SidebarHeader(props: Props): React.ReactNode {
  const { t } = useI18n();
  const {
    hideDirectoryControls,
    isSessionSearchOpen,
    setIsSessionSearchOpen,
    sessionSearchInputRef,
    sessionSearchQuery,
    setSessionSearchQuery,
    hasSessionSearchQuery,
    searchMatchCount,
  } = props;

  if (hideDirectoryControls || !isSessionSearchOpen) {
    return null;
  }

  return (
    <div className="select-none flex-shrink-0 px-3 py-1">
      <div className="pb-1">
        <div className="mb-1 flex items-center justify-between px-0.5 typography-micro text-muted-foreground/80">
          {hasSessionSearchQuery ? (
            <span>{searchMatchCount === 1
              ? t('sessions.sidebar.header.search.matchCountSingle', { count: searchMatchCount })
              : t('sessions.sidebar.header.search.matchCountPlural', { count: searchMatchCount })}</span>
          ) : <span />}
          <span>{t('sessions.sidebar.header.search.escapeHint')}</span>
        </div>
        <div className="relative">
          <Icon name="search" className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            ref={sessionSearchInputRef}
            value={sessionSearchQuery}
            onChange={(event) => setSessionSearchQuery(event.target.value)}
            placeholder={t('sessions.sidebar.header.search.placeholder')}
            className="h-8 w-full rounded-md border border-border bg-transparent pl-8 pr-8 typography-ui-label text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.stopPropagation();
                if (hasSessionSearchQuery) {
                  setSessionSearchQuery('');
                } else {
                  setIsSessionSearchOpen(false);
                }
              }
            }}
          />
          {sessionSearchQuery.length > 0 ? (
            <button
              type="button"
              onClick={() => setSessionSearchQuery('')}
              className="absolute right-1 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-interactive-hover/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
              aria-label={t('sessions.sidebar.header.search.clear')}
            >
              <Icon name="close" className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
