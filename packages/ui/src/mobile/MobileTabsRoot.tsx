import * as React from 'react';
import { useEvent } from '@reactuses/core';

import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { useI18n } from '@/lib/i18n';
import { useIosNativeUiEnabled } from '@/lib/iosNativeUi';
import { canUseNativeIosComposer } from '@/lib/native-ios-composer';
import { nativeIosComposerSession } from '@/lib/native-ios-composer-session';
import { cn } from '@/lib/utils';

import { MobileTabBar } from './MobileTabBar';
import { useMobileBackRoute } from './mobileBackNavigation';
import type { MobileNavigationState } from './mobileNavigation';
import { MOBILE_TABS, type MobileTabId } from './mobileTabs';
import { useNativeIosTabBar } from './useNativeIosTabBar';

export type MobileSecondaryPage = {
  key: string;
  content: React.ReactNode;
  /** Pops this page through its owning state store. */
  onBack: () => boolean | void;
  /** Accessible page label used for the secondary host landmark. */
  ariaLabel?: string;
  /** Full stack depth, independent of the two-page DOM window. */
  depth?: number;
};

export type MobileTabsRootProps = {
  tabs?: Partial<Record<MobileTabId, React.ReactNode>>;
  navigation: MobileNavigationState;
  onTabChange: (tab: MobileTabId) => void;
  secondaryPages?: readonly MobileSecondaryPage[];
  /** Controls whether this shell has a root dock at all. Push pages retain it underneath. */
  showTabBar?: boolean;
  /** Keeps the retained dock non-interactive while an in-tab push page covers it. */
  tabBarCovered?: boolean;
  className?: string;
};

/**
 * Dedicated mobile shell root: edge-to-edge bottom tabs plus a second-level page
 * host. Tab bodies use lazy-mount-on-first-visit and stay mounted afterwards
 * so drafts, scroll position, and subscriptions survive tab switches without
 * running every tab's queries on cold start.
 */
