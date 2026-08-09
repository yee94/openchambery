import React from 'react';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useUIStore } from '@/stores/useUIStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { getSelectedAssistantID, useAssistantUIStore } from '@/stores/useAssistantUIStore';
import { parseRoute, updateBrowserURL, hasRouteParams } from '@/lib/router';
import type { RouteState, AppRouteState } from '@/lib/router';
import type { MainTab } from '@/stores/useUIStore';
import { resolveSettingsSlug } from '@/lib/settings/metadata';
import { isEmbeddedSessionChat } from '@/components/layout/contextPanelEmbeddedChat';
import {
  isRuntimeEndpointIdentityChange,
  subscribeRuntimeEndpointChanged,
} from '@/lib/runtime-switch';
import {
  resolveSessionDirectoryForRoute,
  resolveSessionForRoute,
} from '@/router/sessionLookup';
import { notifySessionOpenFailed } from '@/sync/openSessionWithFeedback';

const SESSION_ROUTE_TIMEOUT_MS = 30_000;

/**
 * Check if running in VS Code webview context.
 */
function isVSCodeContext(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  const win = window as { __VSCODE_CONFIG__?: unknown };
  return win.__VSCODE_CONFIG__ !== undefined;
}

/**
 * Hook that provides bidirectional URL routing for OpenChamber.
 *
 * On mount:
 * - Parses URL parameters and applies them to app state
 * - Sets up subscriptions to sync state changes back to URL
 * - Listens for browser back/forward navigation
 *
 * Works in:
 * - Web: Full bidirectional sync
 * - Desktop: Full bidirectional sync
 * - VS Code: State-only (no URL updates, reads initial params)
 * - Embedded session-chat iframe (`?ocPanel=session-chat`): No URL updates.
 *   The iframe's session identity is fixed at mount (the parent builds the
 *   src with `sessionId`); in-place subtask navigation must NOT rewrite the
 *   URL, otherwise `ocPanel` (and `directory`/`readOnly`) get stripped and
 *   `isEmbeddedSessionChat()` starts returning false, breaking subsequent
 *   "Open subtask" clicks.
 */
