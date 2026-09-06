import { useState } from 'react';

import { LynxChatScreen } from '../chat/ChatScreen';
import { shouldPaintLynxDock, type LynxHostGlobalProps } from '../host/embedding';
import { LynxPage, LynxView } from '../lynx-elements';
import type { LynxRuntimeFetch } from '../runtime/fetch';
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
  /** Optional connect runtime for chat send/stop/queue + transcript fetch. */
  runtimeFetch?: LynxRuntimeFetch | null;
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

export function LynxShellApp({
  host,
  initialState = INITIAL_LYNX_NAVIGATION_STATE,
  runtimeFetch = null,
}: LynxShellAppProps) {
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

  const secondary = navigation.secondary;
  const chatRoute = secondary?.kind === 'chat' ? secondary.routes.at(-1) : null;

  return (
    <LynxPage
      auto-height
      style={{
        flexGrow: 1,
        backgroundColor: cssVar('surface.background'),
      }}
    >
      <LynxView style={{ flexGrow: 1 }}>
        {chatRoute ? (
          <LynxChatScreen
            locale={host.locale}
            sessionId={chatRoute.sessionId}
            directory={chatRoute.directory}
            onBack={closeSecondary}
            runtimeFetch={runtimeFetch}
          />
        ) : secondary ? (
          <SecondaryStubPage
            locale={host.locale}
            kind={secondary.kind}
            onBack={closeSecondary}
          />
        ) : (
          <RootTab
            tab={navigation.activeTab}
            locale={host.locale}
            onOpenStubChat={openStubChat}
          />
        )}
      </LynxView>
      <LynxDock
        host={host}
        activeTab={navigation.activeTab}
        visible={dockVisible}
        onTabSelected={selectTab}
      />
    </LynxPage>
  );
}
