import { useState } from 'react';

import type { LynxAssistantDTO } from '../assistants/types';
import { LynxChatScreen } from '../chat/ChatScreen';
import { shouldPaintLynxDock, type LynxHostGlobalProps } from '../host/embedding';
import { lynxT } from '../i18n/catalog';
import { LynxPage, LynxText, LynxView } from '../lynx-elements';
import type { LynxRuntimeFetch } from '../runtime/fetch';
import type { LynxHomeSessionRow } from '../session-index/homeModel';
import type { createSessionIndexHomeBindings } from '../session-index/store';
import { cssVar } from '../theme/tokens';
import { LynxDock } from './Dock';
import {
  INITIAL_LYNX_NAVIGATION_STATE,
  reduceLynxNavigation,
  type LynxNavigationState,
} from './navigation';
import { AssistantTab } from './screens/AssistantTab';
import { ProjectsHome, type ProjectsHomeBindings } from './screens/ProjectsHome';
import { ScheduledTab } from './screens/ScheduledTab';
import { SecondaryStubPage } from './screens/SecondaryStubPage';
import { SettingsTab } from './screens/SettingsTab';
import type { LynxTabId } from './tabs';

export type LynxShellAppProps = {
  host: LynxHostGlobalProps;
  initialState?: LynxNavigationState;
  /** Optional connect runtime for chat send/stop/queue + tab APIs. */
  runtimeFetch?: LynxRuntimeFetch | null;
  /** Session-index home bindings from connect (#36). */
  sessionIndexBindings?: ProjectsHomeBindings | ReturnType<typeof createSessionIndexHomeBindings> | null;
};

function RootTab({
  tab,
  locale,
  runtimeFetch,
  sessionIndexBindings,
  onOpenSession,
  onOpenDraft,
  onOpenAssistantConversation,
  onOpenAssistantNeedsSession,
  onOpenScheduledRun,
}: {
  tab: LynxTabId;
  locale: string;
  runtimeFetch: LynxRuntimeFetch | null;
  sessionIndexBindings: ProjectsHomeBindings | null;
  onOpenSession: (session: LynxHomeSessionRow) => void;
  onOpenDraft: () => void;
  onOpenAssistantConversation: (assistant: LynxAssistantDTO) => void;
  onOpenAssistantNeedsSession: (assistant: LynxAssistantDTO) => void;
  onOpenScheduledRun: (sessionId: string, directory: string | null) => void;
}) {
  switch (tab) {
    case 'projects':
      return (
        <ProjectsHome
          locale={locale}
          bindings={sessionIndexBindings}
          onOpenSession={onOpenSession}
          onOpenDraft={onOpenDraft}
        />
      );
    case 'assistant':
      return (
        <AssistantTab
          locale={locale}
          runtimeFetch={runtimeFetch}
          onOpenConversation={onOpenAssistantConversation}
          onOpenNeedsSession={onOpenAssistantNeedsSession}
        />
      );
    case 'scheduled':
      return (
        <ScheduledTab
          locale={locale}
          runtimeFetch={runtimeFetch}
          onOpenRunSession={(run) => {
            if (run.sessionId) onOpenScheduledRun(run.sessionId, run.directory);
          }}
        />
      );
    case 'settings':
      return <SettingsTab locale={locale} />;
  }
}

export function LynxShellApp({
  host,
  initialState = INITIAL_LYNX_NAVIGATION_STATE,
  runtimeFetch = null,
  sessionIndexBindings = null,
}: LynxShellAppProps) {
  const [navigation, setNavigation] = useState(initialState);
  const [assistantNeedsSessionNote, setAssistantNeedsSessionNote] = useState<string | null>(null);
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
    setAssistantNeedsSessionNote(null);
    setNavigation((state) => reduceLynxNavigation(state, { type: 'setActiveTab', tab }));
  };

  const closeSecondary = () => {
    setNavigation((state) => reduceLynxNavigation(state, { type: 'closeSecondary' }));
  };

  const openSession = (session: LynxHomeSessionRow) => {
    setNavigation((state) => reduceLynxNavigation(state, {
      type: 'openChat',
      sessionId: session.id,
      directory: session.directory,
    }));
  };

  const openDraft = () => {
    setNavigation((state) => reduceLynxNavigation(state, { type: 'openDraft' }));
  };

  const openAssistantConversation = (assistant: LynxAssistantDTO) => {
    setAssistantNeedsSessionNote(null);
    setNavigation((state) => reduceLynxNavigation(state, {
      type: 'openAssistant',
      assistantId: assistant.id,
      sessionId: assistant.sessionID,
      directory: assistant.effectiveWorkspacePath,
      title: assistant.name,
    }));
  };

  const openAssistantNeedsSession = (assistant: LynxAssistantDTO) => {
    setAssistantNeedsSessionNote(
      `${lynxT(host.locale, 'lynx.assistant.openNeedsSession')}: ${assistant.name}`,
    );
    setNavigation((state) => reduceLynxNavigation(state, {
      type: 'openAssistant',
      assistantId: assistant.id,
      sessionId: null,
      directory: assistant.effectiveWorkspacePath,
      title: assistant.name,
    }));
  };

  const secondary = navigation.secondary;
  const chatRoute = secondary?.kind === 'chat' ? secondary.routes.at(-1) : null;
  const assistantRoute = secondary?.kind === 'assistant' ? secondary : null;

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
        ) : assistantRoute?.sessionId ? (
          <LynxChatScreen
            locale={host.locale}
            sessionId={assistantRoute.sessionId}
            directory={assistantRoute.directory}
            onBack={closeSecondary}
            runtimeFetch={runtimeFetch}
            title={assistantRoute.title ?? undefined}
          />
        ) : secondary?.kind === 'draft' ? (
          <SecondaryStubPage
            locale={host.locale}
            kind="draft"
            onBack={closeSecondary}
          />
        ) : assistantRoute ? (
          <LynxView style={{ flexGrow: 1, backgroundColor: cssVar('surface.background') }}>
            <LynxView style={{ flexDirection: 'row', padding: '12px 16px', alignItems: 'center' }}>
              <LynxView bindtap={closeSecondary} accessibility-label={lynxT(host.locale, 'lynx.shell.back')}>
                <LynxText style={{ color: cssVar('primary.base') }}>
                  {lynxT(host.locale, 'lynx.shell.back')}
                </LynxText>
              </LynxView>
              <LynxText
                style={{
                  marginLeft: '12px',
                  color: cssVar('surface.foreground'),
                  fontWeight: '600',
                }}
              >
                {assistantRoute.title || lynxT(host.locale, 'mobile.tabs.assistant')}
              </LynxText>
            </LynxView>
            <LynxText style={{ padding: '16px', color: cssVar('surface.mutedForeground') }}>
              {assistantNeedsSessionNote || lynxT(host.locale, 'lynx.assistant.openNeedsSession')}
            </LynxText>
          </LynxView>
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
            runtimeFetch={runtimeFetch}
            sessionIndexBindings={sessionIndexBindings}
            onOpenSession={openSession}
            onOpenDraft={openDraft}
            onOpenAssistantConversation={openAssistantConversation}
            onOpenAssistantNeedsSession={openAssistantNeedsSession}
            onOpenScheduledRun={(sessionId, directory) => {
              setNavigation((state) => reduceLynxNavigation(state, {
                type: 'openChat',
                sessionId,
                directory,
              }));
            }}
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
