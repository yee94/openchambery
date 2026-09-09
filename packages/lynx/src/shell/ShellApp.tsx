import { useEffect, useMemo, useState } from 'react';

import { ensureAssistantSession } from '../assistants/api';
import { LynxShareBridge } from '../assistants/ShareBridge';
import { createLynxShareInbox, type LynxShareInbox } from '../assistants/shareInbox';
import type { LynxAssistantDTO } from '../assistants/types';
import { LynxChatScreen } from '../chat/ChatScreen';
import { LynxSessionsSheet } from '../chat/SessionsSheet';
import { relatedSessionsFromSessionIndex } from '../chat/sessionStatusBar';
import { LynxDraftComposer } from '../chat/DraftComposer';
import { LynxChatSheet } from '../chat/ChatSheets';
import type { LynxChatSheetKind } from '../chat/overflowMenu';
import {
  registerLynxDeepLinkHandlers,
  setLynxDeepLinkConnectReady,
  type LynxDeepLinkNavCommand,
} from '../deep-links/apply';
import { isLynxMobileSettingsSlug, type LynxMobileSettingsSlug } from '../settings/slugs';
import { shouldPaintLynxDock, type LynxHostGlobalProps } from '../host/embedding';
import { lynxT } from '../i18n/catalog';
import { LynxText, LynxView } from '../lynx-elements';
import type { LynxRuntimeFetch } from '../runtime/fetch';
import type { LynxConnectionClient } from '../connection/client';
import type { LynxSavedConnection } from '../connection/types';
import type { SettingsBodyContext } from '../settings/SettingsBodies';
import type { LynxHomeSessionRow } from '../session-index/homeModel';
import type { createSessionIndexHomeBindings } from '../session-index/store';
import { cssVar } from '../theme/tokens';
import { LynxDock } from './Dock';
import { LynxShellDialogPortalProvider } from './DialogPortal';
import {
  INITIAL_LYNX_NAVIGATION_STATE,
  lynxChatStackWindow,
  reduceLynxNavigation,
  resolveLynxSecondaryBackDecision,
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
  connectionClient?: LynxConnectionClient | null;
  connections?: LynxSavedConnection[];
  onConnectionsChange?: (connections: LynxSavedConnection[]) => void;
  onConnected?: () => void;
  lynxClientVersion?: string;
  /** Cap MobileShareBridge inbox — host injects Android share drafts here. */
  shareInbox?: LynxShareInbox;
};