export function useRouter(): void {
  const isVSCode = React.useMemo(() => isVSCodeContext(), []);
  // Captured once at mount: the iframe's embedded-ness never changes during
  // its lifetime (a parent src swap is a full reload).
  const isEmbeddedChat = React.useMemo(() => isEmbeddedSessionChat(), []);

  // Track initialization to avoid duplicate applies
  const initializedRef = React.useRef(false);
  const isApplyingRouteRef = React.useRef(false);
  /** Session ids that already surfaced a deep-link failure toast this mount. */
  const failedDeepLinkSessionIdsRef = React.useRef(new Set<string>());
  const [route, setRoute] = React.useState<RouteState>(() => parseRoute());

  // Get store actions (stable references)
  const setCurrentSession = useSessionUIStore((state) => state.setCurrentSession);
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const currentSessionDirectory = useSessionUIStore((state) => state.currentSessionDirectory);
  const setActiveMainTab = useUIStore((state) => state.setActiveMainTab);
  const setSettingsDialogOpen = useUIStore((state) => state.setSettingsDialogOpen);
  const setSettingsPage = useUIStore((state) => state.setSettingsPage);
  const navigateToDiff = useUIStore((state) => state.navigateToDiff);
  const hasLoadedGlobalSessions = useGlobalSessionsStore((state) => state.hasLoaded);
  const activeSessions = useGlobalSessionsStore((state) => state.activeSessions);
  const archivedSessions = useGlobalSessionsStore((state) => state.archivedSessions);

  /**
   * Deep-link failure: keep the user on the session path, show an error toast once
   * per session id, and do NOT clear the URL into a new-session/welcome state.
   * Re-runs of the reconcile effect (index refresh / hasLoaded flips) must not spam.
   * Skip entirely when the live path no longer requests this session (runtime
   * switch / clearStaleSessionPath already rewrote the URL).
   */
  const failDeepLinkSession = React.useCallback((sessionId: string) => {
    if (isVSCode) {
      return;
    }
    // Path may already have been cleared by runtimeEndpointReset while this
    // reconcile still held a stale React route.sessionId — do not re-pin it.
    if (parseRoute().sessionId !== sessionId) {
      return;
    }
    const firstFailure = !failedDeepLinkSessionIdsRef.current.has(sessionId);
    if (firstFailure) {
      failedDeepLinkSessionIdsRef.current.add(sessionId);
      notifySessionOpenFailed(sessionId, 'missing-directory');
    }
    // Preserve path in the address bar so refresh/retry remains possible.
    isApplyingRouteRef.current = true;
    try {
      setSettingsDialogOpen(false);
      setActiveMainTab('chat');
      updateBrowserURL({
        sessionId,
        tab: 'chat',
        isSettingsOpen: false,
        settingsPath: 'home',
        diffFile: null,
      }, { replace: true, force: true });
      setRoute(parseRoute());
    } finally {
      isApplyingRouteRef.current = false;
    }
  }, [isVSCode, setActiveMainTab, setRoute, setSettingsDialogOpen]);

  /**
   * Apply a parsed route state to the application stores.
   */
  const applyRoute = React.useCallback(
    async (route: RouteState) => {
      if (isApplyingRouteRef.current) {
        return;
      }

      isApplyingRouteRef.current = true;

      try {
        // 1. Settings overlay (exclusive)
        if (route.settingsPath) {
          setSettingsPage(resolveSettingsSlug(route.settingsPath));
          setSettingsDialogOpen(true);
          return;
        }

        if (useUIStore.getState().isSettingsDialogOpen) {
          setSettingsDialogOpen(false);
        }

        // 2. Exclusive primaries schedule / assistant — no session path binding
        if (route.tab === 'schedule' || route.tab === 'assistant') {
          setActiveMainTab(route.tab);
          if (route.tab === 'assistant' && route.assistantId) {
            useAssistantUIStore.getState().selectAssistant(route.assistantId);
          }
          return;
        }

        // 2b. New-session draft surface (`/session/new`)
        if (route.isNewSession) {
          setActiveMainTab('chat');
          const draft = useSessionUIStore.getState().newSessionDraft;
          if (!draft.open) {
            useSessionUIStore.getState().openNewSessionDraft();
          }
          return;
        }

        // 3. Session primary: resolve directory (memory → index by-id → session.get)
        if (route.sessionId) {
          const sessionId = route.sessionId;
          let directoryHint = resolveSessionDirectoryForRoute(sessionId);
          if (!directoryHint) {
            // Allow concurrent index hydrate / by-id lookup before giving up.
            isApplyingRouteRef.current = false;
            const resolved = await resolveSessionForRoute(sessionId);
            isApplyingRouteRef.current = true;
            directoryHint = resolved?.directory ?? null;
          }

          const currentSession = useSessionUIStore.getState();
          if (directoryHint) {
            if (
              sessionId !== currentSession.currentSessionId
              || directoryHint !== currentSession.currentSessionDirectory
            ) {
              setCurrentSession(sessionId, directoryHint);
            }
          }
          // If still unresolved, leave store alone — reconcile effect will retry
          // or failDeepLinkSession with a toast (never silent new-session).
        }

        // 4. Apply session tool / plan tab
        if (route.tab) {
          setActiveMainTab(route.tab);
        } else if (route.sessionId) {
          setActiveMainTab('chat');
        }

        // 5. Diff file
        if (route.diffFile && (route.tab === 'diff' || !route.tab)) {
          navigateToDiff(route.diffFile);
        }
      } finally {
        isApplyingRouteRef.current = false;
      }
    },
    [setCurrentSession, setActiveMainTab, setSettingsDialogOpen, setSettingsPage, navigateToDiff]
  );

  /**
   * Get current app state for URL serialization.
   */
  const getCurrentAppState = React.useCallback((): AppRouteState => {
    const sessionState = useSessionUIStore.getState();
    const uiState = useUIStore.getState();
    const pathState = parseRoute();
    const tab = uiState.activeMainTab;
    // New-session draft wins over exclusive primaries once draft is open and
    // no real session is selected (openNewSessionDraft clears currentSessionId).
    const isNewSession = Boolean(sessionState.newSessionDraft?.open)
      && !sessionState.currentSessionId;
    const isExclusive = !isNewSession && (tab === 'schedule' || tab === 'assistant');

    return {
      // Draft surface owns `/session/new` — do not keep a previous session id
      // on the path or deep-link reconcile will re-open the old conversation.
      // Keep path sessionId while store is still resolving a deep link.
      // Runtime identity switches clear stale path session ids in
      // resetAppForRuntimeEndpointChange so this fallback cannot re-pin a
      // previous-runtime conversation.
      isNewSession,
      sessionId: isExclusive || isNewSession
        ? null
        : (sessionState.currentSessionId ?? pathState.sessionId),
      tab: isNewSession
        ? 'chat'
        : isExclusive
          ? tab
          : (uiState.activeMainTab || pathState.tab || 'chat'),
      isSettingsOpen: uiState.isSettingsDialogOpen,
      settingsPath: uiState.settingsPage,
      settingsEntityId: pathState.settingsEntityId,
      diffFile: isExclusive || isNewSession
        ? null
        : (uiState.pendingDiffFile ?? pathState.diffFile),
      diffScope: isExclusive || isNewSession ? null : pathState.diffScope,
      scheduleView: isExclusive && tab === 'schedule' ? pathState.scheduleView : null,
      scheduleProjectId: isExclusive && tab === 'schedule' ? pathState.scheduleProjectId : null,
      scheduleTaskId: isExclusive && tab === 'schedule' ? pathState.scheduleTaskId : null,
      // Prefer live store selection so /assistant/$id updates when user picks one
      assistantId: isExclusive && tab === 'assistant'
        ? (getSelectedAssistantID() ?? pathState.assistantId)
        : null,
      focusSessionId: isExclusive ? pathState.focusSessionId : null,
    };
  }, []);

  /**
   * Sync current app state to URL.
   */
  const syncURLFromState = React.useCallback(
    (options: { replace?: boolean } = {}) => {
      if (isVSCode || isEmbeddedChat || isApplyingRouteRef.current) {
        return;
      }

      const state = getCurrentAppState();
      updateBrowserURL(state, options);
      setRoute(parseRoute());
    },
    [isVSCode, isEmbeddedChat, getCurrentAppState]
  );

  // Initialize: parse URL and apply route on mount
  React.useEffect(() => {
    if (initializedRef.current) {
      return;
    }
    initializedRef.current = true;

    // Only process if URL has route params
    if (!hasRouteParams()) {
      // No route params - just set up sync (URL will update when user navigates)
      return;
    }

    const route = parseRoute();

    // Apply the initial route
    const initializeRoute = async () => {
      await applyRoute(route);

      // After applying, update URL to normalized form (use replaceState).
      // Use the parsed route values instead of an immediate store snapshot so
      // deep links do not briefly normalize `?session=...` back to `/` while
      // the session's directory/message bootstrap is still catching up.
      if (!isVSCode && !isEmbeddedChat) {
        // Prefer route.sessionId so deep links are not wiped while directory resolves.
        // New-session path must not reintroduce a previous session id.
        updateBrowserURL({
          ...getCurrentAppState(),
          isNewSession: route.isNewSession || getCurrentAppState().isNewSession,
          sessionId: route.isNewSession
            ? null
            : (route.sessionId
              ?? useSessionUIStore.getState().currentSessionId
              ?? getCurrentAppState().sessionId),
          tab: route.tab ?? useUIStore.getState().activeMainTab,
          settingsPath: route.settingsPath ?? useUIStore.getState().settingsPage,
          diffFile: route.isNewSession
            ? null
            : (route.diffFile ?? useUIStore.getState().pendingDiffFile),
        }, { replace: true, force: true });
      }
    };

    void initializeRoute();
  }, [applyRoute, getCurrentAppState, isVSCode, isEmbeddedChat]);

  // Deep-link reconcile: memory list, then by-id index, then session.get.
  // Never wipe the URL into a new-session welcome when lookup fails.
  // Skip entirely while on `/session/new` draft or exclusive primaries.
  React.useEffect(() => {
    if (!route.sessionId || route.isNewSession) {
      return;
    }

    let cancelled = false;
    const sessionId = route.sessionId;

    // Live path may already have been cleared by runtime identity switch while
    // React route state still holds the previous-runtime session id.
    if (parseRoute().sessionId !== sessionId) {
      return;
    }

    const alreadyOpen =
      currentSessionId === sessionId && Boolean(currentSessionDirectory);
    if (alreadyOpen) {
      return;
    }

    // A prior hard-fail for this id already toasts once; skip re-resolve churn
    // while the path still holds the dead session (index refresh must not spam).
    if (failedDeepLinkSessionIdsRef.current.has(sessionId)) {
      return;
    }

    const memoryDir = resolveSessionDirectoryForRoute(sessionId);
    if (memoryDir) {
      failedDeepLinkSessionIdsRef.current.delete(sessionId);
      setCurrentSession(sessionId, memoryDir);
      return;
    }

    // Wait for index hydrate before hard-failing; still try by-id immediately.
    void (async () => {
      const resolved = await resolveSessionForRoute(sessionId);
      if (cancelled) return;
      // Path may have been cleared mid-resolve (instance switch).
      if (parseRoute().sessionId !== sessionId) {
        return;
      }
      if (resolved?.directory) {
        failedDeepLinkSessionIdsRef.current.delete(sessionId);
        const current = useSessionUIStore.getState();
        if (
          current.currentSessionId !== sessionId
          || current.currentSessionDirectory !== resolved.directory
        ) {
          setCurrentSession(sessionId, resolved.directory);
        }
        return;
      }
      // Only fail after global lists have loaded (avoid racing cold start).
      if (useGlobalSessionsStore.getState().hasLoaded) {
        failDeepLinkSession(sessionId);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    activeSessions,
    archivedSessions,
    currentSessionDirectory,
    currentSessionId,
    failDeepLinkSession,
    hasLoadedGlobalSessions,
    route.isNewSession,
    route.sessionId,
    setCurrentSession,
  ]);

  React.useEffect(() => {
    const isResolved = currentSessionId === route.sessionId && Boolean(currentSessionDirectory);
    if (!route.sessionId || route.isNewSession || isVSCode || isResolved) {
      return;
    }

    const sessionId = route.sessionId;
    const timeout = setTimeout(() => {
      const currentSession = useSessionUIStore.getState();
      const resolvedWhileWaiting = currentSession.currentSessionId === sessionId
        && Boolean(currentSession.currentSessionDirectory);
      if (parseRoute().sessionId === sessionId && !resolvedWhileWaiting) {
        failDeepLinkSession(sessionId);
      }
    }, SESSION_ROUTE_TIMEOUT_MS);

    return () => clearTimeout(timeout);
  }, [currentSessionDirectory, currentSessionId, failDeepLinkSession, isVSCode, route.sessionId]);

  // Subscribe to session + new-session draft changes (URL authority)
  React.useEffect(() => {
    if (isVSCode || isEmbeddedChat) {
      return;
    }

    let prevSessionId: string | null = useSessionUIStore.getState().currentSessionId;
    let prevDraftOpen = Boolean(useSessionUIStore.getState().newSessionDraft?.open);

    const unsubscribe = useSessionUIStore.subscribe((state) => {
      const sessionId = state.currentSessionId;
      const draftOpen = Boolean(state.newSessionDraft?.open);

      // Skip if no relevant change or if we're currently applying a route
      if (
        (sessionId === prevSessionId && draftOpen === prevDraftOpen)
        || isApplyingRouteRef.current
      ) {
        return;
      }

      prevSessionId = sessionId;
      prevDraftOpen = draftOpen;
      syncURLFromState();
      setRoute(parseRoute());
    });

    return unsubscribe;
  }, [isVSCode, isEmbeddedChat, syncURLFromState]);

  // Subscribe to UI store changes (tab, settings)
  React.useEffect(() => {
    if (isVSCode || isEmbeddedChat) {
      return;
    }

    let prevTab: MainTab = useUIStore.getState().activeMainTab;
    let prevSettingsOpen: boolean = useUIStore.getState().isSettingsDialogOpen;
    let prevSettingsPath: string = useUIStore.getState().settingsPage;
    let prevDiffFile: string | null = useUIStore.getState().pendingDiffFile;

    const unsubscribe = useUIStore.subscribe((state) => {
      // Skip if we're currently applying a route
      if (isApplyingRouteRef.current) {
        return;
      }

      const tabChanged = state.activeMainTab !== prevTab;
      const settingsOpenChanged = state.isSettingsDialogOpen !== prevSettingsOpen;
      const settingsPathChanged = state.settingsPage !== prevSettingsPath;
      const diffFileChanged = state.pendingDiffFile !== prevDiffFile && state.activeMainTab === 'diff';

      // Update tracking vars
      prevTab = state.activeMainTab;
      prevSettingsOpen = state.isSettingsDialogOpen;
      prevSettingsPath = state.settingsPage;
      prevDiffFile = state.pendingDiffFile;

      // Only sync if something relevant changed
      if (tabChanged || settingsOpenChanged || settingsPathChanged || diffFileChanged) {
        syncURLFromState();
      }
    });

    return unsubscribe;
  }, [isVSCode, isEmbeddedChat, syncURLFromState]);

  // Assistant selection → /assistant/$id (store is source when picking in UI)
  React.useEffect(() => {
    if (isVSCode || isEmbeddedChat) {
      return;
    }

    let prevAssistantId = getSelectedAssistantID();

    const unsubscribe = useAssistantUIStore.subscribe(() => {
      if (isApplyingRouteRef.current) {
        return;
      }
      if (useUIStore.getState().activeMainTab !== 'assistant') {
        prevAssistantId = getSelectedAssistantID();
        return;
      }
      const nextId = getSelectedAssistantID();
      if (nextId === prevAssistantId) {
        return;
      }
      prevAssistantId = nextId;
      syncURLFromState();
    });

    return unsubscribe;
  }, [isVSCode, isEmbeddedChat, syncURLFromState]);

  // Listen for browser back/forward navigation
  React.useEffect(() => {
    if (typeof window === 'undefined' || isVSCode || isEmbeddedChat) {
      return;
    }

    const handlePopState = () => {
      // Parse the new URL and apply it
      const nextRoute = parseRoute();
      setRoute(nextRoute);

      // Check if this is a route with any params, or if we should restore defaults
      if (hasRouteParams()) {
        void applyRoute(nextRoute);
      } else {
        // URL has no route params - this might be a "back to home" navigation
        // Close settings if open, keep current session
        const uiState = useUIStore.getState();
        if (uiState.isSettingsDialogOpen) {
          setSettingsDialogOpen(false);
        }
        // Reset to chat tab if not already there
        if (uiState.activeMainTab !== 'chat') {
          setActiveMainTab('chat');
        }
      }
    };

    window.addEventListener('popstate', handlePopState);

    return () => {
      window.removeEventListener('popstate', handlePopState);
    };
  }, [applyRoute, isVSCode, isEmbeddedChat, setActiveMainTab, setSettingsDialogOpen]);

  // Identity runtime switch rewrites history via runtimeEndpointReset without
  // popstate. Re-parse path into React route state and drop stale deep-link
  // failure bookkeeping so reconcile cannot re-pin a previous-runtime session.
  // queueMicrotask: MobileApp/App clear the path in the same event turn; re-parse
  // after every sync listener finishes so we do not snapshot the pre-clear URL.
  React.useEffect(() => {
    if (isVSCode || isEmbeddedChat) {
      return;
    }

    return subscribeRuntimeEndpointChanged((detail) => {
      if (!isRuntimeEndpointIdentityChange(detail)) {
        return;
      }
      failedDeepLinkSessionIdsRef.current.clear();
      queueMicrotask(() => {
        setRoute(parseRoute());
      });
    });
  }, [isVSCode, isEmbeddedChat]);
}
