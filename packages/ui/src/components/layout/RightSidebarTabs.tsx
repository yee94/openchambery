import React from 'react';

import { SortableTabsStrip } from '@/components/ui/sortable-tabs-strip';
import { GitView } from '@/components/views/GitView';
import { Icon } from "@/components/icon/Icon";
import { useGitStore } from '@/stores/useGitStore';
import { useUIStore, type RightSidebarTab } from '@/stores/useUIStore';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { shouldShowBrowserProviderRail } from '@/lib/browser-provider/contract';
import { useBrowserProviderCatalogQuery } from '@/queries/browserProviderQueries';
import { BrowserProviderRail } from './BrowserProviderRail';
import { SidebarFilesTree } from './SidebarFilesTree';
import { isRightSidebarTab, visibleRightSidebarTabs } from './visibleRightSidebarTabs';

const isBrowserActive = (): boolean => {
  if (typeof document !== 'undefined' && document.hidden) return false;
  if (typeof navigator !== 'undefined' && !navigator.onLine) return false;
  return true;
};

/**
 * Keeps git status fresh while the right sidebar's Git tab is the visible
 * consumer. Replaces the GitPollingProvider removed in commit b2d5ccb4.
 *
 * Gating rules (mirror the right-sidebar render policy):
 *   - sidebar must be open
 *   - right tab must be 'git' (otherwise GitView is not the visible consumer)
 *   - main tab must not be 'git' (otherwise secondaryView's GitView handles
 *     refresh and this poll would duplicate work)
 *   - browser must be visible + online
 *
 * Any condition flip resets the interval so the next tick starts fresh.
 */
function useRightSidebarGitSync(
  directory: string | undefined,
  isSidebarOpen: boolean,
  rightTab: RightSidebarTab | undefined,
  mainTab: string | undefined
) {
  const { git } = useRuntimeAPIs();
  const ensureStatus = useGitStore((state) => state.ensureStatus);

  const shouldPoll = Boolean(
    directory && git && isSidebarOpen && rightTab === 'git' && mainTab !== 'git'
  );

  React.useEffect(() => {
    if (!shouldPoll || !directory || !git) return;

    void ensureStatus(directory, git);

    const POLL_INTERVAL = 10_000;
    const id = window.setInterval(() => {
      if (!isBrowserActive()) return;
      void ensureStatus(directory, git);
    }, POLL_INTERVAL);

    return () => window.clearInterval(id);
  }, [shouldPoll, directory, git, ensureStatus]);
}

export const RightSidebarTabs: React.FC = () => {
  const { t } = useI18n();
  const rightSidebarTab = useUIStore((state) => state.rightSidebarTab);
  const setRightSidebarTab = useUIStore((state) => state.setRightSidebarTab);
  const isRightSidebarOpen = useUIStore((state) => state.isRightSidebarOpen);
  const activeMainTab = useUIStore((state) => state.activeMainTab);
  const directory = useEffectiveDirectory();
  const browserCatalog = useBrowserProviderCatalogQuery();
  const selectedProvider = browserCatalog.data?.providers.find((provider) => provider.id === browserCatalog.data?.selectedId) ?? null;
  const showBrowser = shouldShowBrowserProviderRail(browserCatalog.data);

  useRightSidebarGitSync(directory, isRightSidebarOpen, rightSidebarTab, activeMainTab);

  // When the main view already hosts a right-tab equivalent (e.g. main tab
  // 'git' renders GitView in the secondary slot), the right sidebar's
  // matching tab is hidden to avoid two live GitView instances running
  // effects. The browser tab exists only while a provider is actually selected.
  const hideGit = activeMainTab === 'git';
  const visibleTabs = React.useMemo(
    () => visibleRightSidebarTabs({ hideGit, showBrowser }),
    [hideGit, showBrowser],
  );

  // Persisted right sidebar tab can be stale across main-tab switches (e.g.
  // user opened main 'git' while right tab was 'git'). Snap away from a tab
  // that is not currently visible so an absent provider never looks connected.
  React.useEffect(() => {
    if (!visibleTabs.includes(rightSidebarTab)) {
      setRightSidebarTab(visibleTabs[0] ?? 'files');
    }
  }, [rightSidebarTab, setRightSidebarTab, visibleTabs]);

  const tabItems = React.useMemo(() => visibleTabs.map((id) => ({
    id,
    label: t(id === 'git' ? 'layout.rightSidebar.git' : id === 'files' ? 'layout.rightSidebar.files' : 'layout.rightSidebar.browser'),
    icon: <Icon name={id === 'git' ? 'git-branch' : id === 'files' ? 'folder-3' : 'global'} className="h-3.5 w-3.5" />,
  })), [t, visibleTabs]);
  const isRightGitTabActive = isRightSidebarOpen && rightSidebarTab === 'git' && !hideGit;

  const handleTabSelect = React.useCallback(
    (tabID: string) => {
      if (isRightSidebarTab(tabID) && visibleTabs.includes(tabID)) {
        setRightSidebarTab(tabID);
      }
    },
    [setRightSidebarTab, visibleTabs]
  );

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <div className="h-9 bg-background pt-1 px-2">
        <SortableTabsStrip
          items={tabItems}
          activeId={rightSidebarTab}
          onSelect={handleTabSelect}
          layoutMode="fit"
          variant="active-pill"
          activePillLowercase={false}
          className="h-full"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        <div className={cn('h-full', rightSidebarTab !== 'git' && 'hidden')}>
          <GitView isActive={isRightGitTabActive} />
        </div>
        <div className={cn('h-full', rightSidebarTab !== 'files' && 'hidden')}>
          <SidebarFilesTree />
        </div>
        {showBrowser && selectedProvider ? (
          <div className={cn('h-full', rightSidebarTab !== 'browser' && 'hidden')}>
            <BrowserProviderRail provider={selectedProvider} />
          </div>
        ) : null}
      </div>
    </div>
  );
};
