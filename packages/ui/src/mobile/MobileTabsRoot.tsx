import * as React from 'react';
import { useEvent } from '@reactuses/core';

import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

import { MobileTabBar } from './MobileTabBar';
import type { MobileNavigationState } from './mobileNavigation';
import { MOBILE_TABS, type MobileTabId } from './mobileTabs';

export type MobileSecondaryPage = {
  key: string;
  content: React.ReactNode;
  /** Accessible page label used for the secondary host landmark. */
  ariaLabel?: string;
};

export type MobileTabsRootProps = {
  tabs?: Partial<Record<MobileTabId, React.ReactNode>>;
  navigation: MobileNavigationState;
  onTabChange: (tab: MobileTabId) => void;
  secondaryPage?: MobileSecondaryPage | null;
  className?: string;
};

/**
 * Dedicated mobile shell root: floating bottom tabs plus a second-level page
 * host. Tab bodies use lazy-mount-on-first-visit and stay mounted afterwards
 * so drafts, scroll position, and subscriptions survive tab switches without
 * running every tab's queries on cold start.
 */
export function MobileTabsRoot({
  tabs,
  navigation,
  onTabChange,
  secondaryPage,
  className,
}: MobileTabsRootProps) {
  const { t } = useI18n();
  const selectedTab = navigation.activeTab;
  const [visitedTabs, setVisitedTabs] = React.useState<ReadonlySet<MobileTabId>>(
    () => new Set([selectedTab]),
  );

  if (!visitedTabs.has(selectedTab)) {
    // Render-phase state adjustment (React-sanctioned pattern): record the
    // first visit synchronously so the panel mounts in the same commit.
    setVisitedTabs((previous) => {
      if (previous.has(selectedTab)) return previous;
      const next = new Set(previous);
      next.add(selectedTab);
      return next;
    });
  }

  const secondaryHostRef = React.useRef<HTMLDivElement | null>(null);
  const restoreFocusRef = React.useRef<HTMLElement | null>(null);
  const hadSecondaryRef = React.useRef(false);

  // Focus contract: when a secondary page opens, capture the current trigger
  // and move focus into the page; when it closes, restore focus to the row
  // that opened it.
  React.useLayoutEffect(() => {
    if (secondaryPage) {
      if (!hadSecondaryRef.current) {
        const active = document.activeElement;
        restoreFocusRef.current = active instanceof HTMLElement ? active : null;
        hadSecondaryRef.current = true;
        secondaryHostRef.current?.focus();
      }
      return;
    }
    if (hadSecondaryRef.current) {
      hadSecondaryRef.current = false;
      const target = restoreFocusRef.current;
      restoreFocusRef.current = null;
      if (target && target.isConnected) {
        target.focus();
      }
    }
  }, [secondaryPage]);

  const handleTabChange = useEvent((nextTab: MobileTabId) => {
    onTabChange(nextTab);
  });

  return (
    <div className={cn('relative isolate flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground', className)}>
      <div
        aria-hidden={secondaryPage ? true : undefined}
        inert={secondaryPage ? true : undefined}
        className={cn('flex h-full min-h-0 flex-1 flex-col transition-[opacity,transform] duration-300 ease-out motion-reduce:transition-none', secondaryPage && 'scale-[0.985] opacity-0')}
      >
        {MOBILE_TABS.map((tab) => {
          const visited = visitedTabs.has(tab.id);
          return (
            <section
              key={tab.id}
              id={`mobile-tabpanel-${tab.id}`}
              role="tabpanel"
              aria-labelledby={`mobile-tab-${tab.id}`}
              hidden={selectedTab !== tab.id}
              tabIndex={0}
              className="h-full min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-[calc(7rem+var(--safe-area-inset-bottom,env(safe-area-inset-bottom,0px)))] pt-[max(1rem,var(--safe-area-inset-top,env(safe-area-inset-top,0px)))] outline-none"
            >
              {visited ? (tabs?.[tab.id] ?? <MobileTabPlaceholder tab={tab.id} icon={tab.icon} />) : null}
            </section>
          );
        })}
      </div>

      {secondaryPage ? (
        <div
          key={secondaryPage.key}
          ref={secondaryHostRef}
          role="dialog"
          aria-modal="true"
          aria-label={secondaryPage.ariaLabel ?? t('mobile.nav.secondaryPageAria')}
          tabIndex={-1}
          className="absolute inset-0 z-50 flex h-full min-h-0 flex-col overflow-hidden bg-background outline-none animate-in fade-in slide-in-from-right-4 duration-300 motion-reduce:animate-none"
        >
          {secondaryPage.content}
        </div>
      ) : (
        <MobileTabBar activeTab={selectedTab} onTabChange={handleTabChange} />
      )}
    </div>
  );
}

type MobileTabPlaceholderProps = {
  tab: MobileTabId;
  icon?: IconName;
  className?: string;
};

export function MobileTabPlaceholder({ tab, icon, className }: MobileTabPlaceholderProps) {
  const { t } = useI18n();
  const definition = MOBILE_TABS.find((item) => item.id === tab) ?? MOBILE_TABS[0];

  return (
    <div className={cn('flex min-h-[70dvh] flex-col items-center justify-center gap-3 text-center', className)}>
      <span className="flex size-14 items-center justify-center rounded-[20px] border border-border/50 bg-[var(--surface-elevated)] text-muted-foreground shadow-sm supports-[corner-shape:squircle]:rounded-[36px]">
        <Icon name={icon ?? definition.icon} className="size-6" />
      </span>
      <h1 className="typography-ui-label font-semibold tracking-[-0.01em]">{t(definition.labelKey)}</h1>
    </div>
  );
}