export function MobileTabsRoot({
  tabs,
  navigation,
  onTabChange,
  secondaryPages = [],
  showTabBar = true,
  tabBarCovered = false,
  className,
}: MobileTabsRootProps) {
  const { t } = useI18n();
  const selectedTab = navigation.activeTab;
  const visibleSecondaryPages = secondaryPages.slice(-2);
  const topSecondaryPage = visibleSecondaryPages.at(-1) ?? null;
  const topSecondaryPageKey = topSecondaryPage?.key ?? null;
  const topSecondaryPageDepth = topSecondaryPage?.depth;
  const predecessorSecondaryPageKey = visibleSecondaryPages.length > 1
    ? visibleSecondaryPages[visibleSecondaryPages.length - 2].key
    : null;
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
  const secondaryUnderlayRef = React.useRef<HTMLDivElement | null>(null);
  const rootUnderlayRef = React.useRef<HTMLDivElement | null>(null);
  const secondaryPageElementsRef = React.useRef(new Map<string, HTMLDivElement>());
  const restoreFocusRef = React.useRef<HTMLElement | null>(null);
  const hadSecondaryRef = React.useRef(false);
  const focusedPageKeyRef = React.useRef('');

  const handleSecondaryBack = useEvent(() => topSecondaryPage?.onBack());

  useMobileBackRoute({
    id: topSecondaryPage ? `mobile-secondary:${topSecondaryPage.key}` : 'mobile-secondary:inactive',
    active: Boolean(topSecondaryPage),
    onBack: handleSecondaryBack,
    surfaceRef: secondaryHostRef,
    underlayRef: secondaryUnderlayRef,
  });

  // Instant secondary enter: no push WAAPI. Only keep host/underlay refs for
  // interactive back. Enter animations previously caused a leftward settle flash
  // on chat (sticky/list heavy) and are intentionally disabled.
  React.useLayoutEffect(() => {
    const top = topSecondaryPageKey !== null
      ? secondaryPageElementsRef.current.get(topSecondaryPageKey) ?? null
      : null;
    const predecessor = predecessorSecondaryPageKey !== null
      ? secondaryPageElementsRef.current.get(predecessorSecondaryPageKey) ?? null
      : rootUnderlayRef.current;
    secondaryHostRef.current = top;
    secondaryUnderlayRef.current = predecessor;
  }, [topSecondaryPageKey, topSecondaryPageDepth, predecessorSecondaryPageKey]);

  // Focus contract: when a secondary page opens, capture the current trigger
  // and move focus into the page; when it closes, restore focus to the row
  // that opened it.
  React.useLayoutEffect(() => {
    if (topSecondaryPage) {
      if (!hadSecondaryRef.current) {
        const active = document.activeElement;
        restoreFocusRef.current = active instanceof HTMLElement ? active : null;
        hadSecondaryRef.current = true;
      }
      if (focusedPageKeyRef.current !== topSecondaryPage.key) {
        focusedPageKeyRef.current = topSecondaryPage.key;
        secondaryHostRef.current?.focus();
      }
      return;
    }
    if (hadSecondaryRef.current) {
      hadSecondaryRef.current = false;
      focusedPageKeyRef.current = '';
      const target = restoreFocusRef.current;
      restoreFocusRef.current = null;
      if (target && target.isConnected) {
        target.focus();
      }
    }
  }, [topSecondaryPage]);

  const handleTabChange = useEvent((nextTab: MobileTabId) => {
    onTabChange(nextTab);
  });

  const nativeTabs = React.useMemo(
    () => MOBILE_TABS.map((tab) => ({ id: tab.id, label: t(tab.labelKey) })),
    [t],
  );
  const nativeTabBarVisible = showTabBar && !tabBarCovered && !topSecondaryPage;
  const nativeTabBarMode = useNativeIosTabBar({
    visible: nativeTabBarVisible,
    activeTab: selectedTab,
    tabs: nativeTabs,
    ariaLabel: t('mobile.nav.aria'),
    onTabChange: handleTabChange,
  });
  const nativeTabBarAdopted = nativeTabBarMode === 'native';
  const showWebTabBar = showTabBar && nativeTabBarMode === 'web';
  const iosNativeUiEnabled = useIosNativeUiEnabled();

  React.useEffect(() => {
    if (!iosNativeUiEnabled) {
      nativeIosComposerSession.shutdown();
      return;
    }
    if (!nativeTabBarAdopted) return;
    if (!canUseNativeIosComposer(true)) return;
    void nativeIosComposerSession.warm();
  }, [iosNativeUiEnabled, nativeTabBarAdopted]);

  return (
    <div
      className={cn(
        'oc-mobile-floating-shell relative isolate flex h-full min-h-0 flex-col overflow-hidden text-foreground',
        'bg-[var(--oc-mobile-page-background)]',
        className,
      )}
    >
      <div
        ref={rootUnderlayRef}
        data-mobile-navigation-underlay="true"
        aria-hidden={topSecondaryPage ? true : undefined}
        inert={topSecondaryPage ? true : undefined}
        className="flex h-full min-h-0 flex-1 flex-col"
      >
        {MOBILE_TABS.map((tab) => {
          const visited = visitedTabs.has(tab.id);
          return (
            <section
              key={tab.id}
              id={`mobile-tabpanel-${tab.id}`}
              role="tabpanel"
              aria-labelledby={showWebTabBar ? `mobile-tab-${tab.id}` : undefined}
              aria-label={showWebTabBar ? undefined : t(tab.labelKey)}
              hidden={selectedTab !== tab.id}
              tabIndex={0}
              className={cn(
                'scrollbar-none h-full min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain px-[var(--oc-mobile-page-inline-inset)] pt-[calc(var(--safe-area-inset-top,env(safe-area-inset-top,0px))+1rem)] outline-none',
                showTabBar
                  ? 'pb-[calc(var(--oc-mobile-dock-height)+2.5rem+var(--safe-area-inset-bottom,env(safe-area-inset-bottom,0px)))]'
                  : 'pb-0',
              )}
            >
              {visited ? (tabs?.[tab.id] ?? <MobileTabPlaceholder tab={tab.id} icon={tab.icon} />) : null}
            </section>
          );
        })}
      </div>

      {showTabBar ? (
        <div
          data-mobile-navigation-dock-underlay="true"
          aria-hidden={topSecondaryPage || tabBarCovered || nativeTabBarAdopted ? true : undefined}
          inert={topSecondaryPage || tabBarCovered || nativeTabBarAdopted ? true : undefined}
        >
          {showWebTabBar ? (
            <MobileTabBar activeTab={selectedTab} onTabChange={handleTabChange} />
          ) : null}
        </div>
      ) : null}

      {visibleSecondaryPages.map((page, index) => {
        const active = index === visibleSecondaryPages.length - 1;
        return (
          <div
            key={page.key}
            ref={(element) => {
              if (element) secondaryPageElementsRef.current.set(page.key, element);
              else secondaryPageElementsRef.current.delete(page.key);
            }}
            data-mobile-secondary-page="true"
            data-mobile-secondary-active={active ? 'true' : 'false'}
            role={active ? 'dialog' : undefined}
            aria-modal={active ? true : undefined}
            aria-label={active ? page.ariaLabel ?? t('mobile.nav.secondaryPageAria') : undefined}
            aria-hidden={active ? undefined : true}
            inert={active ? undefined : true}
            tabIndex={active ? -1 : undefined}
            className={cn(
              'absolute inset-0 flex h-full min-h-0 flex-col overflow-hidden bg-background outline-none',
              active ? 'z-50' : 'z-40',
            )}
          >
            {page.content}
          </div>
        );
      })}
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
      <span className="flex size-12 items-center justify-center rounded-2xl bg-[var(--surface-muted)] text-muted-foreground">
        <Icon name={icon ?? definition.icon} className="size-6" />
      </span>
      <h1 className="typography-ui-label font-semibold tracking-[-0.01em] text-foreground">{t(definition.labelKey)}</h1>
    </div>
  );
}
