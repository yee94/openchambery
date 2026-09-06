import { useState } from 'react';

import { shouldPaintLynxDock, type LynxHostGlobalProps } from '../host/embedding';
import { cssVar } from '../theme/tokens';
import { LynxDock } from './Dock';
import {
  INITIAL_LYNX_NAVIGATION_STATE,
  reduceLynxNavigation,
  type LynxNavigationState,
} from './navigation';
import { AssistantTab } from './screens/AssistantTab';
import { ProjectsHome } from './screens/ProjectsHome';
import { ScheduledTab } from './screens/ScheduledTab';
import { SecondaryStubPage } from './screens/SecondaryStubPage';
import { SettingsTab } from './screens/SettingsTab';
import type { LynxTabId } from './tabs';

export type LynxShellAppProps = {
  host: LynxHostGlobalProps;
  initialState?: LynxNavigationState;
};

function RootTab({
  tab,
  locale,
  onOpenStubChat,
}: {
  tab: LynxTabId;
  locale: string;
  onOpenStubChat: () => void;
}) {
  switch (tab) {
    case 'projects':
      return <ProjectsHome locale={locale} onOpenStubChat={onOpenStubChat} />;
    case 'assistant':
      return <AssistantTab locale={locale} />;
    case 'scheduled':
      return <ScheduledTab locale={locale} />;
    case 'settings':
      return <SettingsTab locale={locale} />;
  }
}

export function LynxShellApp({ host, initialState = INITIAL_LYNX_NAVIGATION_STATE }: LynxShellAppProps) {
  const [navigation, setNavigation] = useState(initialState);
  const fullPageAutoGlassSkin = host.chromeOwner === 'lynx';
  const dockVisible = shouldPaintLynxDock({
    embedding: {
      mode: host.embeddingMode,
      chromeOwner: host.chromeOwner,
      paintsLynxDock: host.chromeOwner === 'lynx',
      fullPageAutoGlassSkin,
      androidGlassDowngrade: host.platform === 'android',
    },
    navigation,
  });

  const selectTab = (tab: LynxTabId) => {
    setNavigation((state) => reduceLynxNavigation(state, { type: 'setActiveTab', tab }));
  };

  const closeSecondary = () => {
    setNavigation((state) => reduceLynxNavigation(state, { type: 'closeSecondary' }));
  };

  const openStubChat = () => {
    setNavigation((state) => reduceLynxNavigation(state, {
      type: 'openChat',
      sessionId: 'stub-session',
      directory: null,
    }));
  };

  return (
    <page
      auto-height
      style={{
        flexGrow: 1,
        backgroundColor: cssVar('surface.background'),
      }}
    >
      <view style={{ flexGrow: 1 }}>
        {navigation.secondary ? (
          <SecondaryStubPage
            locale={host.locale}
            kind={navigation.secondary.kind}
            onBack={closeSecondary}
          />
        ) : (
          <RootTab
            tab={navigation.activeTab}
            locale={host.locale}
            onOpenStubChat={openStubChat}
          />
        )}
      </view>
      <LynxDock
        host={host}
        activeTab={navigation.activeTab}
        visible={dockVisible}
        onTabSelected={selectTab}
      />
    </page>
  );
}
