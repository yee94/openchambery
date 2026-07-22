import React from 'react';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSelectionStore } from '@/sync/selection-store';
import * as sessionActions from '@/sync/session-actions';
import { useUIStore } from '@/stores/useUIStore';
import { LEADER_KEY_TIMEOUT_MS, useLeaderKeyStore } from '@/stores/useLeaderKeyStore';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useAssistantStatus } from '@/hooks/useAssistantStatus';
import { createWorktreeSession } from '@/lib/worktreeSessionCreator';
import { useConfigStore } from '@/stores/useConfigStore';
import { canUseElectronDesktopIPC, invokeDesktop, isVSCodeRuntime } from '@/lib/desktop';
import { showOpenCodeStatus } from '@/lib/openCodeStatus';
import { eventMatchesShortcut, eventMatchesZoomShortcut, getEffectiveShortcutCombo, getEffectiveShortcutCombos, normalizeCombo } from '@/lib/shortcuts';
import { readEmbeddedThemeSearchParams } from '@/contexts/theme-embedded-bootstrap';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { getActiveChatInputSurface, isChatComposerMainTab } from '@/components/chat/activeChatInputSurface';
import { createChatInputControllerWiring } from '@/components/chat/chatInputSurfaceWiring';
import { getCycledPrimaryAgentName } from '@/components/chat/mobileControlsUtils';
import { navigateAdjacentSession } from '@/sync/session-navigation';
import { resetWebviewZoom, zoomWebviewIn, zoomWebviewOut } from '@/lib/webviewZoom';
import { resolveEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { opencodeClient } from '@/lib/opencode/client';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { activateSidebarNumberedSession } from '@/sync/sidebar-numbered-navigation';
import {
  closeActiveTerminalTab,
  createAndActivateTerminalTab,
  openAndCreateTerminalTab,
  switchTerminalTab,
} from '@/lib/terminalTabShortcuts';
import {
  EMBEDDED_SESSION_CHAT_CLOSE_TAB_EVENT,
  isEmbeddedSessionChatSearch,
} from '@/components/layout/contextPanelEmbeddedChat';

// Context-panel chat tabs run in a separate iframe with their own UI store. A
// close shortcut therefore has to be handled by the parent, which owns the tab.
const requestEmbeddedSessionChatTabClose = (): boolean => {
  if (typeof window === 'undefined' || window.parent === window) {
    return false;
  }

  if (!isEmbeddedSessionChatSearch(window.location.search)) {
    return false;
  }

  window.parent.postMessage({ type: EMBEDDED_SESSION_CHAT_CLOSE_TAB_EVENT }, window.location.origin);
  return true;
};

// Close the active context-panel tab when open; otherwise close the desktop window.
// Returns true when the shortcut was consumed (caller should preventDefault).
const handleCloseContextPanelTabOrWindow = (): boolean => {
  const { isMobile, closeActiveContextPanelTab } = useUIStore.getState();
  if (isMobile) {
    return false;
  }

  const directory = resolveEffectiveDirectory();
  if (directory && closeActiveContextPanelTab(directory)) {
    return true;
  }

  // Desktop: fall through to closing the OS window when no panel tab remains.
  // Web: leave the event alone so the browser can keep its own Cmd/Ctrl+W.
  if (canUseElectronDesktopIPC()) {
    void invokeDesktop('desktop_close_current_window').catch((error) => {
      console.warn('[keyboard-shortcuts] failed to close current window', error);
    });
    return true;
  }

  return false;
};

type LeaderCompactDependencies = {
  sessionId: string;
  currentProviderId: string;
  currentModelId: string;
  waitForConnectionOrThrow: () => Promise<void>;
  getAuthoritativeDirectoryForSession: (sessionId: string) => string | null | undefined;
  summarizeSession: (
    sessionId: string,
    providerId: string,
    modelId: string,
    directory?: string | null,
  ) => Promise<unknown>;
  onCompactFailed: (error?: unknown) => void;
};

export const executeLeaderCompact = async ({
  sessionId,
  currentProviderId,
  currentModelId,
  waitForConnectionOrThrow,
  getAuthoritativeDirectoryForSession,
  summarizeSession,
  onCompactFailed,
}: LeaderCompactDependencies): Promise<void> => {
  try {
    await waitForConnectionOrThrow();
    const compactDirectory = getAuthoritativeDirectoryForSession(sessionId);
    if (!compactDirectory) {
      onCompactFailed();
      return;
    }
    await summarizeSession(sessionId, currentProviderId, currentModelId, compactDirectory);
  } catch (error) {
    onCompactFailed(error);
  }
};

export const useKeyboardShortcuts = () => {
  const { t } = useI18n();
  const openNewSessionDraft = useSessionUIStore((s) => s.openNewSessionDraft);
  const armAbortPrompt = useSessionUIStore((s) => s.armAbortPrompt);
  const clearAbortPrompt = useSessionUIStore((s) => s.clearAbortPrompt);
  const currentSessionId = useSessionUIStore((s) => s.currentSessionId);
    const abortCurrentOperation = sessionActions.abortCurrentOperation;;
  const toggleCommandPalette = useUIStore((s) => s.toggleCommandPalette);
  const toggleHelpDialog = useUIStore((s) => s.toggleHelpDialog);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const toggleRightSidebar = useUIStore((s) => s.toggleRightSidebar);
  const setRightSidebarOpen = useUIStore((s) => s.setRightSidebarOpen);
  const setRightSidebarTab = useUIStore((s) => s.setRightSidebarTab);
  const toggleBottomTerminal = useUIStore((s) => s.toggleBottomTerminal);
  const setBottomTerminalExpanded = useUIStore((s) => s.setBottomTerminalExpanded);
  const isMobile = useUIStore((s) => s.isMobile);
  const setSessionSwitcherOpen = useUIStore((s) => s.setSessionSwitcherOpen);
  const setActiveMainTab = useUIStore((s) => s.setActiveMainTab);
  const setSettingsDialogOpen = useUIStore((s) => s.setSettingsDialogOpen);
  const setModelSelectorOpen = useUIStore((s) => s.setModelSelectorOpen);
  const setAgentSelectorOpen = useUIStore((s) => s.setAgentSelectorOpen);
  const setTimelineDialogOpen = useUIStore((s) => s.setTimelineDialogOpen);
  const togglePromptNavigatorPanel = useUIStore((s) => s.togglePromptNavigatorPanel);
  const setPromptNavigatorPanelOpen = useUIStore((s) => s.setPromptNavigatorPanelOpen);
  const toggleExpandedInput = useUIStore((s) => s.toggleExpandedInput);
  const shortcutOverrides = useUIStore((s) => s.shortcutOverrides);
  const currentDirectory = useDirectoryStore((s) => s.currentDirectory);
  const activeProject = useProjectsStore((s) => s.getActiveProject());
  const { themeMode, setThemeMode } = useThemeSystem();
  const { working } = useAssistantStatus();
  const abortPrimedUntilRef = React.useRef<number | null>(null);
  const abortPrimedTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const leaderTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const consumeLeaderTextInputRef = React.useRef(false);
  const themeModeRef = React.useRef(themeMode);

  React.useEffect(() => {
    themeModeRef.current = themeMode;
  }, [themeMode]);

  const resetAbortPriming = React.useCallback(() => {
    if (abortPrimedTimeoutRef.current) {
      clearTimeout(abortPrimedTimeoutRef.current);
      abortPrimedTimeoutRef.current = null;
    }
    abortPrimedUntilRef.current = null;
    clearAbortPrompt();
  }, [clearAbortPrompt]);

  // Clear the Ctrl+X leader chord window and its expiry timer.
  const clearLeaderKey = React.useCallback(() => {
    if (leaderTimeoutRef.current) {
      clearTimeout(leaderTimeoutRef.current);
      leaderTimeoutRef.current = null;
    }
    useLeaderKeyStore.getState().clear();
  }, []);

  // Arm the Ctrl+X leader chord window (OpenCode-compatible timeout).
  const armLeaderKey = React.useCallback(() => {
    if (leaderTimeoutRef.current) {
      clearTimeout(leaderTimeoutRef.current);
      leaderTimeoutRef.current = null;
    }
    const expiresAt = useLeaderKeyStore.getState().arm(LEADER_KEY_TIMEOUT_MS);
    leaderTimeoutRef.current = setTimeout(() => {
      const { expiresAt: currentExpiresAt } = useLeaderKeyStore.getState();
      if (currentExpiresAt && Date.now() >= currentExpiresAt) {
        useLeaderKeyStore.getState().clear();
      }
      leaderTimeoutRef.current = null;
    }, Math.max(0, expiresAt - Date.now()));
  }, []);

  React.useEffect(() => {
    const combo = (actionId: string) => getEffectiveShortcutCombo(actionId, shortcutOverrides);
    const combos = (actionId: string) => getEffectiveShortcutCombos(actionId, shortcutOverrides);
    const isTerminalEventTarget = (target: EventTarget | null) => {
      if (!(target instanceof Element)) {
        return false;
      }

      return Boolean(
        target.closest('[data-terminal-view="true"]') ||
        target.closest('.terminal-viewport-container') ||
        target.getAttribute('data-terminal-hidden-input') === 'true'
      );
    };

    const dropdownTargetSelector = [
      '[data-slot="dropdown-menu-content"]',
      '[data-slot="select-content"]',
      '[role="combobox"]',
      '[role="listbox"]',
      '[role="menu"]',
      '[role="menuitem"]',
      '[role="option"]',
      '[data-radix-popper-content-wrapper]',
    ].join(',');

    const isDropdownEventTarget = (target: EventTarget | null) => {
      return target instanceof Element && Boolean(target.closest(dropdownTargetSelector));
    };

    const hasOpenDropdown = () => {
      const openDropdowns = document.querySelectorAll<HTMLElement>(
        '[data-slot="dropdown-menu-content"], [data-slot="select-content"], [role="listbox"], [role="menu"], [data-radix-popper-content-wrapper]'
      );
      return Array.from(openDropdowns).some((element) => element.getClientRects().length > 0);
    };

    const restoreChatInputFocus = () => {
      window.requestAnimationFrame(() => {
        document.querySelector<HTMLTextAreaElement>('textarea[data-chat-input="true"]')?.focus({ preventScroll: true });
      });
    };

    // True when a modal/overlay should suppress leader chords (same gate as model selector).
    const hasBlockingOverlay = () => {
      const {
        isSettingsDialogOpen,
        isCommandPaletteOpen,
        isHelpDialogOpen,
        isSessionSwitcherOpen,
        isAboutDialogOpen,
      } = useUIStore.getState();
      return isSettingsDialogOpen || isCommandPaletteOpen || isHelpDialogOpen || isSessionSwitcherOpen || isAboutDialogOpen;
    };

    // Compact the active composer surface (primary session or Assistant) via
    // the same backend port as `/compact`, so chords are not primary-only.
    const runLeaderCompact = async () => {
      const surface = getActiveChatInputSurface();
      const wiring = surface ? createChatInputControllerWiring(surface) : null;
      if (wiring && surface) {
        try {
          await wiring.compact({
            providerID: surface.selection.value.providerID,
            modelID: surface.selection.value.modelID,
            agent: surface.selection.value.agent,
            variant: surface.selection.value.variant,
          });
        } catch (error) {
          toast.error(error instanceof Error ? error.message : t('chat.chatInput.toast.compactFailed'));
        }
        return;
      }

      const sessionId = useSessionUIStore.getState().currentSessionId;
      if (!sessionId) {
        return;
      }

      const { currentProviderId, currentModelId } = useConfigStore.getState();
      await executeLeaderCompact({
        sessionId,
        currentProviderId,
        currentModelId,
        waitForConnectionOrThrow: sessionActions.waitForConnectionOrThrow,
        getAuthoritativeDirectoryForSession: useSessionUIStore.getState().getAuthoritativeDirectoryForSession,
        // Keep `this` bound — summarizeSession reads normalizeCandidatePath on the client.
        summarizeSession: (sessionId, providerId, modelId, directory) =>
          opencodeClient.summarizeSession(sessionId, providerId, modelId, directory),
        onCompactFailed: (error) => {
          toast.error(error instanceof Error ? error.message : t('chat.chatInput.toast.compactFailed'));
        },
      });
    };

    // Capture-phase leader chord handler so Ctrl+X / follow-up keys work inside the chat input
    // without inserting characters or triggering Cut.
    const handleLeaderKeyCapture = (e: KeyboardEvent) => {
      const leaderPending = useLeaderKeyStore.getState().pending;
      // While the leader chord is armed, keep consuming keys even if an IME marks
      // the event as composing — otherwise Chinese/Japanese IMEs leak letters into
      // the textarea before the chord can claim them.
      if (e.repeat || (e.isComposing && !leaderPending) || (e.defaultPrevented && !leaderPending)) {
        return;
      }

      if (isTerminalEventTarget(e.target) && !leaderPending) {
        return;
      }

      const leaderCombo = combo('leader_key');

      if (leaderPending) {
        const consumeLeaderTextInput = () => {
          consumeLeaderTextInputRef.current = true;
          window.setTimeout(() => {
            consumeLeaderTextInputRef.current = false;
          }, 0);
        };

        // Pressing the leader again re-arms the chord window.
        if (leaderCombo && eventMatchesShortcut(e, leaderCombo)) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          armLeaderKey();
          return;
        }

        const key = e.key.toLowerCase();

        if (key === 'escape') {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          clearLeaderKey();
          return;
        }

        // Ignore bare modifier presses while waiting for the follow-up key.
        if (e.key === 'Control' || e.key === 'Shift' || e.key === 'Alt' || e.key === 'Meta') {
          return;
        }

        // Any other modified chord cancels instead of typing into the input.
        if (e.metaKey || e.ctrlKey || e.altKey) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          consumeLeaderTextInput();
          clearLeaderKey();
          return;
        }

        const {
          activeMainTab,
          isModelSelectorOpen,
          isAgentSelectorOpen,
        } = useUIStore.getState();
        const canRunChatChord = isChatComposerMainTab(activeMainTab) && !hasBlockingOverlay();

        if (key === 'm' && canRunChatChord) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          consumeLeaderTextInput();
          clearLeaderKey();
          // Mounting and auto-focusing the search input during this keydown can
          // let the chord's trailing "m" become its first query character.
          // Open after the current keyboard event has fully finished instead.
          window.requestAnimationFrame(() => {
            setModelSelectorOpen(!isModelSelectorOpen, { instant: true });
          });
          return;
        }

        if (key === 'a' && canRunChatChord) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          consumeLeaderTextInput();
          clearLeaderKey();
          setAgentSelectorOpen(!isAgentSelectorOpen, { instant: true });
          return;
        }

        if (key === 'n' && canRunChatChord) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          consumeLeaderTextInput();
          clearLeaderKey();
          const surface = getActiveChatInputSurface();
          const wiring = surface ? createChatInputControllerWiring(surface) : null;
          if (wiring) {
            void wiring.shortcut('new');
          } else {
            setActiveMainTab('chat');
            setSessionSwitcherOpen(false);
            openNewSessionDraft();
          }
          return;
        }

        if (key === 'c' && canRunChatChord) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          consumeLeaderTextInput();
          clearLeaderKey();
          void runLeaderCompact();
          restoreChatInputFocus();
          return;
        }

        // Unknown follow-up: consume the key so it does not land in the input, then exit.
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        consumeLeaderTextInput();
        clearLeaderKey();
        restoreChatInputFocus();
        return;
      }

      if (!leaderCombo || !eventMatchesShortcut(e, leaderCombo)) {
        return;
      }

      if (hasBlockingOverlay()) {
        return;
      }

      const { activeMainTab } = useUIStore.getState();
      if (!isChatComposerMainTab(activeMainTab)) {
        return;
      }

      e.preventDefault();
      e.stopPropagation();
      armLeaderKey();
    };

    const shouldConsumeLeaderTextInput = () => (
      useLeaderKeyStore.getState().pending || consumeLeaderTextInputRef.current
    );

    // beforeinput alone is not enough under IME: insertCompositionText is often
    // non-cancelable. Cancel compositionstart so chord keys never become compose text.
    const handleLeaderBeforeInputCapture = (event: InputEvent) => {
      if (shouldConsumeLeaderTextInput()) {
        event.preventDefault();
      }
    };

    const handleLeaderCompositionCapture = (event: CompositionEvent) => {
      if (!shouldConsumeLeaderTextInput()) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    };

    const handleTerminalShortcutCapture = (e: KeyboardEvent) => {
      if (!isTerminalEventTarget(e.target)) {
        return;
      }

      // VS Code-style terminal tab ops only apply outside the VS Code host runtime.
      if (!isVSCodeRuntime() && eventMatchesShortcut(e, combo('new_terminal_tab'))) {
        const directory = resolveEffectiveDirectory();
        if (!directory || !createAndActivateTerminalTab(directory)) {
          return;
        }

        e.preventDefault();
        e.stopPropagation();
        return;
      }

      if (!isVSCodeRuntime() && eventMatchesShortcut(e, combo('previous_terminal_tab'))) {
        const directory = resolveEffectiveDirectory();
        if (!directory || !switchTerminalTab(directory, -1)) {
          return;
        }

        e.preventDefault();
        e.stopPropagation();
        return;
      }

      if (!isVSCodeRuntime() && eventMatchesShortcut(e, combo('next_terminal_tab'))) {
        const directory = resolveEffectiveDirectory();
        if (!directory || !switchTerminalTab(directory, 1)) {
          return;
        }

        e.preventDefault();
        e.stopPropagation();
        return;
      }

      if (eventMatchesShortcut(e, combo('close_context_panel_tab'))) {
        const directory = resolveEffectiveDirectory();
        if (!directory) {
          return;
        }

        const { closed, wasLastTab } = closeActiveTerminalTab(directory);
        if (!closed) {
          return;
        }

        e.preventDefault();
        e.stopPropagation();

        if (wasLastTab) {
          const uiState = useUIStore.getState();
          uiState.setBottomTerminalOpen(false);
          if (uiState.activeMainTab === 'terminal') {
            uiState.setActiveMainTab('chat');
          }
        }
        return;
      }

      if (eventMatchesShortcut(e, combo('toggle_terminal'))) {
        const { isMobile } = useUIStore.getState();
        if (isMobile) {
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        toggleBottomTerminal();
        return;
      }

      if (eventMatchesShortcut(e, combo('toggle_bottom_panel'))) {
        const { isMobile } = useUIStore.getState();
        if (isMobile) {
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        toggleBottomTerminal();
        return;
      }

      if (eventMatchesShortcut(e, combo('toggle_terminal_expanded'))) {
        const { isMobile, isBottomTerminalExpanded } = useUIStore.getState();
        if (isMobile) {
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        setBottomTerminalExpanded(!isBottomTerminalExpanded);
        return;
      }
    };

    const cycleThinkingVariant = (): boolean => {
      const {
        isSettingsDialogOpen,
        isCommandPaletteOpen,
        isHelpDialogOpen,
        isSessionSwitcherOpen,
        isAboutDialogOpen,
        activeMainTab,
      } = useUIStore.getState();

      if (isSettingsDialogOpen) {
        return false;
      }

      const hasOverlay = isCommandPaletteOpen || isHelpDialogOpen || isSessionSwitcherOpen || isAboutDialogOpen;
      if (hasOverlay || !isChatComposerMainTab(activeMainTab)) {
        return false;
      }

      const surface = getActiveChatInputSurface();
      if (surface?.selection.change) {
        const variants = surface.selection.catalog?.variants ?? [];
        if (variants.length === 0) {
          return false;
        }
        const currentVariant = surface.selection.value.variant;
        const currentIndex = currentVariant ? variants.indexOf(currentVariant) : -1;
        const nextVariant = variants[(currentIndex + 1) % variants.length];
        void surface.selection.change({
          ...surface.selection.value,
          variant: nextVariant,
        });
        return true;
      }

      const configState = useConfigStore.getState();
      if (configState.getCurrentModelVariants().length === 0) {
        return false;
      }

      configState.cycleCurrentVariant();

      const nextVariant = useConfigStore.getState().currentVariant;
      const sessionId = useSessionUIStore.getState().currentSessionId;
      const agentName = useConfigStore.getState().currentAgentName;
      const providerId = useConfigStore.getState().currentProviderId;
      const modelId = useConfigStore.getState().currentModelId;

      if (sessionId && agentName && providerId && modelId) {
        useSelectionStore.getState().saveAgentModelVariantForSession(sessionId, agentName, providerId, modelId, nextVariant);
      }
      if (agentName && providerId && modelId) {
        useConfigStore.getState().saveAgentModelSelection(agentName, providerId, modelId, nextVariant);
      }

      return true;
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      // Local controls such as CodeMirror get first priority for their own shortcuts.
      if (e.defaultPrevented) {
        return;
      }

      // The terminal capture handler owns Cmd/Ctrl+W before Ghostty consumes it.
      if (eventMatchesShortcut(e, combo('close_context_panel_tab'))) {
        if (requestEmbeddedSessionChatTabClose() || handleCloseContextPanelTabOrWindow()) {
          e.preventDefault();
          e.stopPropagation();
        }
        return;
      }

      if (isTerminalEventTarget(e.target)) {
        return;
      }

      const isChatInputTarget = (target: EventTarget | null) => {
        return target instanceof HTMLTextAreaElement && target.getAttribute('data-chat-input') === 'true';
      };

      // Ctrl+T is reserved for thinking variants while the composer has focus.
      // Elsewhere, Cmd/Ctrl+T continues to open the conversation timeline.
      const isFocusedInputVariantShortcut = isChatInputTarget(e.target)
        && e.ctrlKey
        && !e.metaKey
        && !e.shiftKey
        && !e.altKey
        && e.key.toLowerCase() === 't';
      if (isFocusedInputVariantShortcut) {
        e.preventDefault();
        cycleThinkingVariant();
        return;
      }

      if (eventMatchesShortcut(e, combo('open_command_palette'))) {
        e.preventDefault();
        toggleCommandPalette();
        return;
      }

      if (eventMatchesShortcut(e, combo('open_timeline_dialog'))) {
        e.preventDefault();
        setTimelineDialogOpen(true);
        return;
      }

      if (eventMatchesShortcut(e, combo('toggle_prompt_navigator'))) {
        const {
          activeMainTab,
          promptNavigatorEnabled,
          isSettingsDialogOpen,
          isCommandPaletteOpen,
          isHelpDialogOpen,
          isSessionSwitcherOpen,
          isAboutDialogOpen,
          isTimelineDialogOpen,
          isMultiRunLauncherOpen,
          isImagePreviewOpen,
        } = useUIStore.getState();

        if (!promptNavigatorEnabled || isMobile || isVSCodeRuntime() || activeMainTab !== 'chat') {
          return;
        }

        const hasOverlay = isSettingsDialogOpen
          || isCommandPaletteOpen
          || isHelpDialogOpen
          || isSessionSwitcherOpen
          || isAboutDialogOpen
          || isTimelineDialogOpen
          || isMultiRunLauncherOpen
          || isImagePreviewOpen;

        if (hasOverlay) {
          return;
        }

        e.preventDefault();
        togglePromptNavigatorPanel();
        return;
      }

      if (eventMatchesShortcut(e, combo('open_status'))) {
        e.preventDefault();
        void showOpenCodeStatus();
        return;
      }

      if (eventMatchesShortcut(e, combo('open_help'))) {
        e.preventDefault();
        toggleHelpDialog();
        return;
      }

      if (canUseElectronDesktopIPC() && eventMatchesShortcut(e, combo('new_mini_chat'))) {
        e.preventDefault();
        void invokeDesktop('desktop_open_draft_mini_chat_window', {
          directory: currentDirectory || activeProject?.path || '',
          projectId: activeProject?.id ?? null,
        }).catch((error) => {
          console.warn('[keyboard-shortcuts] failed to open draft mini chat window', error);
        });
        return;
      }

      const matchedNewSessionShortcut = eventMatchesShortcut(e, combo('new_chat'));
      const matchedWorktreeShortcut = eventMatchesShortcut(e, combo('new_chat_worktree'));

      if (matchedNewSessionShortcut || matchedWorktreeShortcut) {
        e.preventDefault();

        setActiveMainTab('chat');
        setSessionSwitcherOpen(false);

        if (!isVSCodeRuntime() && matchedWorktreeShortcut) {
          createWorktreeSession();
          return;
        }

        openNewSessionDraft();
        return;
      }

      if (eventMatchesShortcut(e, combo('cycle_theme'))) {
        e.preventDefault();
        if (readEmbeddedThemeSearchParams() !== null && window.parent && window.parent !== window) {
          window.parent.postMessage({ type: 'openchamber:cycle-theme-request' }, window.location.origin);
          return;
        }
        const modes: Array<'light' | 'dark' | 'system'> = ['light', 'dark', 'system'];
        const activeElement = document.activeElement as HTMLElement | null;
        const currentIndex = modes.indexOf(themeModeRef.current);
        const nextIndex = (currentIndex + 1) % modes.length;
        setThemeMode(modes[nextIndex]);
        requestAnimationFrame(() => {
          if (typeof document === 'undefined' || typeof window === 'undefined') {
            return;
          }
          if (!document.hasFocus()) {
            window.focus();
          }
          if (activeElement && document.contains(activeElement)) {
            activeElement.focus({ preventScroll: true });
          }
        });
        return;
      }

      // Chromium/webview page zoom (not Settings fontSize).
      if (eventMatchesZoomShortcut(e, 'in', combo('zoom_in'))) {
        e.preventDefault();
        void zoomWebviewIn();
        return;
      }

      if (eventMatchesZoomShortcut(e, 'out', combo('zoom_out'))) {
        e.preventDefault();
        void zoomWebviewOut();
        return;
      }

      if (eventMatchesShortcut(e, combo('zoom_reset'))) {
        e.preventDefault();
        void resetWebviewZoom();
        return;
      }

      if (eventMatchesShortcut(e, combo('open_settings'))) {
        e.preventDefault();
        const { isSettingsDialogOpen } = useUIStore.getState();
        setSettingsDialogOpen(!isSettingsDialogOpen);
        return;
      }

      if (eventMatchesShortcut(e, combo('toggle_sidebar'))) {
        e.preventDefault();
        const { isMobile, isSessionSwitcherOpen } = useUIStore.getState();
        if (isMobile) {
          setSessionSwitcherOpen(!isSessionSwitcherOpen);
        } else {
          toggleSidebar();
        }
        return;
      }

      if (eventMatchesShortcut(e, combo('focus_input'))) {
        e.preventDefault();
        const textarea = document.querySelector<HTMLTextAreaElement>('textarea[data-chat-input="true"]');
        textarea?.focus();
        return;
      }

      const cycleAgentCombo = combo('cycle_agent');
      const cycleAgentBackwardCombo = cycleAgentCombo && !cycleAgentCombo.includes('shift')
        ? normalizeCombo(`shift+${cycleAgentCombo}`)
        : '';
      const cycleAgentDirection = cycleAgentBackwardCombo && eventMatchesShortcut(e, cycleAgentBackwardCombo)
        ? -1
        : eventMatchesShortcut(e, cycleAgentCombo)
          ? 1
          : 0;

      if (cycleAgentDirection !== 0) {
        const {
          isSettingsDialogOpen,
          isCommandPaletteOpen,
          isHelpDialogOpen,
          isSessionSwitcherOpen,
          isAboutDialogOpen,
          activeMainTab,
        } = useUIStore.getState();

        const hasOverlay = isSettingsDialogOpen || isCommandPaletteOpen || isHelpDialogOpen || isSessionSwitcherOpen || isAboutDialogOpen;
        if (hasOverlay || !isChatComposerMainTab(activeMainTab) || !isChatInputTarget(e.target)) {
          return;
        }

        // Route through the mounted composer surface so Assistant and primary
        // chat share one cycle path (including recent/session persistence).
        const surface = getActiveChatInputSurface();
        const wiring = surface ? createChatInputControllerWiring(surface) : null;
        if (wiring) {
          e.preventDefault();
          void wiring.shortcut('cycle', cycleAgentDirection as 1 | -1);
          return;
        }

        const configState = useConfigStore.getState();
        const nextAgentName = getCycledPrimaryAgentName(
          configState.getVisibleAgents(),
          configState.currentAgentName,
          cycleAgentDirection,
        );

        if (!nextAgentName) {
          return;
        }

        e.preventDefault();
        configState.setAgent(nextAgentName);
        useUIStore.getState().addRecentAgent(nextAgentName);

        const sessionId = useSessionUIStore.getState().currentSessionId;
        if (sessionId) {
          useSelectionStore.getState().saveSessionAgentSelection(sessionId, nextAgentName);
        }
        return;
      }

      if (combos('toggle_right_sidebar').some((shortcut) => eventMatchesShortcut(e, shortcut))) {
        const { isMobile } = useUIStore.getState();
        if (isMobile) {
          return;
        }
        e.preventDefault();
        toggleRightSidebar();
        return;
      }

      if (eventMatchesShortcut(e, combo('open_right_sidebar_git'))) {
        const { isMobile } = useUIStore.getState();
        if (isMobile) {
          return;
        }
        e.preventDefault();
        setRightSidebarOpen(true);
        setRightSidebarTab('git');
        return;
      }

      if (eventMatchesShortcut(e, combo('open_right_sidebar_files'))) {
        const { isMobile } = useUIStore.getState();
        if (isMobile) {
          return;
        }
        e.preventDefault();
        setRightSidebarOpen(true);
        setRightSidebarTab('files');
        return;
      }

      if (eventMatchesShortcut(e, combo('cycle_right_sidebar_tab'))) {
        const { isMobile, rightSidebarTab } = useUIStore.getState();
        if (isMobile) {
          return;
        }

        const tabs = ['git', 'files', 'context'] as const;
        const currentIndex = tabs.indexOf(rightSidebarTab);
        const nextTab = tabs[(currentIndex + 1) % tabs.length];

        e.preventDefault();
        setRightSidebarOpen(true);
        setRightSidebarTab(nextTab);
        return;
      }

      const navigateSession = (direction: -1 | 1) => {
        return navigateAdjacentSession(
          direction,
          useSessionUIStore.getState().currentSessionId,
          (target) => {
            setActiveMainTab('chat');
            setSessionSwitcherOpen(false);
            useSessionUIStore.getState().setCurrentSession(
              target.sessionId,
              target.directory,
            );
          },
        );
      };

      if (combos('previous_session').some((shortcut) => eventMatchesShortcut(e, shortcut))) {
        e.preventDefault();
        navigateSession(-1);
        return;
      }

      if (combos('next_session').some((shortcut) => eventMatchesShortcut(e, shortcut))) {
        e.preventDefault();
        navigateSession(1);
        return;
      }

      for (let slotNumber = 1; slotNumber <= 9; slotNumber += 1) {
        if (!eventMatchesShortcut(e, combo(`switch_tab_${slotNumber}`))) {
          continue;
        }
        if (activateSidebarNumberedSession(slotNumber)) {
          e.preventDefault();
        }
        return;
      }

      if (eventMatchesShortcut(e, combo('toggle_terminal'))) {
        const { isMobile } = useUIStore.getState();
        if (isMobile) {
          return;
        }
        e.preventDefault();
        toggleBottomTerminal();
        return;
      }

      if (eventMatchesShortcut(e, combo('open_new_terminal'))) {
        const { isMobile } = useUIStore.getState();
        if (isMobile || isVSCodeRuntime()) {
          return;
        }
        const directory = resolveEffectiveDirectory();
        if (!directory || !openAndCreateTerminalTab(directory)) {
          return;
        }
        e.preventDefault();
        return;
      }

      if (eventMatchesShortcut(e, combo('toggle_bottom_panel'))) {
        const { isMobile } = useUIStore.getState();
        if (isMobile) {
          return;
        }
        e.preventDefault();
        toggleBottomTerminal();
        return;
      }

      if (eventMatchesShortcut(e, combo('toggle_terminal_expanded'))) {
        const { isMobile, isBottomTerminalExpanded } = useUIStore.getState();
        if (isMobile) {
          return;
        }
        e.preventDefault();
        setBottomTerminalExpanded(!isBottomTerminalExpanded);
        return;
      }

      // Cmd/Ctrl+Shift+M: Open model selector (same conditions as double-ESC: chat tab, no overlays)
      if (eventMatchesShortcut(e, combo('open_model_selector'))) {
        const {
          isSettingsDialogOpen,
          isCommandPaletteOpen,
          isHelpDialogOpen,
          isSessionSwitcherOpen,
          isAboutDialogOpen,
          activeMainTab,
          isModelSelectorOpen,
        } = useUIStore.getState();

        // Skip if settings open
        if (isSettingsDialogOpen) {
          return;
        }

        // Skip if any overlay open or not on a composer tab
        const hasOverlay = isCommandPaletteOpen || isHelpDialogOpen || isSessionSwitcherOpen || isAboutDialogOpen;
        const isComposerActive = isChatComposerMainTab(activeMainTab);

        if (hasOverlay || !isComposerActive) {
          return;
        }

        e.preventDefault();
        setModelSelectorOpen(!isModelSelectorOpen, { instant: true });
        return;
      }

      // Cmd/Ctrl+Shift+T: Cycle thinking variant (same gating as Shift+M)
      if (eventMatchesShortcut(e, combo('cycle_thinking_variant'))) {
        if (cycleThinkingVariant()) {
          e.preventDefault();
        }
        return;
      }

      // Ctrl+] / Ctrl+[: Cycle through starred models (same gating as Shift+M)
      if (
        eventMatchesShortcut(e, combo('cycle_favorite_model_forward')) ||
        eventMatchesShortcut(e, combo('cycle_favorite_model_backward'))
      ) {
        const {
          isSettingsDialogOpen,
          isCommandPaletteOpen,
          isHelpDialogOpen,
          isSessionSwitcherOpen,
          isAboutDialogOpen,
          activeMainTab,
          favoriteModels,
          addRecentModel,
        } = useUIStore.getState();

        if (isSettingsDialogOpen) {
          return;
        }

        const hasOverlay = isCommandPaletteOpen || isHelpDialogOpen || isSessionSwitcherOpen || isAboutDialogOpen;
        const isComposerActive = isChatComposerMainTab(activeMainTab);

        if (hasOverlay || !isComposerActive || favoriteModels.length === 0) {
          return;
        }

        e.preventDefault();

        const len = favoriteModels.length;
        const delta = eventMatchesShortcut(e, combo('cycle_favorite_model_forward')) ? 1 : -1;
        const surface = getActiveChatInputSurface();
        if (surface?.selection.change) {
          const currentProviderId = surface.selection.value.providerID;
          const currentModelId = surface.selection.value.modelID;
          const currentIdx = favoriteModels.findIndex(
            (f) => f.providerID === currentProviderId && f.modelID === currentModelId,
          );
          const next = favoriteModels[(currentIdx + delta + len) % len];
          void surface.selection.change({
            ...surface.selection.value,
            providerID: next.providerID,
            modelID: next.modelID,
            variant: undefined,
          });
          addRecentModel(next.providerID, next.modelID);
          return;
        }

        const { currentProviderId, currentModelId, setProvider, setModel } = useConfigStore.getState();
        const currentIdx = favoriteModels.findIndex(
          (f) => f.providerID === currentProviderId && f.modelID === currentModelId,
        );
        const next = favoriteModels[(currentIdx + delta + len) % len];

        setProvider(next.providerID);
        setModel(next.modelID);
        addRecentModel(next.providerID, next.modelID);
        return;
      }

      if (eventMatchesShortcut(e, combo('expand_input'))) {
        if (isMobile) {
          return;
        }
        e.preventDefault();
        toggleExpandedInput();
        return;
      }

      if (eventMatchesShortcut(e, combo('toggle_dictation'))) {
        const { activeMainTab, isCommandPaletteOpen, isHelpDialogOpen, isSessionSwitcherOpen, isSettingsDialogOpen } = useUIStore.getState();
        if (!isChatComposerMainTab(activeMainTab) || isCommandPaletteOpen || isHelpDialogOpen || isSessionSwitcherOpen || isSettingsDialogOpen) {
          return;
        }
        e.preventDefault();
        // Dictation state lives inside the composer's isolated component;
        // toggle it via an event instead of subscribing this hot hook to it.
        window.dispatchEvent(new CustomEvent('openchamber:dictation-toggle'));
        return;
      }

      if (e.key === 'Escape') {
        const target = e.target as Element | null;
        const isInsideDialog = Boolean(target?.closest('[role="dialog"]'));
        const isSettingsMounted = Boolean(document.querySelector('[data-settings-view="true"]'));
        const isInsideTerminal = Boolean(
          target?.closest('.terminal-viewport-container') ||
          target?.getAttribute('data-terminal-hidden-input') === 'true'
        );
        const hasDropdownInteraction = isDropdownEventTarget(target) || hasOpenDropdown();

        const {
          isSettingsDialogOpen,
          isCommandPaletteOpen,
          isHelpDialogOpen,
          isSessionSwitcherOpen,
          isAboutDialogOpen,
          isMultiRunLauncherOpen,
          isImagePreviewOpen,
          activeMainTab,
          isPromptNavigatorPanelOpen,
        } = useUIStore.getState();

        if (isInsideDialog || isInsideTerminal || hasDropdownInteraction) {
          resetAbortPriming();
          return;
        }

        if (isPromptNavigatorPanelOpen) {
          e.preventDefault();
          setPromptNavigatorPanelOpen(false);
          resetAbortPriming();
          return;
        }

        // If settings is open, close it
        if (isSettingsDialogOpen) {
          e.preventDefault();
          setSettingsDialogOpen(false);
          resetAbortPriming();
          return;
        }

        if (isSettingsMounted) {
          resetAbortPriming();
          return;
        }

        // Check if any overlay is open or not on a composer tab - don't process abort
        const hasOverlay = isCommandPaletteOpen || isHelpDialogOpen || isSessionSwitcherOpen || isAboutDialogOpen || isMultiRunLauncherOpen || isImagePreviewOpen;
        const isComposerActive = isChatComposerMainTab(activeMainTab);

        if (hasOverlay || !isComposerActive) {
          resetAbortPriming();
          return;
        }

        // Double-ESC abort logic targets the active composer surface.
        const surface = getActiveChatInputSurface();
        const wiring = surface ? createChatInputControllerWiring(surface) : null;
        const sessionId = surface?.sessionID ?? currentSessionId;
        const canAbortNow = wiring
          ? wiring.canAbort && Boolean(sessionId)
          : working.canAbort && Boolean(sessionId);
        if (!canAbortNow) {
          resetAbortPriming();
          return;
        }

        const now = Date.now();
        const primedUntil = abortPrimedUntilRef.current;

        if (primedUntil && now < primedUntil) {
          e.preventDefault();
          resetAbortPriming();
          if (wiring) {
            void wiring.abort();
          } else {
            void abortCurrentOperation(sessionId ?? '');
          }
          return;
        }

        e.preventDefault();
        // Primary abort chip still uses the session UI store; Assistant keeps a
        // local priming window when its surface abortPrompt is not session-bound.
        const expiresAt = surface?.kind === 'secondary'
          ? now + 3000
          : (armAbortPrompt(3000) ?? now + 3000);
        abortPrimedUntilRef.current = expiresAt;

        if (abortPrimedTimeoutRef.current) {
          clearTimeout(abortPrimedTimeoutRef.current);
        }

        const delay = Math.max(expiresAt - now, 0);
        abortPrimedTimeoutRef.current = setTimeout(() => {
          if (abortPrimedUntilRef.current && Date.now() >= abortPrimedUntilRef.current) {
            resetAbortPriming();
          }
        }, delay || 0);
        return;
      }
    };

    window.addEventListener('keydown', handleLeaderKeyCapture, true);
    window.addEventListener('beforeinput', handleLeaderBeforeInputCapture, true);
    window.addEventListener('compositionstart', handleLeaderCompositionCapture, true);
    window.addEventListener('compositionupdate', handleLeaderCompositionCapture, true);
    window.addEventListener('compositionend', handleLeaderCompositionCapture, true);
    window.addEventListener('keydown', handleTerminalShortcutCapture, true);
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('keydown', handleLeaderKeyCapture, true);
      window.removeEventListener('beforeinput', handleLeaderBeforeInputCapture, true);
      window.removeEventListener('compositionstart', handleLeaderCompositionCapture, true);
      window.removeEventListener('compositionupdate', handleLeaderCompositionCapture, true);
      window.removeEventListener('compositionend', handleLeaderCompositionCapture, true);
      window.removeEventListener('keydown', handleTerminalShortcutCapture, true);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [
    openNewSessionDraft,
    abortCurrentOperation,
    toggleCommandPalette,
    toggleHelpDialog,
    toggleSidebar,
    toggleRightSidebar,
    setRightSidebarOpen,
    setRightSidebarTab,
    toggleBottomTerminal,
    setBottomTerminalExpanded,
    isMobile,
    setSessionSwitcherOpen,
    setActiveMainTab,
    setSettingsDialogOpen,
    setModelSelectorOpen,
    setAgentSelectorOpen,
    setTimelineDialogOpen,
    togglePromptNavigatorPanel,
    setPromptNavigatorPanelOpen,
    toggleExpandedInput,
    setThemeMode,
    working,
    armAbortPrompt,
    resetAbortPriming,
    armLeaderKey,
    clearLeaderKey,
    currentSessionId,
    currentDirectory,
    activeProject?.id,
    activeProject?.path,
    shortcutOverrides,
    t,
  ]);

  React.useEffect(() => {
    return () => {
      resetAbortPriming();
      clearLeaderKey();
    };
  }, [resetAbortPriming, clearLeaderKey]);
};