function RootTab({
  tab,
  locale,
  host,
  fullPageAutoGlassSkin,
  runtimeFetch,
  sessionIndexBindings,
  settingsBodyContext,
  onOpenSession,
  onOpenDraft,
  onOpenAssistantConversation,
  onOpenAssistantNeedsSession,
  onOpenScheduledRun,
  onOpenAssistantSettings,
  onOpenAssistantsSettings,
  settingsInitialSlug,
}: {
  tab: LynxTabId;
  locale: string;
  host: LynxHostGlobalProps;
  fullPageAutoGlassSkin: boolean;
  runtimeFetch: LynxRuntimeFetch | null;
  sessionIndexBindings: ProjectsHomeBindings | null;
  settingsBodyContext: SettingsBodyContext;
  onOpenSession: (session: LynxHomeSessionRow) => void;
  onOpenDraft: (directory?: string | null) => void;
  onOpenAssistantConversation: (assistant: LynxAssistantDTO) => void;
  onOpenAssistantNeedsSession: (assistant: LynxAssistantDTO) => void;
  onOpenScheduledRun: (sessionId: string, directory: string | null) => void;
  onOpenAssistantSettings: (assistantId: string) => void;
  onOpenAssistantsSettings: () => void;
  settingsInitialSlug: LynxMobileSettingsSlug | null;
}) {
  switch (tab) {
    case 'projects':
      return (
        <ProjectsHome
          locale={locale}
          host={host}
          fullPageAutoGlassSkin={fullPageAutoGlassSkin}
          bindings={sessionIndexBindings}
          runtimeFetch={runtimeFetch}
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
          onOpenAssistantSettings={onOpenAssistantSettings}
          onOpenAssistantsSettings={onOpenAssistantsSettings}
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
      return <SettingsTab locale={locale} bodyContext={settingsBodyContext} initialSlug={settingsInitialSlug} />;
  }
}

export function LynxShellApp({
  host,
  initialState = INITIAL_LYNX_NAVIGATION_STATE,
  runtimeFetch = null,
  sessionIndexBindings = null,
  connectionClient = null,
  connections = [],
  onConnectionsChange,
  onConnected,
  lynxClientVersion = '1.19.7-beta.7',
  shareInbox: shareInboxProp,
}: LynxShellAppProps) {
  const [navigation, setNavigation] = useState(initialState);
  const [shareInbox] = useState(() => shareInboxProp ?? createLynxShareInbox());
  const [assistantNeedsSessionNote, setAssistantNeedsSessionNote] = useState<string | null>(null);
  const [settingsInitialSlug, setSettingsInitialSlug] = useState<LynxMobileSettingsSlug | null>(null);
  const [assistantsFocusId, setAssistantsFocusId] = useState<string | null>(null);
  const [chatSheet, setChatSheet] = useState<LynxChatSheetKind | null>(null);
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
    setChatSheet(null);
    if (tab !== 'settings') {
      setSettingsInitialSlug(null);
      setAssistantsFocusId(null);
    }
    setNavigation((state) => reduceLynxNavigation(state, { type: 'setActiveTab', tab }));
  };

  const closeSecondary = () => {
    setNavigation((state) => {
      const decision = resolveLynxSecondaryBackDecision({
        secondary: state.secondary,
        parentSessionTarget: null,
      });
      if (decision.action === 'popChatSession') {
        return reduceLynxNavigation(state, { type: 'popChat' });
      }
      return reduceLynxNavigation(state, { type: 'closeSecondary' });
    });
  };

  const openSession = (session: LynxHomeSessionRow) => {
    setNavigation((state) => reduceLynxNavigation(state, {
      type: 'openChat',
      sessionId: session.id,
      directory: session.directory,
    }));
  };

  const openDraft = (directory?: string | null) => {
    setNavigation((state) => reduceLynxNavigation(state, {
      type: 'openDraft',
      directory: directory ?? null,
    }));
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
    // Cap AssistantView: ensure only while unbound — never invent a chat id.
    setNavigation((state) => reduceLynxNavigation(state, {
      type: 'openAssistant',
      assistantId: assistant.id,
      sessionId: null,
      directory: assistant.effectiveWorkspacePath,
      title: assistant.name,
    }));

    if (!runtimeFetch) {
      setAssistantNeedsSessionNote(
        `${lynxT(host.locale, 'lynx.assistant.openNeedsSession')}: ${assistant.name}`,
      );
      return;
    }

    setAssistantNeedsSessionNote(lynxT(host.locale, 'lynx.assistant.ensuring'));
    void (async () => {
      try {
        const binding = await ensureAssistantSession(runtimeFetch, assistant.id);
        if (!binding.sessionID) {
          setAssistantNeedsSessionNote(
            lynxT(host.locale, 'lynx.assistant.ensureUnbound'),
          );
          return;
        }
        setAssistantNeedsSessionNote(null);
        setNavigation((state) => reduceLynxNavigation(state, {
          type: 'openAssistant',
          assistantId: assistant.id,
          sessionId: binding.sessionID,
          directory: binding.directory || assistant.effectiveWorkspacePath,
          title: assistant.name,
        }));
      } catch (error) {
        setAssistantNeedsSessionNote(
          `${lynxT(host.locale, 'lynx.assistant.ensureFailed')}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    })();
  };

  useEffect(() => {
    setLynxDeepLinkConnectReady(Boolean(runtimeFetch));
    const applyNav = (command: LynxDeepLinkNavCommand): boolean => {
      switch (command.type) {
        case 'openChat':
          setChatSheet(null);
          setNavigation((state) => reduceLynxNavigation(state, {
            type: 'openChat',
            sessionId: command.sessionId,
            directory: command.directory ?? null,
          }));
          return true;
        case 'openDraft':
          setChatSheet(null);
          setNavigation((state) => reduceLynxNavigation(state, { type: 'openDraft' }));
          return true;
        case 'setTab':
          setChatSheet(null);
          setSettingsInitialSlug(null);
          setAssistantsFocusId(null);
          setNavigation((state) => reduceLynxNavigation(state, {
            type: 'setActiveTab',
            tab: command.tab,
          }));
          return true;
        case 'openSettings': {
          const section = command.section;
          setChatSheet(null);
          setSettingsInitialSlug(isLynxMobileSettingsSlug(section) ? section : null);
          setNavigation((state) => reduceLynxNavigation(state, {
            type: 'setActiveTab',
            tab: 'settings',
          }));
          return true;
        }
        case 'openInstances':
          setChatSheet(null);
          setNavigation((state) => reduceLynxNavigation(state, { type: 'openInstances' }));
          return true;
        case 'openSheet':
          setChatSheet(command.sheet);
          // Sheets need an active chat; if none, open draft so navigation still resolves.
          setNavigation((state) => {
            if (state.secondary?.kind === 'chat' || state.secondary?.kind === 'assistant') {
              return state;
            }
            return reduceLynxNavigation(state, { type: 'openDraft' });
          });
          return true;
        case 'connect':
          return false;
      }
    };
    registerLynxDeepLinkHandlers({ applyNav });
    return () => {
      registerLynxDeepLinkHandlers(null);
      setLynxDeepLinkConnectReady(false);
    };
  }, [runtimeFetch]);

  const settingsBodyContext: SettingsBodyContext = {
    locale: host.locale,
    runtimeFetch,
    lynxClientVersion,
    connectionClient,
    connections,
    onConnectionsChange,
    onConnected,
    assistantsFocusId,
    clearAssistantsFocusId: () => setAssistantsFocusId(null),
  };

  const secondary = navigation.secondary;
  const chatRoutes = secondary?.kind === 'chat' ? secondary.routes : [];
  const chatWindow = lynxChatStackWindow(chatRoutes);
  const chatRoute = chatWindow.top;
  const chatPredecessor = chatWindow.predecessor;
  const assistantRoute = secondary?.kind === 'assistant' ? secondary : null;
  const sheetDirectory = chatRoute?.directory
    ?? (assistantRoute?.sessionId ? assistantRoute.directory : null)
    ?? null;
  const showDetachedSheet = Boolean(chatSheet) && !chatRoute && !assistantRoute?.sessionId;

  // Cap MobileSessionStatusBar related list — session-index snapshot when connected.
  const [sessionIndexState, setSessionIndexState] = useState(() => sessionIndexBindings?.getSnapshot() ?? null);
  const [sessionsSheetOpen, setSessionsSheetOpen] = useState(false);
  useEffect(() => {
    if (!sessionIndexBindings) {
      setSessionIndexState(null);
      return;
    }
    setSessionIndexState(sessionIndexBindings.getSnapshot());
    return sessionIndexBindings.subscribe(() => {
      setSessionIndexState(sessionIndexBindings.getSnapshot());
    });
  }, [sessionIndexBindings]);

  const statusBarSessionId = chatRoute?.sessionId ?? assistantRoute?.sessionId ?? null;
  const statusBarDirectory = chatRoute?.directory
    ?? (assistantRoute?.sessionId ? assistantRoute.directory : null)
    ?? null;
  const relatedSessions = useMemo(() => {
    if (!statusBarSessionId) return [];
    return relatedSessionsFromSessionIndex({
      snapshot: sessionIndexState?.snapshot ?? null,
      currentSessionId: statusBarSessionId,
      directory: statusBarDirectory,
    });
  }, [sessionIndexState, statusBarDirectory, statusBarSessionId]);
  const orderedSessionIds = useMemo(
    () => relatedSessions.map((session) => session.id),
    [relatedSessions],
  );

  const selectRelatedSession = (sessionId: string) => {
    const hit = relatedSessions.find((session) => session.id === sessionId);
    setNavigation((state) => reduceLynxNavigation(state, {
      type: 'openChat',
      sessionId,
      directory: hit?.directory ?? statusBarDirectory,
    }));
  };

  /** Cap full sessions sheet — LynxMobileResizableSheet from slim status bar. */
  const openSessionsSheet = () => {
    setSessionsSheetOpen(true);
  };

  const selectSessionFromSheet = (sessionId: string, directory: string | null) => {
    setSessionsSheetOpen(false);
    setNavigation((state) => reduceLynxNavigation(state, {
      type: 'openChat',
      sessionId,
      directory,
    }));
  };


  // Outer root <page> lives in App — keep shell content as <view> to avoid nested pages.
  return (
    <LynxView
      style={{
        flexGrow: 1,
        width: '100%',
        height: '100%',
        position: 'relative',
        backgroundColor: cssVar('surface.background'),
      }}
    >
      <LynxShellDialogPortalProvider>
      <LynxView style={{ flexGrow: 1 }}>
        {showDetachedSheet && chatSheet ? (
          <LynxChatSheet
            locale={host.locale}
            kind={chatSheet}
            directory={sheetDirectory}
            runtimeFetch={runtimeFetch}
            host={host}
            fullPageAutoGlassSkin={fullPageAutoGlassSkin}
            onBack={() => setChatSheet(null)}
          />
        ) : chatRoute ? (
          <LynxChatScreen
            locale={host.locale}
            host={host}
            fullPageAutoGlassSkin={fullPageAutoGlassSkin}
            sessionId={chatRoute.sessionId}
            directory={chatRoute.directory}
            onBack={() => {
              setChatSheet(null);
              closeSecondary();
            }}
            runtimeFetch={runtimeFetch}
            initialSheet={chatSheet}
            onSheetClosed={() => setChatSheet(null)}
            onOpenDraft={openDraft}
            predecessor={chatPredecessor}
            orderedSessionIds={orderedSessionIds}
            relatedSessions={relatedSessions}
            onSelectRelatedSession={selectRelatedSession}
            onSessionSwipe={(_direction, targetId) => selectRelatedSession(targetId)}
            onOpenSessionsSheet={openSessionsSheet}
          />
        ) : assistantRoute?.sessionId ? (
          <LynxChatScreen
            locale={host.locale}
            host={host}
            fullPageAutoGlassSkin={fullPageAutoGlassSkin}
            sessionId={assistantRoute.sessionId}
            directory={assistantRoute.directory}
            onBack={() => {
              setChatSheet(null);
              closeSecondary();
            }}
            runtimeFetch={runtimeFetch}
            title={assistantRoute.title ?? undefined}
            initialSheet={chatSheet}
            onSheetClosed={() => setChatSheet(null)}
            onOpenDraft={openDraft}
            orderedSessionIds={orderedSessionIds}
            relatedSessions={relatedSessions}
            onSelectRelatedSession={selectRelatedSession}
            onSessionSwipe={(_direction, targetId) => selectRelatedSession(targetId)}
            onOpenSessionsSheet={openSessionsSheet}
          />
        ) : secondary?.kind === 'draft' ? (
          <LynxDraftComposer
            locale={host.locale}
            host={host}
            fullPageAutoGlassSkin={fullPageAutoGlassSkin}
            onBack={closeSecondary}
            runtimeFetch={runtimeFetch}
            directory={secondary.directory ?? null}
            onMaterialized={({ sessionId, directory }) => {
              setNavigation((state) => reduceLynxNavigation(state, {
                type: 'openChat',
                sessionId,
                directory,
              }));
            }}
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
            host={host}
            fullPageAutoGlassSkin={fullPageAutoGlassSkin}
            runtimeFetch={runtimeFetch}
            sessionIndexBindings={sessionIndexBindings}
            settingsBodyContext={settingsBodyContext}
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
            onOpenAssistantSettings={(assistantId) => {
              setAssistantsFocusId(assistantId);
              setSettingsInitialSlug('assistants');
              setNavigation((state) => reduceLynxNavigation(state, {
                type: 'setActiveTab',
                tab: 'settings',
              }));
            }}
            onOpenAssistantsSettings={() => {
              setAssistantsFocusId(null);
              setSettingsInitialSlug('assistants');
              setNavigation((state) => reduceLynxNavigation(state, {
                type: 'setActiveTab',
                tab: 'settings',
              }));
            }}
            settingsInitialSlug={settingsInitialSlug}
          />
        )}
      </LynxView>
      <LynxDock
        host={host}
        activeTab={navigation.activeTab}
        visible={dockVisible}
        onTabSelected={selectTab}
      />
      <LynxSessionsSheet
        locale={host.locale}
        open={sessionsSheetOpen}
        onClose={() => setSessionsSheetOpen(false)}
        indexState={sessionIndexState}
        runtimeFetch={runtimeFetch}
        activeDirectory={statusBarDirectory}
        currentSessionId={statusBarSessionId}
        onSelectSession={selectSessionFromSheet}
        onOpenDraft={(directory) => {
          setSessionsSheetOpen(false);
          openDraft(directory);
        }}
        onMutated={() => {
          void sessionIndexBindings?.refresh?.();
        }}
      />
      <LynxShareBridge
        locale={host.locale}
        runtimeFetch={runtimeFetch}
        inbox={shareInbox}
        connectionKey={connections[0]?.id ?? ''}
        serverLabel={connections[0]?.label ?? 'OpenChamber'}
        onDelivered={(assistantID) => {
          setNavigation((state) => reduceLynxNavigation(state, {
            type: 'openAssistant',
            assistantId: assistantID,
            sessionId: null,
            directory: null,
            title: assistantID,
          }));
        }}
      />
      </LynxShellDialogPortalProvider>
    </LynxView>
  );
}
