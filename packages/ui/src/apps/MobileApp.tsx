import React from 'react';
import { useEvent } from '@reactuses/core';
import { useStartupCatalogRecovery } from '@/hooks/useStartupCatalogRecovery';
import { toast } from 'sonner';

import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { McpIcon } from '@/components/icons/McpIcon';
import { McpDropdownContent } from '@/components/mcp/McpDropdown';
import { AboutSettings } from '@/components/sections/openchamber/AboutSettings';
import { OpenCodeUpdateToast } from '@/components/update/OpenCodeUpdateToast';
import { MobileAppUpdateToast } from '@/components/update/MobileAppUpdateToast';
import { MobileOtaUpdateNotice } from '@/components/update/MobileOtaUpdateNotice';
import { ConfigUpdateOverlay } from '@/components/ui/ConfigUpdateOverlay';
import { Button } from '@/components/ui/button';
import { OpenChamberLogo } from '@/components/ui/OpenChamberLogo';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { ChatView } from '@/components/views/ChatView';
import { AssistantView } from '@/components/assistants/AssistantView';
import { AssistantShareWelcome } from '@/components/assistants/AssistantShareWelcome';
import { useAssistantCapabilityQuery } from '@/queries/assistantQueries';
import { DiffView } from '@/components/views/DiffView';
import { SettingsView } from '@/components/views/SettingsView';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { MobileSurfaceHeader } from '@/components/ui/MobileSurfaceHeader';
import { MobileResizableSheet } from '@/components/ui/MobileResizableSheet';
import { getMobileWindowMotionController, MOBILE_SESSIONS_WINDOW_ID } from '@/components/ui/MobileWindowMotionRegistry';
import { MobileSessionStatusBar } from '@/components/chat/MobileSessionStatusBar';
import { RuntimeAPIProvider } from '@/contexts/RuntimeAPIProvider';
import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import { usePushVisibilityBeacon } from '@/hooks/usePushVisibilityBeacon';
import { preloadProviderLogos } from '@/hooks/useProviderLogo';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useRouter } from '@/hooks/useRouter';
import { useWindowTitle } from '@/hooks/useWindowTitle';
import { opencodeClient } from '@/lib/opencode/client';
import type { ProjectEntry, RuntimeAPIs } from '@/lib/api/types';
import type { PairingConnectionPayload } from '@/lib/connectionPayload';
import { useOrientation } from '@/lib/device';
import { useI18n } from '@/lib/i18n';
import { getCapgoUpdater } from '@/lib/mobile-updates/capgoAdapter';
import { MOBILE_SETTINGS_PAGE_SLUGS } from '@/lib/settings/metadata';
import { getNativeIosComposerPlugin } from '@/lib/native-ios-composer';
import { isIPadApp } from '@/lib/platform';
import { resolveProjectForDirectory, resolveProjectForSessionDirectory } from '@/lib/projectResolution';
import { formatQuotaResetLabel, formatQuotaValueLabel, formatWindowLabel, QUOTA_PROVIDERS } from '@/lib/quota';
import { getDisplayModelName } from '@/lib/quota/model-families';
import { getRuntimeApiBaseUrl, subscribeRuntimeEndpointChanged, switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { sessionEvents } from '@/lib/sessionEvents';
import { cn } from '@/lib/utils';
import { useConfigStore } from '@/stores/useConfigStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useGitHubAuthStore } from '@/stores/useGitHubAuthStore';
import { useGitStatus, useGitStore, useIsGitRepo } from '@/stores/useGitStore';
import { useMcpConfigStore, type McpDraft } from '@/stores/useMcpConfigStore';
import { useMcpConfigsQuery, useMcpStatusQuery } from '@/queries/mcpQueries';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useQuotaAutoRefresh, useQuotaStore } from '@/stores/useQuotaStore';
import { forceRefreshProjectWorktreeCatalog } from '@/lib/worktrees/worktreeManager';
import type { QuotaProviderId, UsageWindow } from '@/types';
import { useUIStore, type TimeFormatPreference } from '@/stores/useUIStore';
import { useUpdateStore } from '@/stores/useUpdateStore';
import { useSelectionStore } from '@/sync/selection-store';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { SessionStartupCoordinator } from '@/components/session/SessionStartupCoordinator';
import { DirectoryExplorerDialog } from '@/components/session/DirectoryExplorerDialog';
import { ScheduledTasksDialog, ScheduledTasksWorkspace } from '@/components/session/ScheduledTasksDialog';
import { SettingsGroup } from '@/components/sections/shared/SettingsGroup';
import { SyncProvider, useCurrentSessionEntity, useLiveSessionStatus, useParentSessionTarget, useSessionMessages } from '@/sync/sync-context';
import { useSync } from '@/sync/use-sync';

import { SyncAppEffects } from './AppEffects';
import {
  cssPxFromNativeImeHeight,
  getAndroidComposerImeStateAction,
  isComposerKeyboardFocusTransfer,
  isComposerKeyboardTarget,
  shouldCorrectArmedImeLift,
  shouldReserveChatScrollInset,
} from './composerKeyboardLift';
import { MobileChangesSurface } from './MobileChangesSurface';
import { MobileFilesSurface } from './MobileFilesSurface';
import { BusyDots } from '@/components/chat/message/parts/BusyDots';
import { MobileSessionsSheet } from './MobileSessionsSheet';
import { MobilePhoneShell } from '@/mobile/MobilePhoneShell';
import { MobileDetailNavigation } from '@/mobile/MobileDetailNavigation';
import { MobileFloatingSurface } from '@/mobile/MobileSurface';
import {
  buildMobileContextDisplay,
  ContextProgressIcon,
  getLatestAssistantTotalTokens,
  getLatestUserMessageModel,
  getNumericLimit,
  MobileChatScreen,
  useMobileTranscriptSyncHint,
  type MobileContextDisplay,
} from '@/mobile/chat';
import { useMobileNavigationStore } from '@/mobile/useMobileNavigationStore';
import { mobileBackNavigationCoordinator, useMobileNavigationDriver } from '@/mobile/mobileBackNavigation';
import { DedicatedMobileAppProvider, type MobileAppActions } from './mobileAppContext';
import { autoConnectLastInstance, connectionDisplayUrl, getAutoConnectTargetLabel, isActiveRuntimeConnection, reprobeActiveConnection, useMobileConnection, type UseMobileConnection } from './mobileConnections';
import { MobileConnectionMethodDivider, MobilePairingLinkForm } from './MobilePairingLinkForm';
import { isQrScanSupported, scanConnectionQr } from './mobileQrScan';
import { reconnectAppForTransportSwitch, resetAppForRuntimeEndpointChange } from './runtimeEndpointReset';
import { useAppFontEffects } from './useAppFontEffects';
import { useFontsReady } from './useFontsReady';
import { useDeepLinkHandlers, useDeepLinkSource, usePairingDeepLinkHandler } from './deepLinkNavigation';
import { useEdgeSwipeSessionSwitch, type SwipeProgress } from './useEdgeSwipeSessionSwitch';
import { useHeaderSwipeToSessions } from './useHeaderSwipeToSessions';
import { useMobilePressHaptics, useStreamingHaptics } from '@/hooks/streamingHaptics';
import { startPerfDiagnosticsController } from '@/sync/perf-diagnostics';
import { useNativePushRegistration } from './useNativePushRegistration';
import { useNativeLiveActivity } from './useNativeLiveActivity';
import { MobileShareBridge } from './MobileShareBridge';
import { handlePendingNativeAssistantOpen } from './nativeAssistantShortcut';

const MOBILE_DIRECT_DIFF_WINDOW_ID = 'mobile-direct-diff';
const MOBILE_TURN_DIFF_WINDOW_ID = 'mobile-turn-diff';
const MOBILE_DIRECT_FILE_WINDOW_ID = 'mobile-direct-file';
const MOBILE_FILES_WINDOW_ID = 'mobile-files';
const MOBILE_CHANGES_WINDOW_ID = 'mobile-changes';
const MOBILE_MCP_WINDOW_ID = 'mobile-mcp';
const MOBILE_SETTINGS_WINDOW_ID = 'mobile-settings';
const MOBILE_UPDATE_WINDOW_ID = 'mobile-update';
const MOBILE_OVERFLOW_MENU_ID = 'mobile-overflow-menu';

type MobileAppProps = {
  apis: RuntimeAPIs;
};

const IPAD_LEFT_SIDEBAR_WIDTH = 320;
const IPAD_RIGHT_SIDEBAR_WIDTH = 380;
const IPAD_SIDEBAR_MIN_WIDTH = 280;
const IPAD_SIDEBAR_MAX_WIDTH = 560;
const IPAD_METADATA_POPOVER_WIDTH = 380;

const clampIpadSidebarWidth = (value: number): number => (
  Math.min(IPAD_SIDEBAR_MAX_WIDTH, Math.max(IPAD_SIDEBAR_MIN_WIDTH, Math.round(value)))
);

const applyIpadSidebarLiveWidth = (asideRef: React.RefObject<HTMLElement | null>, nextWidth: number): void => {
  const aside = asideRef.current;
  if (!aside) return;
  aside.style.width = `${nextWidth}px`;
  aside.style.minWidth = `${nextWidth}px`;
  aside.style.maxWidth = `${nextWidth}px`;
  aside.style.setProperty('--oc-ipad-sidebar-width', `${nextWidth}px`);
};

/** Drag-resize for the iPad sidebars: same live-width mechanics as the desktop
    Sidebar (imperative styles during the drag, committed to state at the end),
    but with a finger-sized grab strip instead of a 3px hover handle. */
function useIpadSidebarResize(side: 'left' | 'right', storageKey: string, defaultWidth: number) {
  const asideRef = React.useRef<HTMLElement | null>(null);
  const [width, setWidth] = React.useState(() => {
    if (typeof window === 'undefined') return defaultWidth;
    const stored = Number.parseInt(window.localStorage.getItem(storageKey) ?? '', 10);
    if (!Number.isFinite(stored)) return defaultWidth;
    return Math.min(IPAD_SIDEBAR_MAX_WIDTH, Math.max(IPAD_SIDEBAR_MIN_WIDTH, stored));
  });
  const [isResizing, setIsResizing] = React.useState(false);
  const startXRef = React.useRef(0);
  const startWidthRef = React.useRef(width);
  const liveWidthRef = React.useRef<number | null>(null);
  const pointerIdRef = React.useRef<number | null>(null);

  const handlePointerDown = useEvent((event: React.PointerEvent) => {
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // ignore
    }
    pointerIdRef.current = event.pointerId;
    startXRef.current = event.clientX;
    startWidthRef.current = width;
    liveWidthRef.current = width;
    setIsResizing(true);
    event.preventDefault();
  });

  const handlePointerMove = useEvent((event: React.PointerEvent) => {
    if (pointerIdRef.current !== event.pointerId) return;
    const delta = event.clientX - startXRef.current;
    const next = clampIpadSidebarWidth(startWidthRef.current + (side === 'left' ? delta : -delta));
    if (liveWidthRef.current === next) return;
    liveWidthRef.current = next;
    applyIpadSidebarLiveWidth(asideRef, next);
  });

  const handlePointerEnd = useEvent((event: React.PointerEvent) => {
    if (pointerIdRef.current !== event.pointerId) return;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // ignore
    }
    const finalWidth = clampIpadSidebarWidth(liveWidthRef.current ?? startWidthRef.current);
    pointerIdRef.current = null;
    liveWidthRef.current = null;
    setIsResizing(false);
    setWidth(finalWidth);
    try {
      window.localStorage.setItem(storageKey, String(finalWidth));
    } catch {
      // ignore
    }
  });

  const handleProps = React.useMemo(() => ({
    onPointerDown: handlePointerDown,
    onPointerMove: handlePointerMove,
    onPointerUp: handlePointerEnd,
    onPointerCancel: handlePointerEnd,
  }), [handlePointerDown, handlePointerEnd, handlePointerMove]);

  return { asideRef, width, isResizing, handleProps };
}

const IpadSidebarResizeHandle: React.FC<{
  side: 'left' | 'right';
  isResizing: boolean;
  ariaLabel: string;
  handleProps: React.HTMLAttributes<HTMLDivElement>;
}> = ({ side, isResizing, ariaLabel, handleProps }) => (
  <div
    className={cn(
      'absolute inset-y-0 z-30 w-6 cursor-col-resize touch-none',
      side === 'left' ? 'right-0' : 'left-0',
    )}
    role="separator"
    aria-orientation="vertical"
    aria-label={ariaLabel}
    {...handleProps}
  >
    <div
      className={cn(
        'absolute inset-y-0 w-[3px] transition-colors',
        side === 'left' ? 'right-0' : 'left-0',
        isResizing && 'bg-[var(--interactive-border)]',
      )}
    />
  </div>
);

const isCapacitorMobileApp = (): boolean => {
  if (typeof window === 'undefined') return false;
  const maybeCapacitor = (window as typeof window & {
    Capacitor?: { isNativePlatform?: () => boolean; getPlatform?: () => string };
  }).Capacitor;
  if (maybeCapacitor?.isNativePlatform?.() === true) return true;
  return window.location.protocol === 'capacitor:';
};

const useNativeMobileChrome = (): void => {
  React.useEffect(() => {
    if (!isCapacitorMobileApp()) return;

    document.documentElement.classList.add('oc-native-app-active');
    let disposed = false;
    const cleanup: Array<() => void> = [];
    const root = document.documentElement;
    // Marks the Capacitor shell so keyboard-inset CSS only applies here, not in
    // the browser-hosted PWA (which handles the keyboard via dvh / interactive-widget).
    root.classList.add('oc-capacitor-app');
    // Platform marker for Android-specific safe-area / status-bar CSS. Keyboard
    // geometry is shared with iOS: full-height WebView + transform FLIP (WeChat-style).
    const capacitorPlatform = (window as typeof window & { Capacitor?: { getPlatform?: () => string } }).Capacitor?.getPlatform?.();
    if (capacitorPlatform === 'android') {
      root.classList.add('oc-platform-android');
    }

    const setInset = (px: number) => {
      root.style.setProperty('--oc-keyboard-inset', `${Math.max(0, Math.round(px))}px`);
    };

    void import('@capacitor/status-bar').then(async ({ StatusBar, Style }) => {
      if (disposed) return;
      // Keep the status bar transparent over the WebView. A custom UIScene lifecycle
      // (iOS 26) plus returning from background can silently drop the overlay state,
      // letting an opaque status-bar background flash in at the top — so re-assert it
      // on mount, once shortly after (startup race), and whenever the app re-activates.
      const platform = (window as typeof window & { Capacitor?: { getPlatform?: () => string } }).Capacitor?.getPlatform?.();
      const applyStatusBar = async () => {
        if (platform === 'android') {
          // Inset the WebView below the bar and paint it with the resolved theme background
          // (the splash colours the theme system persists). On Android 15+ edge-to-edge is
          // enforced and both calls are no-ops — there the app pads itself via the
          // Capacitor-injected --safe-area-inset-* CSS vars (see mobile.css, oc-platform-android).
          const isDark = document.documentElement.classList.contains('dark');
          const themeBg =
            (isDark ? localStorage.getItem('splashBgDark') : localStorage.getItem('splashBgLight')) ||
            (isDark ? '#171515' : '#fffdf4');
          await StatusBar.setOverlaysWebView({ overlay: false }).catch(() => undefined);
          await StatusBar.setBackgroundColor({ color: themeBg }).catch(() => undefined);
          // Capacitor Style is named for the CONTENT: Style.Light = dark text (light bg),
          // Style.Dark = light text (dark bg). So dark theme → Style.Dark, light theme → Style.Light.
          await StatusBar.setStyle({ style: isDark ? Style.Dark : Style.Light }).catch(() => undefined);
          await StatusBar.show().catch(() => undefined);
          return;
        }
        await StatusBar.setStyle({ style: Style.Default }).catch(() => undefined);
        await StatusBar.setOverlaysWebView({ overlay: true }).catch(() => undefined);
        await StatusBar.show().catch(() => undefined);
      };
      await applyStatusBar();
      const retry = window.setTimeout(() => void applyStatusBar(), 400);
      cleanup.push(() => window.clearTimeout(retry));

      const { App } = await import('@capacitor/app');
      const stateHandle = await App.addListener('appStateChange', ({ isActive }) => {
        if (isActive) void applyStatusBar();
      });
      if (disposed) {
        void stateHandle.remove();
        return;
      }
      cleanup.push(() => void stateHandle.remove());
    }).catch(() => undefined);

    void import('@capacitor/keyboard').then(async ({ Keyboard }) => {
      if (disposed) return;
      // Keyboard choreography:
      //   iOS — resize:none + immediate shell shrink (--oc-kb-layout). Header
      //            stays pinned; the composer sits at the new shell bottom so
      //            the full input is visible above the IME. No transform FLIP.
      //   Android — adjustNothing + an early composer-only CSS FLIP. Android's
      //            keyboardWillShow and WebView viewport signals arrive after IME
      //            movement starts, so ChatInput keyboard intent (and focusin
      //            only when the focused field is the bottom composer) starts a
      //            short (~200ms) transform from the cached IME height. Hide is
      //            shorter (~100ms) because close signals often arrive after the
      //            system IME has already begun dismissing. The state-only native
      //            event calibrates and caches the final height once per open.
      //            Non-composer fields (question cards, settings, etc.) must not
      //            arm this path — only the bottom chat input lifts.
      const platform = (window as typeof window & { Capacitor?: { getPlatform?: () => string } }).Capacitor?.getPlatform?.();
      const isAndroid = platform === 'android';
      await Keyboard.setAccessoryBarVisible({ isVisible: false }).catch(() => undefined);

      // How long the hide curtain stays painted after the shell snaps back:
      // roughly one UIKit keyboard fade-out, covering the seam the fade can
      // expose below the already-resting composer.
      const KB_HIDE_CURTAIN_MS = 260;
      const KB_ANIM_EASING = 'cubic-bezier(0.38, 0.7, 0.125, 1)';
      let settleTimer: number | null = null;
      let caretTimer: number | null = null;
      let keyboardHeight = 0;
      let layoutApplied = false;
      let safeBottomPx = 0;
      let keyboardOpen = false;

      const setVar = (name: string, px: number) => {
        root.style.setProperty(name, `${Math.max(0, Math.round(px))}px`);
      };
      const clearSettle = () => {
        if (settleTimer !== null) {
          window.clearTimeout(settleTimer);
          settleTimer = null;
        }
      };
      const dispatchKb = (type: 'oc:keyboard-intent' | 'oc:keyboard-anim' | 'oc:keyboard-settled', detail: Record<string, unknown>) => {
        window.dispatchEvent(new CustomEvent(type, { detail }));
      };
      const isVisibleKbMover = (element: HTMLElement): boolean => (
        element.getClientRects().length > 0
        && getComputedStyle(element).visibility !== 'hidden'
      );
      const findVisibleKbMover = <T extends HTMLElement>(selector: string): T | null => {
        for (const element of document.querySelectorAll<T>(selector)) {
          if (isVisibleKbMover(element)) return element;
        }
        return null;
      };
      const getKbMovers = (anchor?: EventTarget | null): Array<{ el: HTMLElement; factor: number }> => {
        const movers: Array<{ el: HTMLElement; factor: number }> = [];
        const anchorElement = anchor instanceof Element ? anchor : null;
        // When the focus anchor is known and is not the bottom composer, never
        // fall back to lifting a visible composer (question / other fields).
        if (anchorElement && !isComposerKeyboardTarget(anchorElement)) {
          return movers;
        }
        const anchoredComposer = anchorElement?.closest<HTMLElement>('.oc-mobile-composer') ?? null;
        const composer = anchoredComposer && isVisibleKbMover(anchoredComposer)
          ? anchoredComposer
          : findVisibleKbMover<HTMLElement>('.oc-mobile-composer');
        if (composer) movers.push({ el: composer, factor: 1 });
        // Draft title only rides along when the bottom composer is lifting.
        if (composer) {
          const draftCenter = findVisibleKbMover<HTMLElement>('.oc-draft-center');
          if (draftCenter) movers.push({ el: draftCenter, factor: 0.5 });
        }
        return movers;
      };
      const isTextFieldLike = (node: unknown): boolean =>
        node instanceof HTMLElement
        && (node.tagName === 'TEXTAREA' || node.tagName === 'INPUT' || node.isContentEditable);
      // ChatInput dispatches oc:keyboard-intent before focus lands. Treat that as
      // composer-scoped unless another text field already owns focus (question).
      const shouldLiftComposerForIntent = (): boolean => {
        const active = document.activeElement;
        if (isTextFieldLike(active) && !isComposerKeyboardTarget(active)) return false;
        return true;
      };
      const shouldLiftComposerForFocus = (anchor: EventTarget | null | undefined): boolean => (
        isComposerKeyboardTarget(anchor)
      );
      const clearKbMovers = () => {
        for (const el of document.querySelectorAll<HTMLElement>('.oc-mobile-composer, .oc-draft-center')) {
          el.style.transition = '';
          el.style.transform = '';
        }
      };
      const measureSafeBottom = () => {
        const shell = document.querySelector('.oc-mobile-app-shell');
        safeBottomPx = shell ? parseFloat(getComputedStyle(shell).paddingBottom) || 0 : 0;
      };

      // ── Android: pre-focus CSS FLIP from cached IME height ────────────────
      if (isAndroid) {
        const IME_RATIO_STORAGE_KEY = 'openchamber.androidImeHeightRatio.v2';
        // Open starts from intent/focus before the IME moves; keep it short.
        // Close usually begins after the system IME has already started (or
        // finished) dismissing, so a long hide leaves the composer hanging.
        const SHOW_MS = 200;
        const CORRECT_MS = 60;
        const HIDE_MS = 100;
        const SHOW_EASING = 'cubic-bezier(0.2, 0, 0, 1)';
        const HIDE_EASING = 'cubic-bezier(0.4, 0, 1, 1)';
        let androidTimer: number | null = null;
        let composerLiftArmed = false;

        const isTextField = isTextFieldLike;

        const clampRatio = (value: number): number => (
          Number.isFinite(value) ? Math.min(0.68, Math.max(0.28, value)) : 0.39
        );
        const readCachedRatio = (): number => {
          try {
            return clampRatio(Number.parseFloat(localStorage.getItem(IME_RATIO_STORAGE_KEY) ?? ''));
          } catch {
            return 0.39;
          }
        };
        let imeHeight = Math.round(window.innerHeight * readCachedRatio());
        // Keep the height that armed this keyboard session separate from the
        // measured cache. The native state event refreshes the next-open cache;
        // rewriting an in-flight transform from that event creates a second rise.
        let armedImeHeight = 0;
        const persistHeight = (height: number) => {
          imeHeight = Math.max(0, Math.round(height));
          if (imeHeight <= 0 || window.innerHeight <= 0) return;
          try {
            localStorage.setItem(IME_RATIO_STORAGE_KEY, String(clampRatio(imeHeight / window.innerHeight)));
          } catch {
            // Restricted storage keeps the in-memory value for this app run.
          }
        };
        const clearAndroidTimer = () => {
          if (androidTimer === null) return;
          window.clearTimeout(androidTimer);
          androidTimer = null;
        };
        const getAndroidSlide = (height: number) => Math.max(0, Math.round(height - safeBottomPx));
        const getAndroidTransform = (slide: number, factor: number) => `translate3d(0, ${-slide * factor}px, 0)`;
        const liftMovers = (height: number, durationMs: number, easing: string, anchor?: EventTarget | null): number => {
          clearAndroidTimer();
          const slide = getAndroidSlide(height);
          const movers = getKbMovers(anchor);
          root.classList.add('oc-kb-animating');
          for (const { el, factor } of movers) {
            el.style.transition = `transform ${durationMs}ms ${easing}`;
            el.style.transform = getAndroidTransform(slide, factor);
          }
          androidTimer = window.setTimeout(() => {
            androidTimer = null;
            root.classList.remove('oc-kb-animating');
            for (const { el } of movers) {
              el.style.transition = '';
            }
          }, durationMs + 20);
          return slide;
        };

        const reserveFieldScrollInset = (height: number) => {
          measureSafeBottom();
          const resolvedHeight = Math.max(0, Math.round(height));
          keyboardOpen = true;
          composerLiftArmed = false;
          armedImeHeight = resolvedHeight;
          root.classList.remove('oc-keyboard-open', 'oc-kb-animating');
          setInset(resolvedHeight);
          setVar('--oc-kb-layout', 0);
          setVar('--oc-kb-scroll-inset', getAndroidSlide(resolvedHeight));
          clearAndroidTimer();
          clearKbMovers();
          dispatchKb('oc:keyboard-settled', { open: true });
        };

        const markOpen = (
          anchor?: EventTarget | null,
          source: 'intent' | 'focus' | 'ime' = 'focus',
        ) => {
          // Only the bottom chat composer arms the transform FLIP. Question
          // cards and other text fields open the IME without lifting chrome.
          if (source === 'intent') {
            if (!shouldLiftComposerForIntent()) return;
          } else if (source === 'focus') {
            if (!shouldLiftComposerForFocus(anchor)) return;
          } else if (!keyboardOpen && !shouldLiftComposerForFocus(document.activeElement)) {
            // IME open for a non-composer field: leave composer state untouched.
            return;
          }
          measureSafeBottom();
          if (keyboardOpen) {
            const activeImeHeight = armedImeHeight || imeHeight;
            const slide = getAndroidSlide(activeImeHeight);
            const movers = getKbMovers(source === 'focus' ? anchor : undefined);
            if (movers.length === 0) return;
            composerLiftArmed = true;
            root.classList.add('oc-keyboard-open');
            setInset(0);
            setVar('--oc-kb-scroll-inset', 0);
            const alreadyPositioned = movers.every(
              ({ el, factor }) => el.style.transform === getAndroidTransform(slide, factor),
            );
            if (alreadyPositioned) return;
            liftMovers(activeImeHeight, CORRECT_MS, SHOW_EASING, source === 'focus' ? anchor : undefined);
            dispatchKb('oc:keyboard-anim', {
              phase: 'show',
              slide,
              durationMs: CORRECT_MS,
              easing: SHOW_EASING,
            });
            dispatchKb('oc:keyboard-settled', { open: true });
            return;
          }
          keyboardOpen = true;
          composerLiftArmed = true;
          root.classList.add('oc-keyboard-open');
          setInset(0);
          setVar('--oc-kb-layout', 0);
          setVar('--oc-kb-scroll-inset', 0);
          armedImeHeight = imeHeight;
          const slide = liftMovers(armedImeHeight, SHOW_MS, SHOW_EASING, source === 'focus' ? anchor : undefined);
          dispatchKb('oc:keyboard-anim', {
            phase: 'show',
            slide,
            durationMs: SHOW_MS,
            easing: SHOW_EASING,
          });
          dispatchKb('oc:keyboard-settled', { open: true });
        };
        const markClosed = (blur: boolean) => {
          // focusout and oc:ime-state can both fire for one dismissal; restarting
          // the hide transition mid-flight is what parks the composer above the
          // already-gone IME for an extra beat.
          if (!keyboardOpen) {
            if (blur && isTextField(document.activeElement)) {
              (document.activeElement as HTMLElement).blur();
            }
            return;
          }
          const activeImeHeight = armedImeHeight || imeHeight;
          const hadComposerLift = composerLiftArmed;
          keyboardOpen = false;
          composerLiftArmed = false;
          armedImeHeight = 0;
          if (blur && isTextField(document.activeElement)) {
            (document.activeElement as HTMLElement).blur();
          }
          root.classList.remove('oc-keyboard-open');
          setInset(0);
          setVar('--oc-kb-layout', 0);
          setVar('--oc-kb-scroll-inset', 0);
          dispatchKb('oc:keyboard-intent', { open: false });
          const slide = getAndroidSlide(activeImeHeight);
          if (!hadComposerLift) {
            clearAndroidTimer();
            clearKbMovers();
            dispatchKb('oc:keyboard-settled', { open: false });
            return;
          }
          // Start the transform first so the same frame collapses chrome + lift.
          liftMovers(0, HIDE_MS, HIDE_EASING);
          dispatchKb('oc:keyboard-anim', {
            phase: 'hide',
            slide,
            durationMs: HIDE_MS,
            easing: HIDE_EASING,
          });
          clearAndroidTimer();
          androidTimer = window.setTimeout(() => {
            androidTimer = null;
            root.classList.remove('oc-kb-animating');
            clearKbMovers();
            dispatchKb('oc:keyboard-settled', { open: false });
          }, HIDE_MS + 20);
        };

        // ChatInput intent runs before focus (pre-IME). focusin lifts only the
        // bottom composer; other text fields reserve chat scroll room.
        const handleFocusIn = (event: FocusEvent) => {
          if (!isTextField(event.target)) return;
          if (isComposerKeyboardTarget(event.target)) {
            markOpen(event.target, 'focus');
            return;
          }
          reserveFieldScrollInset(armedImeHeight || imeHeight);
        };
        const handleFocusOut = (event: FocusEvent) => {
          if (!isTextField(event.target)) return;
          // During focusout, activeElement is often still the field being blurred.
          // relatedTarget is the authoritative next focus for same-document moves.
          // Stay open only when focus remains inside the bottom composer; moving
          // to a question card (or any other field) must drop the lift.
          if (isComposerKeyboardFocusTransfer(event.relatedTarget)) return;
          if (shouldReserveChatScrollInset(event.relatedTarget)) {
            dispatchKb('oc:keyboard-intent', { open: false });
            reserveFieldScrollInset(armedImeHeight || imeHeight);
            return;
          }
          // Prefer the earliest close signal. A zero-timeout waits a full task and
          // lets the system IME finish before the composer starts dropping.
          markClosed(false);
        };
        const handleImeState = (event: Event) => {
          type ImeStateEvent = Event & {
            open?: boolean;
            height?: number;
            detail?: { open?: boolean; height?: number };
          };
          const nativeEvent = event as ImeStateEvent;
          // Capacitor triggerJSEvent exposes payload fields on the event object;
          // CustomEvent detail remains supported for browser/test dispatches.
          const detail = nativeEvent.detail ?? nativeEvent;
          if (detail?.open === true) {
            const measured = cssPxFromNativeImeHeight(detail.height ?? 0, window.devicePixelRatio || 1);
            const action = getAndroidComposerImeStateAction(composerLiftArmed, document.activeElement);
            if (measured > 0 && (action === 'open' || action === 'cache')) {
              // A model-picker search field can have a different IME silhouette
              // from the composer. Keep the cache scoped to composer-owned opens.
              persistHeight(measured);
            }
            // The state event may beat focusin on a fast keyboard. In that case
            // it starts the single composer lift with the measured height. Once
            // a focus/intent lift is armed, this event only refreshes next-open
            // cache data and leaves its transform untouched.
            if (action === 'open') markOpen(document.activeElement, 'ime');
            if (action === 'cache' && shouldCorrectArmedImeLift(armedImeHeight || imeHeight, measured)) {
              // The estimate that armed this lift under-cleared the keyboard;
              // re-lift from the measured height so the composer is not covered
              // for the rest of the keyboard session.
              armedImeHeight = measured;
              const slide = liftMovers(
                measured,
                CORRECT_MS,
                SHOW_EASING,
                isComposerKeyboardTarget(document.activeElement) ? document.activeElement : undefined,
              );
              dispatchKb('oc:keyboard-anim', { phase: 'show', slide, durationMs: CORRECT_MS, easing: SHOW_EASING });
            }
            if (action === 'field') reserveFieldScrollInset(measured || imeHeight);
          }
          if (detail?.open === false) markClosed(true);
        };
        const handleKeyboardIntent = (event: Event) => {
          const detail = (event as CustomEvent<{ open?: boolean }>).detail;
          // ChatInput is the only intent source (pre-focus composer expand).
          if (detail?.open === true) markOpen(undefined, 'intent');
        };

        document.addEventListener('focusin', handleFocusIn, true);
        document.addEventListener('focusout', handleFocusOut, true);
        window.addEventListener('oc:ime-state', handleImeState);
        window.addEventListener('oc:keyboard-intent', handleKeyboardIntent);

        if (disposed) {
          clearAndroidTimer();
          document.removeEventListener('focusin', handleFocusIn, true);
          document.removeEventListener('focusout', handleFocusOut, true);
          window.removeEventListener('oc:ime-state', handleImeState);
          window.removeEventListener('oc:keyboard-intent', handleKeyboardIntent);
          return;
        }
        cleanup.push(
          clearAndroidTimer,
          () => document.removeEventListener('focusin', handleFocusIn, true),
          () => document.removeEventListener('focusout', handleFocusOut, true),
          () => window.removeEventListener('oc:ime-state', handleImeState),
          () => window.removeEventListener('oc:keyboard-intent', handleKeyboardIntent),
        );
        return;
      }

      // ── iOS: shrink the shell immediately (no transform FLIP) ────────────
      const IOS_IME_RATIO_STORAGE_KEY = 'openchamber.iosImeHeightRatio.v1';
      const clampIosImeRatio = (value: number): number => (
        Number.isFinite(value) ? Math.min(0.68, Math.max(0.28, value)) : 0.39
      );
      const readCachedIosImeHeight = (): number => {
        try {
          const ratio = clampIosImeRatio(Number.parseFloat(localStorage.getItem(IOS_IME_RATIO_STORAGE_KEY) ?? ''));
          return Math.round(window.innerHeight * ratio);
        } catch {
          return Math.round(window.innerHeight * 0.39);
        }
      };
      const persistIosImeHeight = (height: number) => {
        if (height <= 0 || window.innerHeight <= 0) return;
        try {
          localStorage.setItem(IOS_IME_RATIO_STORAGE_KEY, String(clampIosImeRatio(height / window.innerHeight)));
        } catch {
          // Restricted storage keeps the current native measurement for this app run.
        }
      };
      // Header stays pinned. The shell height drops by the IME so the whole
      // composer (textarea + model/attach footer + foot padding) sits in flow
      // at the new shell bottom — not just the focused caret. Clear
      // --oc-kb-scroll-inset here: that var is only for non-composer fields
      // that keep a full-height shell and need chat-scroll padding to reveal.
      const applyIosKeyboardLayout = (height: number): number => {
        measureSafeBottom();
        const slide = Math.max(0, height - safeBottomPx);
        setInset(height);
        setVar('--oc-kb-layout', height);
        setVar('--oc-kb-scroll-inset', 0);
        layoutApplied = true;
        clearKbMovers();
        window.scrollTo(0, 0);
        if (document.body.scrollTop !== 0) document.body.scrollTop = 0;
        // WebKit's default reveal is the caret. Pin the form's BOTTOM edge
        // (footer + padding) to the visible bottom instead.
        findVisibleKbMover<HTMLElement>('.oc-mobile-composer')
          ?.scrollIntoView({ block: 'end', inline: 'nearest' });
        return slide;
      };
      const handleIosKeyboardIntent = (event: Event) => {
        if (root.classList.contains('oc-native-ios-composer')) return;
        const detail = (event as CustomEvent<{ open?: boolean }>).detail;
        if (detail?.open !== true || layoutApplied) return;
        // Intent is composer-scoped (ChatInput). Skip when a non-composer field
        // already owns focus (e.g. question card).
        if (isTextFieldLike(document.activeElement) && !isComposerKeyboardTarget(document.activeElement)) {
          return;
        }
        keyboardOpen = true;
        root.classList.remove('oc-kb-hide');
        root.classList.add('oc-keyboard-open');
        const predictedHeight = keyboardHeight > 0 ? keyboardHeight : readCachedIosImeHeight();
        const slide = applyIosKeyboardLayout(predictedHeight);
        dispatchKb('oc:keyboard-anim', {
          phase: 'show',
          slide,
          durationMs: 0,
          easing: KB_ANIM_EASING,
        });
        dispatchKb('oc:keyboard-settled', { open: true });
      };
      window.addEventListener('oc:keyboard-intent', handleIosKeyboardIntent);

      const showHandle = await Keyboard.addListener('keyboardWillShow', (info) => {
        if (root.classList.contains('oc-native-ios-composer')) return;
        clearSettle();
        keyboardHeight = info.keyboardHeight;
        persistIosImeHeight(keyboardHeight);
        // Overlay portals still need the inset. Shell shrink is reserved for
        // the bottom chat input only.
        const liftComposer = isComposerKeyboardTarget(document.activeElement) || (
          // Pre-focus intent may have armed the open class before focus lands.
          root.classList.contains('oc-keyboard-open')
          && !isTextFieldLike(document.activeElement)
        );
        keyboardOpen = true;
        root.classList.remove('oc-kb-hide');
        if (caretTimer !== null) {
          window.clearTimeout(caretTimer);
          caretTimer = null;
        }
        if (!liftComposer) {
          // Question / other fields: keep the overlay and chat scroll insets
          // without shrinking the shell or moving the bottom composer.
          setInset(keyboardHeight);
          setVar('--oc-kb-layout', 0);
          measureSafeBottom();
          setVar('--oc-kb-scroll-inset', Math.max(0, keyboardHeight - safeBottomPx));
          root.classList.remove('oc-keyboard-open', 'oc-kb-animating', 'oc-kb-caret-hold');
          clearKbMovers();
          layoutApplied = false;
          dispatchKb('oc:keyboard-settled', { open: true });
          return;
        }
        root.classList.add('oc-keyboard-open');
        const slide = applyIosKeyboardLayout(keyboardHeight);
        dispatchKb('oc:keyboard-settled', { open: true });
        dispatchKb('oc:keyboard-anim', { phase: 'show', slide, durationMs: 0, easing: KB_ANIM_EASING });
      });

      const blurActiveTextField = () => {
        const active = document.activeElement;
        if (!(active instanceof HTMLElement)) return;
        if (active.tagName !== 'TEXTAREA' && active.tagName !== 'INPUT' && !active.isContentEditable) return;
        active.blur();
      };

      const snapWindowScroll = () => {
        if (keyboardOpen) return;
        window.scrollTo(0, 0);
        if (document.body.scrollTop !== 0) document.body.scrollTop = 0;
      };

      // Native overlay owns IME lift. Still unwind leftover --oc-kb-layout,
      // oc-keyboard-open, and WKWebView pan so hide cannot leave the shell raised.
      const unwindKeyboardShell = () => {
        keyboardOpen = false;
        clearSettle();
        if (caretTimer !== null) {
          window.clearTimeout(caretTimer);
          caretTimer = null;
        }
        root.classList.remove('oc-keyboard-open', 'oc-kb-animating', 'oc-kb-caret-hold', 'oc-kb-hide');
        setInset(0);
        setVar('--oc-kb-scroll-inset', 0);
        setVar('--oc-kb-layout', 0);
        layoutApplied = false;
        clearKbMovers();
        snapWindowScroll();
        window.setTimeout(snapWindowScroll, 350);
      };

      const runHide = () => {
        if (root.classList.contains('oc-native-ios-composer')) {
          unwindKeyboardShell();
          void getNativeIosComposerPlugin().blur();
          dispatchKb('oc:keyboard-settled', { open: false });
          return;
        }
        if (!keyboardOpen) return;
        keyboardOpen = false;
        clearSettle();
        // Collapse chrome first (ChatInput flushSync), then blur. Intent-before-blur
        // lets focusout run after collapse so interactive IME dismiss is less likely
        // to see a still-focused composer and bail. One short confirm retries if
        // WKWebView restored focus onto the textarea without reopening the keyboard.
        dispatchKb('oc:keyboard-intent', { open: false });
        blurActiveTextField();
        window.setTimeout(() => {
          if (keyboardOpen) return;
          if (!isComposerKeyboardTarget(document.activeElement)) return;
          blurActiveTextField();
          dispatchKb('oc:keyboard-intent', { open: false });
        }, 80);
        if (caretTimer !== null) {
          window.clearTimeout(caretTimer);
          caretTimer = null;
        }
        root.classList.remove('oc-kb-caret-hold', 'oc-kb-animating');
        const slide = Math.max(0, keyboardHeight - safeBottomPx);
        root.classList.remove('oc-keyboard-open');
        setInset(0);
        setVar('--oc-kb-scroll-inset', 0);
        setVar('--oc-kb-layout', 0);
        layoutApplied = false;
        clearKbMovers();
        // WKWebView pans its own scroll view to reveal the caret on focus and
        // unwinds that pan with its own ~keyboard-duration animation on hide —
        // geometry vars above are already at rest while the page still reads
        // "lifted" until WebKit finishes scrolling. Zero the window scroll now
        // and once more as the keyboard finishes (mirrors the standalone-PWA
        // snap below) so the shell lands with the keyboard, not after it.
        snapWindowScroll();
        window.setTimeout(snapWindowScroll, 350);
        dispatchKb('oc:keyboard-anim', { phase: 'hide', slide, durationMs: 0, easing: KB_ANIM_EASING });
        root.classList.add('oc-kb-animating', 'oc-kb-hide');
        settleTimer = window.setTimeout(() => {
          settleTimer = null;
          root.classList.remove('oc-kb-animating', 'oc-kb-hide');
          dispatchKb('oc:keyboard-settled', { open: false });
        }, KB_HIDE_CURTAIN_MS);
      };

      const hideHandle = await Keyboard.addListener('keyboardWillHide', runHide);

      const isTextInput = (node: unknown): boolean =>
        node instanceof HTMLElement
        && (node.tagName === 'TEXTAREA' || node.tagName === 'INPUT' || node.isContentEditable);
      const handleFocusOut = (event: FocusEvent) => {
        if (!keyboardOpen) return;
        if (!isTextInput(event.target)) return;
        // Drop composer lift when focus leaves the bottom composer (question
        // cards and other fields must not keep the shell raised).
        if (isComposerKeyboardFocusTransfer(event.relatedTarget)) {
          setVar('--oc-kb-scroll-inset', 0);
          return;
        }
        window.setTimeout(() => {
          if (!keyboardOpen) return;
          if (isComposerKeyboardTarget(document.activeElement)) return;
          // IME may still be open for a non-composer field — only reverse the
          // composer/shell lift; blur is for true keyboard dismissal paths.
          if (isTextInput(document.activeElement)) {
            // Soft reverse: clear layout without blurring the new field.
            clearSettle();
            root.classList.remove('oc-keyboard-open', 'oc-kb-animating', 'oc-kb-caret-hold', 'oc-kb-hide');
            setInset(keyboardHeight);
            setVar('--oc-kb-layout', 0);
            measureSafeBottom();
            setVar('--oc-kb-scroll-inset', Math.max(0, keyboardHeight - safeBottomPx));
            layoutApplied = false;
            clearKbMovers();
            // Let ChatInput collapse expanded chrome; do not blur the new field.
            dispatchKb('oc:keyboard-intent', { open: false });
            dispatchKb('oc:keyboard-settled', { open: true });
            return;
          }
          runHide();
        }, 0);
      };
      document.addEventListener('focusout', handleFocusOut, true);

      if (disposed) {
        clearSettle();
        document.removeEventListener('focusout', handleFocusOut, true);
        window.removeEventListener('oc:keyboard-intent', handleIosKeyboardIntent);
        void showHandle.remove();
        void hideHandle.remove();
        return;
      }
      cleanup.push(
        clearSettle,
        () => {
          if (caretTimer !== null) {
            window.clearTimeout(caretTimer);
            caretTimer = null;
          }
        },
        () => document.removeEventListener('focusout', handleFocusOut, true),
        () => window.removeEventListener('oc:keyboard-intent', handleIosKeyboardIntent),
        () => void showHandle.remove(),
        () => void hideHandle.remove(),
      );
    }).catch(() => undefined);

    return () => {
      disposed = true;
      cleanup.forEach((remove) => remove());
      root.classList.remove('oc-capacitor-app', 'oc-keyboard-open', 'oc-kb-animating', 'oc-kb-hide', 'oc-kb-caret-hold', 'oc-platform-android');
      root.style.removeProperty('--oc-keyboard-inset');
      root.style.removeProperty('--oc-kb-shift');
      root.style.removeProperty('--oc-kb-layout');
      root.style.removeProperty('--oc-kb-scroll-inset');
    };
  }, []);
};

const useNativeMobileLifecycle = (onResume: () => void): void => {
  const wasInactiveRef = React.useRef(false);

  React.useEffect(() => {
    if (!isCapacitorMobileApp()) return;

    let disposed = false;
    const cleanup: Array<() => void> = [];
    const resumeAfterInactive = () => {
      if (!wasInactiveRef.current) return;
      wasInactiveRef.current = false;
      onResume();
    };

    // Belt-and-suspenders resume detection. Capacitor's `appStateChange` is the
    // primary signal, but on iOS it can be missed after a long suspend, so the
    // webview's own `visibilitychange` is a second trigger — either one flips
    // wasInactiveRef and fires onResume exactly once per background→foreground.
    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') {
        wasInactiveRef.current = true;
        return;
      }
      resumeAfterInactive();
    };
    document.addEventListener('visibilitychange', handleVisibility);
    cleanup.push(() => document.removeEventListener('visibilitychange', handleVisibility));

    void import('@capacitor/app').then(async ({ App }) => {
      if (disposed) return;
      const initialState = await App.getState().catch(() => null);
      if (disposed) return;
      if (initialState) {
        document.documentElement.classList.toggle('oc-native-app-active', initialState.isActive);
      }
      const state = await App.addListener('appStateChange', ({ isActive }) => {
        document.documentElement.classList.toggle('oc-native-app-active', isActive);
        if (!isActive) {
          wasInactiveRef.current = true;
          return;
        }
        resumeAfterInactive();
      });
      const resume = await App.addListener('resume', resumeAfterInactive);
      if (disposed) {
        void state.remove();
        void resume.remove();
        return;
      }
      cleanup.push(() => void state.remove(), () => void resume.remove());
    }).catch(() => undefined);

    return () => {
      disposed = true;
      cleanup.forEach((remove) => remove());
      document.documentElement.classList.remove('oc-native-app-active');
    };
  }, [onResume]);
};

const useNativeAndroidBackButton = (onBack: () => boolean): void => {
  React.useEffect(() => {
    if (!isCapacitorMobileApp()) return;

    let disposed = false;
    let remove: (() => void) | null = null;

    void import('@capacitor/app').then(async ({ App }) => {
      if (disposed) return;
      const listener = await App.addListener('backButton', () => {
        if (onBack()) return;
        void App.minimizeApp().catch(() => undefined);
      });
      if (disposed) {
        void listener.remove();
        return;
      }
      remove = () => void listener.remove();
    }).catch(() => undefined);

    return () => {
      disposed = true;
      remove?.();
    };
  }, [onBack]);
};

const normalizePath = (value?: string | null): string =>
  (value || '').replace(/\\/g, '/').replace(/\/+$/g, '');

const mobileInputKeyboardProps = {
  autoComplete: 'off',
  autoCorrect: 'off',
  spellCheck: false,
} as const;

const NATIVE_RESUME_SYNC_EVENT_THROTTLE_MS = 1_000;

const getProjectLabel = (path: string): string => {
  const normalized = normalizePath(path);
  if (!normalized) return '';
  const segments = normalized.split('/').filter(Boolean);
  return segments[segments.length - 1] || normalized;
};

type OverflowItem = {
  key: 'new-session' | 'refresh-transcript' | 'files' | 'changes' | 'scheduled' | 'assistant' | 'mcp' | 'instances' | 'update' | 'settings';
  icon?: IconName;
  iconNode?: React.ReactNode;
  label: string;
  badge?: number;
  disabled?: boolean;
  spinning?: boolean;
  onSelect: () => void;
};

const getProjectDisplayLabel = (project: ProjectEntry | null, fallbackDirectory: string): string => {
  if (project) return getProjectLabel(project.path);
  return getProjectLabel(fallbackDirectory);
};

const WELCOME_MANUAL_INPUT_CLASS =
  'h-12 w-full rounded-[16px] border border-border/70 bg-surface-elevated px-4 text-center text-[16px] text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary focus:ring-2 focus:ring-primary/20';

const MobileConnectionWelcome: React.FC<{ connection: UseMobileConnection }> = ({ connection }) => {
  const { t } = useI18n();
  const conn = connection;
  const { connections, isBusy, isPasswordBusy, error, pendingConnection } = conn;
  const [serverUrl, setServerUrl] = React.useState('');
  const [connectionName, setConnectionName] = React.useState('');
  const [clientToken, setClientToken] = React.useState('');
  const [isScanning, setIsScanning] = React.useState(false);
  const qrScanSupported = React.useMemo(() => isQrScanSupported(), []);
  // QR pairing is the primary flow; the manual connection forms stay collapsed unless
  // scanning is unavailable (web build) or the user asks for it.
  const [manualOpen, setManualOpen] = React.useState(() => !isQrScanSupported());
  // Which saved connection is being connected to, for the per-row spinner.
  const [connectingId, setConnectingId] = React.useState<string | null>(null);
  const [password, setPassword] = React.useState('');

  const handleSubmit = useEvent((event: React.FormEvent) => {
    event.preventDefault();
    void conn.connect({ url: serverUrl, clientToken, label: connectionName });
  });

  const handlePairingLinkRedeem = useEvent((pairing: PairingConnectionPayload) => {
    void conn.redeemPairingConnection(pairing);
  });

  const handlePairingLinkInvalid = useEvent(() => {
    conn.setError(t('mobile.connect.link.invalid'));
  });

  const handleScanQr = useEvent(async () => {
    if (isScanning || isBusy) return;
    conn.setError(null);
    setIsScanning(true);
    try {
      const result = await scanConnectionQr();
      switch (result.status) {
        case 'ok':
          setServerUrl(result.url);
          if (result.label) setConnectionName(result.label);
          if (result.clientToken) setClientToken(result.clientToken);
          await conn.connect({ url: result.url, clientToken: result.clientToken, label: result.label });
          break;
        case 'pairing':
          await conn.redeemPairingConnection(result.pairing);
          break;
        case 'permission-denied':
          conn.setError(t('mobile.connect.scan.permissionDenied'));
          break;
        case 'invalid':
          conn.setError(t('mobile.connect.scan.invalid'));
          break;
        case 'unsupported':
          conn.setError(t('mobile.connect.scan.unsupported'));
          break;
        case 'failed':
          conn.setError(t('mobile.connect.scan.failed'));
          break;
        case 'cancelled':
        default:
          break;
      }
    } finally {
      setIsScanning(false);
    }
  });

  const handlePasswordSubmit = useEvent((event: React.FormEvent) => {
    event.preventDefault();
    void conn.submitPassword(password);
  });

  const cancelPassword = useEvent(() => {
    setPassword('');
    conn.cancelPassword();
  });

  return (
    <main className="oc-keyboard-fill-screen flex min-h-dvh flex-col overflow-y-auto bg-background px-6 pb-[calc(var(--safe-area-inset-bottom,env(safe-area-inset-bottom,0px))+28px)] pt-[calc(var(--safe-area-inset-top,env(safe-area-inset-top,0px))+28px)] text-foreground">
      <div className="m-auto flex w-full max-w-[360px] shrink-0 flex-col items-center gap-9 py-8">
        <div className="flex flex-col items-center gap-5 text-center">
          <OpenChamberLogo width={72} height={72} className="size-[72px]" />
          <h1 className="typography-h2 text-foreground">{t('mobile.connect.welcome.title')}</h1>
        </div>

        {pendingConnection ? (
          <form className="flex w-full flex-col gap-3" onSubmit={handlePasswordSubmit}>
            <div className="flex items-center gap-3 rounded-[18px] border border-border/70 bg-surface-elevated px-3.5 py-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-[12px] bg-interactive-hover text-foreground">
                <Icon name="lock" className="size-[18px]" />
              </span>
              <div className="min-w-0 text-left">
                <p className="truncate typography-ui-label text-foreground">{pendingConnection.label}</p>
                <p className="truncate typography-small text-muted-foreground">
                  {pendingConnection.candidates.some((c) => c.kind === 'direct') ? connectionDisplayUrl(pendingConnection) : t('mobile.connect.relay.badge')}
                </p>
              </div>
            </div>
            <input
              {...mobileInputKeyboardProps}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={t('mobile.connect.password.placeholder')}
              aria-label={t('mobile.connect.password.label')}
              type="password"
              autoFocus
              className="h-12 w-full rounded-[16px] border border-border/70 bg-surface-elevated px-4 text-[16px] text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary focus:ring-2 focus:ring-primary/20"
            />
            {error ? <p className="px-1 text-center typography-small text-[var(--status-error)]">{error}</p> : null}
            <Button type="submit" size="lg" className="mt-1 h-12 w-full" disabled={isPasswordBusy || !password.trim()}>
              {isPasswordBusy ? t('mobile.connect.connecting') : t('mobile.connect.unlockButton')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="w-full"
              onClick={cancelPassword}
            >
              {t('mobile.connect.cancelPassword')}
            </Button>
          </form>
        ) : (
          <div className="flex w-full flex-col gap-6">
            {/* Primary path: scan the pairing QR from "Add a device" on the server. */}
            {qrScanSupported ? (
              <div className="flex w-full flex-col gap-2">
                <Button
                  type="button"
                  size="lg"
                  className="h-12 w-full"
                  onClick={() => void handleScanQr()}
                  disabled={isScanning || isBusy}
                >
                  <Icon name="scan-2" className={cn('size-[18px]', isScanning && 'animate-pulse')} />
                  {isBusy ? t('mobile.connect.connecting') : t('mobile.connect.scanQr')}
                </Button>
                <p className="px-2 text-center typography-small text-muted-foreground">
                  {t('mobile.connect.welcome.scanHint')}
                </p>
              </div>
            ) : null}

            {error && !manualOpen ? <p className="px-1 text-center typography-small text-[var(--status-error)]">{error}</p> : null}

            {connections.length > 0 ? (
              <section className="flex w-full flex-col gap-2.5">
                <h2 className="text-center typography-micro uppercase tracking-[0.14em] text-muted-foreground">
                  {t('mobile.connect.saved.title')}
                </h2>
                <div className="overflow-hidden rounded-[18px] border border-border/70 bg-surface-elevated">
                  {connections.map((connection) => {
                    const isConnectingRow = connectingId === connection.id;
                    return (
                      <button
                        key={connection.id}
                        type="button"
                        disabled={isBusy}
                        className="flex min-h-14 w-full items-center gap-3 border-b border-border/60 px-3.5 py-2.5 text-left last:border-b-0 hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary disabled:opacity-70"
                        onClick={() => {
                          setConnectingId(connection.id);
                          void conn.connect({ id: connection.id, candidates: connection.candidates, clientToken: connection.clientToken, label: connection.label })
                            .finally(() => setConnectingId(null));
                        }}
                      >
                        <span className="flex size-9 shrink-0 items-center justify-center rounded-[12px] bg-interactive-hover text-foreground">
                          <Icon name="server" className="size-[18px]" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate typography-ui-label text-foreground">{connection.label}</span>
                          <span className={cn('block truncate typography-small', isConnectingRow ? 'text-foreground' : 'text-muted-foreground')}>
                            {isConnectingRow
                              ? t('mobile.connect.connecting')
                              : t('mobile.instances.status.saved')}
                          </span>
                        </span>
                        {isConnectingRow
                          ? <Icon name="loader-4" className="size-5 animate-spin text-muted-foreground" />
                          : <Icon name="arrow-right-s" className="size-5 text-muted-foreground" />}
                      </button>
                    );
                  })}
                </div>
              </section>
            ) : null}

            {/* Manual address and pairing-link entry, collapsed by default — most people pair by QR. */}
            <div className="flex w-full flex-col">
              {qrScanSupported ? (
                <button
                  type="button"
                  onClick={() => setManualOpen((value) => !value)}
                  aria-expanded={manualOpen}
                  className="mx-auto flex items-center gap-1 rounded-full px-2 py-1 typography-small text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                  <span>{t('mobile.connect.manual.toggle')}</span>
                  <Icon name="arrow-down-s" className={cn('size-4 transition-transform duration-200', manualOpen && 'rotate-180')} />
                </button>
              ) : null}
              <div
                className="grid transition-[grid-template-rows] duration-200 ease-out"
                style={{ gridTemplateRows: manualOpen ? '1fr' : '0fr' }}
              >
                <div className="min-h-0 overflow-hidden">
                  {/* Pairing link first — fewer fields, less error-prone than typing a LAN URL. */}
                  <div className="pt-3">
                    <MobilePairingLinkForm
                      disabled={isBusy || isScanning}
                      isBusy={isBusy}
                      tabIndex={manualOpen ? undefined : -1}
                      inputClassName={WELCOME_MANUAL_INPUT_CLASS}
                      buttonVariant={qrScanSupported ? 'outline' : 'default'}
                      onRedeem={handlePairingLinkRedeem}
                      onInvalid={handlePairingLinkInvalid}
                    />
                  </div>
                  <MobileConnectionMethodDivider label={t('mobile.connect.address.divider')} />
                  <form className="flex w-full flex-col gap-3" onSubmit={handleSubmit}>
                    <input
                      {...mobileInputKeyboardProps}
                      value={serverUrl}
                      onChange={(event) => setServerUrl(event.target.value)}
                      placeholder={t('mobile.connect.url.placeholder')}
                      aria-label={t('mobile.connect.url.label')}
                      type="url"
                      inputMode="url"
                      autoCapitalize="none"
                      tabIndex={manualOpen ? undefined : -1}
                      className={WELCOME_MANUAL_INPUT_CLASS}
                    />
                    <input
                      value={connectionName}
                      onChange={(event) => setConnectionName(event.target.value)}
                      placeholder={t('mobile.instances.label.placeholder')}
                      aria-label={t('mobile.instances.label.label')}
                      autoComplete="off"
                      autoCapitalize="words"
                      autoCorrect="off"
                      spellCheck={false}
                      tabIndex={manualOpen ? undefined : -1}
                      className={WELCOME_MANUAL_INPUT_CLASS}
                    />
                    <input
                      {...mobileInputKeyboardProps}
                      value={clientToken}
                      onChange={(event) => setClientToken(event.target.value)}
                      placeholder={t('mobile.connect.token.placeholder')}
                      aria-label={t('mobile.connect.token.label')}
                      tabIndex={manualOpen ? undefined : -1}
                      autoCapitalize="none"
                      className={WELCOME_MANUAL_INPUT_CLASS}
                    />
                    <p className="px-1 text-center typography-micro text-muted-foreground">{t('mobile.connect.token.hint')}</p>
                    <Button type="submit" variant="outline" size="lg" className="h-12 w-full" disabled={isBusy || isScanning || !serverUrl.trim()}>
                      {isBusy ? t('mobile.connect.connecting') : t('mobile.connect.connectButton')}
                    </Button>
                  </form>
                  {error ? <p className="px-1 pt-3 text-center typography-small text-[var(--status-error)]">{error}</p> : null}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </main>
  );
};

const MobileInstancesSurface: React.FC<{
  connection: UseMobileConnection;
  onConnect: () => void;
  onActiveConnectionDeleted: () => void;
}> = ({ connection, onActiveConnectionDeleted, onConnect }) => {
  const { t } = useI18n();
  const conn = connection;
  const {
    connections, isBusy, isPasswordBusy, error, pendingConnection,
    connect, submitPassword, cancelPassword, saveConnection, removeConnection, subscribeConnected, setError,
  } = conn;
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const editingConnection = editingId ? connections.find((connection) => connection.id === editingId) ?? null : null;
  const isRelayOnlyEditing = editingConnection ? !editingConnection.candidates.some((c) => c.kind === 'direct') : false;
  const [confirmingDeleteId, setConfirmingDeleteId] = React.useState<string | null>(null);
  const [url, setUrl] = React.useState('');
  const [label, setLabel] = React.useState('');
  const [clientToken, setClientToken] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [isScanning, setIsScanning] = React.useState(false);
  const qrScanSupported = React.useMemo(() => isQrScanSupported(), []);
  // The manual add/edit form is hidden until asked for — the sheet leads with
  // the list of instances (with live status), not a wall of inputs.
  const [formOpen, setFormOpen] = React.useState(false);
  // Which row is being connected to, for the per-row spinner.
  const [connectingId, setConnectingId] = React.useState<string | null>(null);
  const handleConnected = useEvent(onConnect);

  React.useEffect(
    () => subscribeConnected(handleConnected),
    [handleConnected, subscribeConnected],
  );

  // Populate/clear the form imperatively (on edit tap / cancel / save) rather than via
  // an effect keyed on the derived connection object. With an effect, any churn of the
  // connections list re-fires it and overwrites what the user is typing — the keyboard
  // "resets" mid-edit. Imperative population is immune to that.
  const resetForm = useEvent(() => {
    setEditingId(null);
    setUrl('');
    setLabel('');
    setClientToken('');
    setError(null);
    setFormOpen(false);
  });

  const saveInstance = useEvent((event: React.FormEvent) => {
    event.preventDefault();
    // The id is what makes this an EDIT: saveConnection uses it to preserve the
    // existing relay/https candidates (and the Keychain token they key) instead
    // of rebuilding the instance from the single URL field.
    void saveConnection({ id: editingId ?? undefined, url, label, clientToken }).then((saved) => {
      if (saved) resetForm();
    });
  });

  const handlePairingLinkRedeem = useEvent((pairing: PairingConnectionPayload) => {
    // Same path as the welcome screen: redeem and connect immediately.
    void conn.redeemPairingConnection(pairing);
  });

  const handlePairingLinkInvalid = useEvent(() => {
    setError(t('mobile.connect.link.invalid'));
  });

  // Scan a pairing QR into the add/edit form fields (does not change edit mode, so
  // the form-reset effect doesn't wipe the scanned values). The user reviews + saves.
  const handleScanInstance = useEvent(async () => {
    if (isScanning) return;
    setError(null);
    setIsScanning(true);
    try {
      const result = await scanConnectionQr();
      switch (result.status) {
        case 'ok':
          // Legacy token QR: prefill the manual form for review before saving.
          setUrl(result.url);
          if (result.label) setLabel(result.label);
          if (result.clientToken) setClientToken(result.clientToken);
          setFormOpen(true);
          break;
        case 'pairing':
          await conn.redeemPairingConnection(result.pairing);
          break;
        case 'permission-denied':
          setError(t('mobile.connect.scan.permissionDenied'));
          break;
        case 'invalid':
          setError(t('mobile.connect.scan.invalid'));
          break;
        case 'unsupported':
          setError(t('mobile.connect.scan.unsupported'));
          break;
        case 'failed':
          setError(t('mobile.connect.scan.failed'));
          break;
        case 'cancelled':
        default:
          break;
      }
    } finally {
      setIsScanning(false);
    }
  });

  const handlePasswordSubmit = useEvent((event: React.FormEvent) => {
    event.preventDefault();
    void submitPassword(password);
  });

  const cancelPasswordPrompt = useEvent(() => {
    setPassword('');
    cancelPassword();
  });

  // Two-step delete (mirrors the session sheet): the trash icon arms the row, a
  // second tap on the destructive button confirms, the X disarms. No hover relied on.
  const toggleConfirmDelete = useEvent((id: string) => {
    setConfirmingDeleteId((current) => (current === id ? null : id));
  });

  const confirmDelete = useEvent((id: string) => {
    setConfirmingDeleteId(null);
    if (editingId === id) resetForm();
    // Removing the ACTIVE instance — or the LAST one — must drop the user back
    // to the connect screen instead of leaving them in a stale, unbacked UI.
    const wasLast = connections.length === 1;
    void removeConnection(id).then((removed) => {
      if (!removed) return;
      if (wasLast || isActiveRuntimeConnection(removed)) {
        onActiveConnectionDeleted();
      }
    });
  });

  const inputClass = 'h-12 w-full rounded-[16px] border border-border/70 bg-surface-elevated px-4 text-[16px] text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary focus:ring-2 focus:ring-primary/20';

  if (pendingConnection) {
    return (
      <div className="oc-settings-page-content">
        <SettingsGroup
          label={t('mobile.connect.password.label')}
          itemId="instances.manage"
        >
          <form className="oc-settings-group-row flex flex-col gap-3" onSubmit={handlePasswordSubmit}>
            <div className="flex items-center gap-3 rounded-[18px] border border-border/70 bg-surface-elevated px-3.5 py-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-[12px] bg-interactive-hover text-foreground">
                <Icon name="lock" className="size-[18px]" />
              </span>
              <div className="min-w-0">
                <p className="truncate typography-ui-label text-foreground">{pendingConnection.label}</p>
                <p className="truncate typography-small text-muted-foreground">
                  {pendingConnection.candidates.some((c) => c.kind === 'direct') ? connectionDisplayUrl(pendingConnection) : t('mobile.connect.relay.badge')}
                </p>
              </div>
            </div>
            <input
              {...mobileInputKeyboardProps}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={t('mobile.connect.password.placeholder')}
              aria-label={t('mobile.connect.password.label')}
              type="password"
              autoFocus
              className={inputClass}
            />
            {error ? <p className="px-1 typography-small text-[var(--status-error)]">{error}</p> : null}
            <Button type="submit" size="lg" className="mt-1 h-12 w-full" disabled={isPasswordBusy || !password.trim()}>
              {isPasswordBusy ? t('mobile.connect.connecting') : t('mobile.connect.unlockButton')}
            </Button>
            <Button type="button" variant="ghost" size="sm" className="w-full" onClick={cancelPasswordPrompt}>
              {t('mobile.connect.cancelPassword')}
            </Button>
          </form>
        </SettingsGroup>
      </div>
    );
  }

  return (
    <div className="oc-settings-page-content">
      <SettingsGroup
        label={t('mobile.connect.saved.title')}
        itemId="instances.manage"
      >
        {connections.length > 0 ? (
          connections.map((connection) => {
            const confirming = confirmingDeleteId === connection.id;
            const isActive = isActiveRuntimeConnection(connection);
            const isConnectingRow = connectingId === connection.id;
            // Status line: the active instance shows "Connected"; saved ones show
            // a generic "Saved" label — no transport/address detail.
            const statusText = isConnectingRow
              ? t('mobile.connect.connecting')
              : isActive
                ? t('mobile.instances.status.connected')
                : t('mobile.instances.status.saved');
            return (
              <div
                key={connection.id}
                className={cn(
                  'oc-settings-group-row relative flex items-center',
                  confirming && 'bg-[color-mix(in_srgb,var(--destructive)_8%,transparent)]',
                )}
              >
                {/* Full-card hit target so the whole row switches instances; action
                    buttons sit above with z-10 and keep their own clicks. */}
                <button
                  type="button"
                  aria-label={t('desktopHostSwitcher.actions.switchToAria', { instance: connection.label })}
                  data-mobile-press-feedback="none"
                  className="absolute inset-0 z-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary disabled:pointer-events-none"
                  onClick={() => {
                    if (isActive) return;
                    setConnectingId(connection.id);
                    void connect({ id: connection.id, candidates: connection.candidates, clientToken: connection.clientToken, label: connection.label })
                      .finally(() => setConnectingId(null));
                  }}
                  disabled={isActive || (isBusy && !isConnectingRow) || confirming}
                  style={{ touchAction: 'manipulation' }}
                />
                <div className="pointer-events-none relative z-[1] flex min-w-0 flex-1 items-center gap-3">
                  <span className="relative flex size-9 shrink-0 items-center justify-center rounded-[12px] bg-interactive-hover text-foreground">
                    <Icon name="server" className="size-[18px]" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="block truncate typography-ui-label text-foreground">{connection.label}</span>
                    </span>
                    <span className={cn(
                      'block truncate typography-small',
                      isActive && !isConnectingRow ? 'text-[var(--status-success)]' : 'text-muted-foreground',
                    )}>
                      {statusText}
                    </span>
                  </span>
                </div>
                <div className="relative z-10 flex shrink-0 items-center gap-0.5 pr-2">
                  {confirming ? (
                    <button
                      type="button"
                      aria-label={t('mobile.instances.confirmDeleteAria', { label: connection.label })}
                      className="flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-destructive px-3 text-destructive-foreground transition-opacity active:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive"
                      onClick={() => confirmDelete(connection.id)}
                      style={{ touchAction: 'manipulation' }}
                    >
                      <Icon name="delete-bin" className="size-[18px]" />
                      <span className="typography-ui-label">{t('mobile.instances.delete')}</span>
                    </button>
                  ) : isConnectingRow ? (
                    <span className="flex size-9 items-center justify-center text-muted-foreground" aria-hidden>
                      <Icon name="loader-4" className="size-[18px] animate-spin" />
                    </span>
                  ) : (
                    <button
                      type="button"
                      aria-label={t('mobile.instances.edit')}
                      className="flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors active:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                      onClick={() => {
                        setEditingId(connection.id);
                        setUrl(connection.candidates.some((c) => c.kind === 'direct') ? connectionDisplayUrl(connection) : '');
                        setLabel(connection.label);
                        setClientToken(connection.clientToken || '');
                        setError(null);
                      }}
                      style={{ touchAction: 'manipulation' }}
                    >
                      <Icon name="edit" className="size-[18px]" />
                    </button>
                  )}
                  <button
                    type="button"
                    aria-label={confirming
                      ? t('mobile.instances.cancelDeleteAria', { label: connection.label })
                      : t('mobile.instances.deleteAria', { label: connection.label })}
                    className="flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors active:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                    onClick={() => toggleConfirmDelete(connection.id)}
                    style={{ touchAction: 'manipulation' }}
                  >
                    <Icon name={confirming ? 'close' : 'delete-bin'} className="size-[18px]" />
                  </button>
                </div>
              </div>
            );
          })
        ) : (
          <div className="oc-settings-group-row flex items-center justify-center text-center typography-small text-muted-foreground">
            {t('mobile.connect.saved.empty')}
          </div>
        )}
      </SettingsGroup>

      {/* QR pairing is the primary path; the manual form stays hidden until
          asked for (or until a row's edit button opens it). */}
      <SettingsGroup
        label={editingConnection ? t('mobile.instances.editTitle') : t('mobile.instances.addTitle')}
      >
        {!formOpen && !editingConnection ? (
          <div className="oc-settings-group-row flex flex-col items-stretch gap-2">
              {qrScanSupported ? (
                <Button
                  type="button"
                  size="lg"
                  className="h-12 w-full"
                  onClick={() => void handleScanInstance()}
                  disabled={isScanning}
                >
                  <Icon name="scan-2" className={cn('size-[18px]', isScanning && 'animate-pulse')} />
                  {t('mobile.connect.scanQr')}
                </Button>
              ) : null}
              <Button
                type="button"
                variant={qrScanSupported ? 'ghost' : 'outline'}
                size="lg"
                className="h-12 w-full"
                onClick={() => { setError(null); setFormOpen(true); }}
              >
                <Icon name="add" className="size-[18px]" />
                {t('mobile.instances.addManual')}
              </Button>
              {error ? <p className="px-1 text-center typography-small text-[var(--status-error)]">{error}</p> : null}
          </div>
        ) : (
          <div className="oc-settings-group-row flex flex-col gap-3">
              <div className="flex min-h-8 items-center justify-end px-1">
                <Button type="button" variant="ghost" size="xs" onClick={resetForm}>
                  {t('mobile.instances.cancelEdit')}
                </Button>
              </div>
              <form className="flex flex-col gap-3" onSubmit={saveInstance}>
                {!isRelayOnlyEditing ? (
                  <label className="block space-y-1.5">
                    <span className="block px-1 typography-ui-label text-foreground">{t('mobile.connect.url.label')}</span>
                    <input
                      {...mobileInputKeyboardProps}
                      value={url}
                      onChange={(event) => setUrl(event.target.value)}
                      placeholder={t('mobile.connect.url.placeholder')}
                      type="url"
                      inputMode="url"
                      autoCapitalize="none"
                      className={inputClass}
                    />
                  </label>
                ) : null}
                <label className="block space-y-1.5">
                  <span className="block px-1 typography-ui-label text-foreground">{t('mobile.instances.label.label')}</span>
                  <input
                    value={label}
                    onChange={(event) => setLabel(event.target.value)}
                    placeholder={t('mobile.instances.label.placeholder')}
                    autoComplete="off"
                    autoCapitalize="words"
                    autoCorrect="off"
                    spellCheck={false}
                    className={inputClass}
                  />
                </label>
                <label className="block space-y-1.5">
                  <span className="block px-1 typography-ui-label text-foreground">{t('mobile.connect.token.label')}</span>
                  <input
                    {...mobileInputKeyboardProps}
                    value={clientToken}
                    onChange={(event) => setClientToken(event.target.value)}
                    placeholder={t('mobile.connect.token.placeholder')}
                    autoCapitalize="none"
                    className={inputClass}
                  />
                  <p className="px-1 typography-micro text-muted-foreground">{t('mobile.connect.token.hint')}</p>
                </label>
                <Button type="submit" size="lg" className="mt-1 h-12 w-full">
                  {editingConnection ? t('mobile.instances.saveEdit') : t('mobile.instances.saveNew')}
                </Button>
              </form>
              {/* Pairing link is available when adding (not while editing an existing row). */}
              {!editingConnection ? (
                <>
                  <MobileConnectionMethodDivider label={t('mobile.connect.link.divider')} />
                  <MobilePairingLinkForm
                    disabled={isBusy || isScanning}
                    isBusy={isBusy}
                    inputClassName={inputClass}
                    onRedeem={handlePairingLinkRedeem}
                    onInvalid={handlePairingLinkInvalid}
                  />
                </>
              ) : null}
              {error ? <p className="px-1 typography-small text-[var(--status-error)]">{error}</p> : null}
          </div>
        )}
      </SettingsGroup>
    </div>
  );
};

type MobileUsageLimitRow = {
  key: string;
  label: string;
  subtitle?: string;
  window: UsageWindow;
};

type MobileUsageProviderGroup = {
  providerId: QuotaProviderId;
  providerName: string;
  rows: MobileUsageLimitRow[];
  status: string | null;
};

const getWindowValueClass = (window: UsageWindow): string => {
  const usedPercent = window.usedPercent;
  if (typeof usedPercent !== 'number' || !Number.isFinite(usedPercent)) return 'text-foreground';
  if (usedPercent >= 80) return 'text-[var(--status-error)]';
  if (usedPercent >= 50) return 'text-[var(--status-warning)]';
  return 'text-foreground';
};

const MetadataRow: React.FC<{
  icon?: IconName;
  iconNode?: React.ReactNode;
  label: string;
  children: React.ReactNode;
}> = ({ icon, iconNode, label, children }) => (
  <div className="flex min-w-0 items-center gap-3 rounded-xl px-2.5 py-2.5">
    <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
      {iconNode ?? (icon ? <Icon name={icon} className="size-[18px]" /> : null)}
    </span>
    <span className="shrink-0 typography-ui-label text-muted-foreground">{label}</span>
    <span className="min-w-0 flex-1 truncate text-right typography-ui-label font-medium text-foreground">
      {children}
    </span>
  </div>
);

const SessionMetadataOverlay: React.FC<{
  open: boolean;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
  contextDisplay: MobileContextDisplay;
  branchLabel: string;
  usageGroups: MobileUsageProviderGroup[];
  usageDisplayMode: 'usage' | 'remaining';
  isUsageLoading: boolean;
  timeFormatPreference: TimeFormatPreference;
}> = ({ open, onClose, anchorRef, contextDisplay, branchLabel, usageGroups, usageDisplayMode, isUsageLoading, timeFormatPreference }) => {
  const { t } = useI18n();
  const panelRef = React.useRef<HTMLDivElement>(null);
  const [shouldRender, setShouldRender] = React.useState(open);
  const [isExiting, setIsExiting] = React.useState(false);
  // iPad: a phone-width sheet stretched across the whole chat column looks
  // broken — render a popover anchored to the metadata button instead.
  const isIPad = React.useMemo(() => isIPadApp(), []);
  const wrapperRef = React.useRef<HTMLDivElement>(null);
  const [ipadAnchorLeft, setIpadAnchorLeft] = React.useState<number | null>(null);

  // The shell has transformed ancestors, so the fixed wrapper's containing
  // block is the chat column, NOT the viewport. Anchor the popover in the
  // wrapper's own coordinate space — viewport-based lefts would double-count
  // the sidebar offset.
  React.useLayoutEffect(() => {
    if (!open || !isIPad || !shouldRender) return;
    const compute = () => {
      const anchorRect = anchorRef.current?.getBoundingClientRect();
      const wrapperRect = wrapperRef.current?.getBoundingClientRect();
      if (!anchorRect || !wrapperRect) {
        setIpadAnchorLeft(null);
        return;
      }
      const relativeLeft = anchorRect.left - wrapperRect.left;
      const left = Math.min(
        Math.max(relativeLeft, 8),
        Math.max(8, wrapperRect.width - IPAD_METADATA_POPOVER_WIDTH - 8),
      );
      setIpadAnchorLeft(left);
    };
    compute();
    // Re-anchor if the chat column shifts while the popover is open (sidebar
    // toggle/resize, orientation change) — the header buttons move with it.
    const wrapper = wrapperRef.current;
    if (typeof ResizeObserver === 'undefined' || !wrapper) return;
    const observer = new ResizeObserver(compute);
    observer.observe(wrapper);
    return () => observer.disconnect();
  }, [anchorRef, isIPad, open, shouldRender]);

  const ipadPopover = isIPad && ipadAnchorLeft !== null;

  React.useEffect(() => {
    if (open) {
      setShouldRender(true);
      setIsExiting(false);
      return;
    }

    if (!shouldRender) return;
    setIsExiting(true);
    const timeoutId = window.setTimeout(() => {
      setShouldRender(false);
      setIsExiting(false);
    }, 140);
    return () => window.clearTimeout(timeoutId);
  }, [open, shouldRender]);

  React.useEffect(() => {
    if (!open) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose, open]);

  React.useEffect(() => {
    if (!open) return;

    const closeIfOutside = (event: PointerEvent | WheelEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        onClose();
        return;
      }
      if (panelRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      onClose();
    };

    document.addEventListener('pointerdown', closeIfOutside, true);
    document.addEventListener('wheel', closeIfOutside, true);
    return () => {
      document.removeEventListener('pointerdown', closeIfOutside, true);
      document.removeEventListener('wheel', closeIfOutside, true);
    };
  }, [anchorRef, onClose, open]);

  if (!shouldRender) return null;

  return (
    <div ref={wrapperRef} className="fixed inset-x-0 bottom-0 top-[calc(var(--oc-safe-area-top,0px)+var(--oc-header-height,56px))] z-20 pointer-events-none">
      <div
        ref={panelRef}
        role="dialog"
        aria-label={t('mobile.header.openMetadataAria')}
        className={cn(
          'overflow-y-auto overscroll-contain rounded-[20px] oc-mobile-overlay-surface p-2 will-change-transform',
          ipadPopover ? 'absolute origin-top-left' : 'mx-3 mt-2',
          isExiting ? 'pointer-events-none' : 'pointer-events-auto',
        )}
        style={{
          animation: `${isExiting ? 'session-metadata-out' : 'session-metadata-in'} ${isExiting ? 140 : 170}ms cubic-bezier(0.32, 0.72, 0, 1) forwards`,
          maxHeight: 'min(72dvh, calc(100dvh - var(--oc-safe-area-top, 0px) - var(--oc-header-height, 56px) - 1rem))',
          ...(ipadPopover
            ? {
                top: 8,
                left: ipadAnchorLeft ?? 8,
                width: `min(${IPAD_METADATA_POPOVER_WIDTH}px, calc(100% - 16px))`,
              }
            : null),
        }}
      >
        <div className="space-y-1">
          <MetadataRow icon="git-branch" label={t('mobile.header.metadata.branch')}>
            {branchLabel}
          </MetadataRow>
          {contextDisplay ? (
            <MetadataRow
              iconNode={<ContextProgressIcon percentage={contextDisplay.percentage} />}
              label={t('mobile.header.metadata.context')}
            >
              <span className="inline-flex items-baseline gap-1.5 tabular-nums">
                <span className={cn('font-semibold', contextDisplay.colorClass)}>{contextDisplay.percentage.toFixed(1)}%</span>
                <span className="text-muted-foreground">{contextDisplay.tokens}</span>
              </span>
            </MetadataRow>
          ) : null}
          <MobileUsageLimits
            groups={usageGroups}
            displayMode={usageDisplayMode}
            isLoading={isUsageLoading}
            timeFormatPreference={timeFormatPreference}
          />
        </div>
      </div>
      <style>{`
        @keyframes session-metadata-in {
          from { opacity: 0; transform: translateY(-8px) scale(0.985); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes session-metadata-out {
          from { opacity: 1; transform: translateY(0) scale(1); }
          to { opacity: 0; transform: translateY(-6px) scale(0.985); }
        }
      `}</style>
    </div>
  );
};

const MobileUsageLimits: React.FC<{
  groups: MobileUsageProviderGroup[];
  displayMode: 'usage' | 'remaining';
  isLoading: boolean;
  timeFormatPreference: TimeFormatPreference;
}> = ({ groups, displayMode, isLoading, timeFormatPreference }) => {
  const { t } = useI18n();
  const modeLabel = displayMode === 'remaining' ? t('header.services.remaining') : t('header.services.used');

  if (groups.length === 0) return null;

  return (
    <div className="pt-2.5">
      <div className="flex min-w-0 items-center gap-3 px-2.5 pb-1.5">
        <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
          <Icon name="timer" className="size-[18px]" />
        </span>
        <span className="shrink-0 typography-ui-label text-muted-foreground">
          {t('mobile.header.metadata.usage')}
        </span>
        <span className="inline-flex min-w-0 flex-1 items-center justify-end gap-1.5 typography-ui-label text-muted-foreground">
          {isLoading ? <Icon name="refresh" className="size-3.5 animate-spin" /> : null}
          <span className="truncate">{modeLabel}</span>
        </span>
      </div>

      <div className="space-y-1.5">
        {groups.map((group) => (
          <div key={group.providerId} className="min-w-0 rounded-xl bg-[var(--surface-muted)] p-2.5">
            <div className="flex min-w-0 items-center gap-2">
              <ProviderLogo providerId={group.providerId} className="size-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate typography-ui-label font-medium text-foreground">
                {group.providerName}
              </span>
              {group.status && group.rows.length === 0 ? (
                <span className="shrink-0 truncate typography-micro text-muted-foreground">
                  {group.status}
                </span>
              ) : null}
            </div>
            {group.rows.length > 0 ? (
              <div className="mt-1.5 space-y-1">
                {group.rows.map((row) => {
                  const displayPercent = displayMode === 'remaining' ? row.window.remainingPercent : row.window.usedPercent;
                  const metricLabel = formatQuotaValueLabel(row.window.valueLabel, displayPercent);
                  const resetLabel = formatQuotaResetLabel(
                    row.window.resetAt,
                    row.window.resetAfterFormatted ?? row.window.resetAtFormatted,
                    timeFormatPreference,
                  );
                  return (
                    <div key={row.key} className="flex min-w-0 items-baseline justify-between gap-3">
                      <span className="inline-flex min-w-0 flex-1 items-baseline gap-1.5">
                        <span className="truncate typography-ui-label text-muted-foreground">
                          {row.subtitle ? `${row.subtitle} · ${row.label}` : row.label}
                        </span>
                        {resetLabel ? (
                          <span className="shrink-0 truncate typography-micro text-muted-foreground/70">{resetLabel}</span>
                        ) : null}
                      </span>
                      <span className={cn('shrink-0 typography-ui-label font-semibold tabular-nums', getWindowValueClass(row.window))}>
                        {metricLabel === '-' ? '' : metricLabel}
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : null}
            {group.status && group.rows.length > 0 ? (
              <div className="mt-1.5 typography-micro text-muted-foreground">{group.status}</div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
};

const MobileOverflowMenu: React.FC<{
  open: boolean;
  onClose: () => void;
  items: OverflowItem[];
  /** Extra viewport-right inset so the dropdown stays anchored to the
      three-dots button when the iPad right sidebar shifts the header. */
  rightOffset?: number;
}> = ({ open, onClose, items, rightOffset = 0 }) => {
  const { t } = useI18n();
  React.useEffect(() => {
    if (!open) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose, open]);

  if (!open) return null;

  // No second more-2 trigger here: the chat/detail header already owns the
  // floating glass button. A duplicate close glyph sits slightly off that
  // control (different safe-area/padding math) and reads as a double ghost.
  //
  // Backdrop starts BELOW the header chrome so the original more button stays
  // hittable. Phone shells use `isolation: isolate`, so raising header z-index
  // cannot escape above this fixed layer — leaving the header strip open is
  // what makes "tap again to close" work. Outside taps still dismiss.
  return (
    <div
      className="pointer-events-none fixed inset-0 z-50"
      role="dialog"
      aria-modal="true"
      aria-label={t('mobile.menu.titleAria')}
    >
      <button
        type="button"
        className="pointer-events-auto absolute inset-x-0 bottom-0 cursor-default top-[calc(var(--oc-safe-area-top,0px)+var(--oc-mobile-detail-navigation-height,3.5rem)+0.25rem)]"
        aria-label={t('mobile.surface.closeAria')}
        onPointerDown={(event) => {
          event.preventDefault();
          onClose();
        }}
      />
      <div
        id={MOBILE_OVERFLOW_MENU_ID}
        className="pointer-events-auto absolute top-[calc(var(--oc-safe-area-top,0px)+var(--oc-mobile-detail-navigation-height,3.5rem)+0.25rem)] w-[min(220px,calc(100vw-1rem))] origin-top-right overflow-hidden rounded-2xl oc-mobile-overlay-surface"
        role="menu"
        style={{
          right: `max(1rem, calc(8px + ${rightOffset}px + var(--oc-safe-area-right, 0px)))`,
          animation: 'mobile-menu-in 160ms cubic-bezier(0.32, 0.72, 0, 1) forwards',
        }}
        onAnimationEnd={(event) => {
          // Clear the transform after entry so backdrop-filter can sample content.
          event.currentTarget.style.transform = 'none';
        }}
      >
        {items.map((item, index) => (
          <button
            key={item.key}
            type="button"
            role="menuitem"
            className={cn(
              'flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset',
              index > 0 && 'border-t border-border/30',
              item.disabled && 'cursor-not-allowed opacity-60',
            )}
            style={{ touchAction: 'manipulation' }}
            disabled={item.disabled}
            onClick={() => {
              item.onSelect();
              onClose();
            }}
          >
            {item.iconNode ?? (item.icon ? <Icon name={item.icon} className={cn('size-5 shrink-0 text-muted-foreground', item.spinning && 'animate-spin')} /> : null)}
            <span className="min-w-0 flex-1 truncate typography-ui-label text-foreground">{item.label}</span>
            {item.badge && item.badge > 0 ? (
              <span className="inline-flex size-2 shrink-0 rounded-full bg-primary" aria-hidden />
            ) : null}
          </button>
        ))}
      </div>
      <style>{`@keyframes mobile-menu-in { from { opacity: 0; transform: translateY(-6px) scale(0.96); } to { opacity: 1; transform: translateY(0) scale(1); } }`}</style>
    </div>
  );
};

const MobileSessionMetadataButton = React.memo(function MobileSessionMetadataButton({
  open,
  onOpenChange,
  currentSessionId,
  effectiveDirectory,
  gitDirectory,
  isNewSessionDraftOpen,
  primaryLabel,
  secondaryLabel,
}: {
  open: boolean;
  onOpenChange: (open: boolean | ((open: boolean) => boolean)) => void;
  currentSessionId: string | null;
  effectiveDirectory: string | null;
  gitDirectory: string | null;
  isNewSessionDraftOpen: boolean;
  primaryLabel: string;
  secondaryLabel: string;
}) {
  const { t } = useI18n();
  const { git } = useRuntimeAPIs();
  const syncHint = useMobileTranscriptSyncHint(currentSessionId ?? '', effectiveDirectory || undefined);
  const statusLabel = syncHint ?? secondaryLabel;
  const metadataTriggerRef = React.useRef<HTMLButtonElement>(null);
  const activeSessionMessages = useSessionMessages(currentSessionId ?? '', effectiveDirectory || undefined);
  const isGitRepo = useIsGitRepo(gitDirectory);
  const gitStatus = useGitStatus(gitDirectory);
  const ensureStatus = useGitStore((state) => state.ensureStatus);
  const fetchStatus = useGitStore((state) => state.fetchStatus);
  const providers = useConfigStore((state) => state.providers);
  const currentProviderId = useConfigStore((state) => state.currentProviderId);
  const currentModelId = useConfigStore((state) => state.currentModelId);
  const getModelMetadata = useConfigStore((state) => state.getModelMetadata);
  const savedSessionModelSelector = React.useMemo(
    () => (state: ReturnType<typeof useSelectionStore.getState>) => (
      currentSessionId ? state.sessionModelSelections.get(currentSessionId) ?? null : null
    ),
    [currentSessionId],
  );
  const savedSessionModel = useSelectionStore(savedSessionModelSelector);
  const quotaResults = useQuotaStore((state) => state.results);
  const loadQuotaSettings = useQuotaStore((state) => state.loadSettings);
  const fetchAllQuotas = useQuotaStore((state) => state.fetchAllQuotas);
  const isQuotaLoading = useQuotaStore((state) => state.isLoading);
  const quotaDisplayMode = useQuotaStore((state) => state.displayMode);
  const dropdownProviderIds = useQuotaStore((state) => state.dropdownProviderIds);
  const selectedQuotaModels = useQuotaStore((state) => state.selectedModels);
  const timeFormatPreference = useUIStore((state) => state.timeFormatPreference);

  useQuotaAutoRefresh();

  React.useEffect(() => {
    if (!gitDirectory) return;
    void ensureStatus(gitDirectory, git);
  }, [ensureStatus, git, gitDirectory]);

  React.useEffect(() => {
    if (!gitDirectory) return;
    return sessionEvents.onGitRefreshHint((hint) => {
      if (normalizePath(hint.directory) !== gitDirectory) return;
      void fetchStatus(gitDirectory, git);
    });
  }, [fetchStatus, git, gitDirectory]);

  React.useEffect(() => {
    void loadQuotaSettings();
  }, [loadQuotaSettings]);

  React.useEffect(() => {
    preloadProviderLogos(dropdownProviderIds);
  }, [dropdownProviderIds]);

  React.useEffect(() => {
    if (!open || isQuotaLoading) return;
    const missingEnabledProvider = dropdownProviderIds.some((providerId) => (
      !quotaResults.some((result) => result.providerId === providerId)
    ));
    if (!missingEnabledProvider) return;
    void fetchAllQuotas();
  }, [dropdownProviderIds, fetchAllQuotas, isQuotaLoading, open, quotaResults]);

  const latestMessageModel = React.useMemo(
    () => getLatestUserMessageModel(activeSessionMessages),
    [activeSessionMessages],
  );

  const modelRef = latestMessageModel
    ?? (savedSessionModel ? { providerID: savedSessionModel.providerId, modelID: savedSessionModel.modelId } : null)
    ?? (currentProviderId && currentModelId ? { providerID: currentProviderId, modelID: currentModelId } : null);
  const provider = modelRef ? providers.find((entry) => entry.id === modelRef.providerID) : undefined;
  const liveModel = provider?.models.find((model) => model.id === modelRef?.modelID);
  const metadata = modelRef ? getModelMetadata(modelRef.providerID, modelRef.modelID) : undefined;
  const contextLimit = getNumericLimit((liveModel as { limit?: unknown } | undefined)?.limit, 'context')
    ?? metadata?.limit?.context
    ?? 0;
  const totalTokens = React.useMemo(
    () => getLatestAssistantTotalTokens(activeSessionMessages),
    [activeSessionMessages],
  );

  const contextDisplay = buildMobileContextDisplay({
    totalTokens,
    contextLimit,
    isDraft: isNewSessionDraftOpen,
  });

  const branchLabel = isGitRepo === true
    ? (gitStatus?.current?.trim() || t('gitView.branch.detachedHead'))
    : t('common.unavailable');

  const usageGroups = React.useMemo<MobileUsageProviderGroup[]>(() => {
    const resultsByProvider = new Map(quotaResults.map((result) => [result.providerId, result]));
    return QUOTA_PROVIDERS
      .filter((providerMeta) => dropdownProviderIds.includes(providerMeta.id))
      .filter((providerMeta) => resultsByProvider.get(providerMeta.id)?.configured === true)
      .map((providerMeta) => {
        const result = resultsByProvider.get(providerMeta.id)!;
        const rows: MobileUsageLimitRow[] = [];

        for (const [label, window] of Object.entries(result?.usage?.windows ?? {})) {
          rows.push({
            key: `window-${label}`,
            label: formatWindowLabel(label),
            window,
          });
        }

        const modelEntries = Object.entries(result?.usage?.models ?? {});
        const providerSelectedModels = selectedQuotaModels[providerMeta.id] ?? [];
        const visibleModelEntries = providerSelectedModels.length > 0
          ? modelEntries.filter(([modelName]) => providerSelectedModels.includes(modelName))
          : modelEntries;
        for (const [modelName, modelUsage] of visibleModelEntries) {
          const entries = Object.entries(modelUsage.windows ?? {});
          if (entries.length === 0) continue;
          const [label, window] = entries[0];
          rows.push({
            key: `model-${modelName}-${label}`,
            label: formatWindowLabel(label),
            subtitle: getDisplayModelName(modelName),
            window,
          });
        }

        const status = !result.ok && result.error
          ? result.error
          : rows.length === 0
            ? t('header.services.noRateLimitsReported')
            : null;

        return {
          providerId: providerMeta.id,
          providerName: providerMeta.name,
          rows,
          status,
        };
      });
  }, [dropdownProviderIds, quotaResults, selectedQuotaModels, t]);

  React.useEffect(() => {
    if (!open || usageGroups.length === 0) return;
    preloadProviderLogos(usageGroups.map((group) => group.providerId));
  }, [open, usageGroups]);

  return (
    <>
      <div className="flex min-w-0 flex-1 items-center px-2 py-1.5 text-left">
        <span className="flex min-w-0 flex-1 flex-col leading-tight">
          <span className="block truncate typography-ui-label text-foreground">{primaryLabel}</span>
          {statusLabel ? (
            <span
              className={cn(
                'block truncate',
                syncHint ? 'oc-mobile-detail-subtitle text-muted-foreground' : 'typography-micro text-muted-foreground',
              )}
              aria-live="polite"
            >
              {statusLabel}
            </span>
          ) : null}
        </span>
      </div>
      <button
        ref={metadataTriggerRef}
        type="button"
        className="flex size-10 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        aria-label={t('mobile.header.openMetadataAria')}
        aria-expanded={open}
        onClick={() => onOpenChange((currentOpen) => !currentOpen)}
        style={{ touchAction: 'manipulation' }}
      >
        <ContextProgressIcon percentage={contextDisplay?.percentage ?? 0} />
      </button>
      <SessionMetadataOverlay
        open={open}
        onClose={() => onOpenChange(false)}
        anchorRef={metadataTriggerRef}
        contextDisplay={contextDisplay}
        branchLabel={branchLabel}
        usageGroups={usageGroups}
        usageDisplayMode={quotaDisplayMode}
        isUsageLoading={isQuotaLoading}
        timeFormatPreference={timeFormatPreference}
      />
    </>
  );
});

type MobileHeaderSurfaceShortcuts = {
  activePanel: 'files' | 'changes' | null;
  changesDirty: boolean;
  onToggleFiles: () => void;
  onToggleChanges: () => void;
};

const MobileHeader: React.FC<{
  onOpenSessions: () => void;
  menuOpen: boolean;
  onToggleMenu: () => void;
  /** iPad only: Files/Changes header shortcuts that toggle the right sidebar. */
  surfaceShortcuts?: MobileHeaderSurfaceShortcuts;
}> = ({ onOpenSessions, menuOpen, onToggleMenu, surfaceShortcuts }) => {
  const { t } = useI18n();
  const [metadataOpen, setMetadataOpen] = React.useState(false);
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const currentSessionDirectorySelector = React.useMemo(
    () => (state: ReturnType<typeof useSessionUIStore.getState>) => (
      currentSessionId ? state.getDirectoryForSession(currentSessionId) : null
    ),
    [currentSessionId],
  );
  const currentSessionDirectory = useSessionUIStore(currentSessionDirectorySelector);
  const effectiveDirectory = currentSessionDirectory || currentDirectory;
  const gitDirectory = normalizePath(effectiveDirectory) || null;
  const projects = useProjectsStore((state) => state.projects);
  const availableWorktreesByProject = useSessionUIStore((state) => state.availableWorktreesByProject);
  const currentWorktreeMetadataSelector = React.useMemo(
    () => (state: ReturnType<typeof useSessionUIStore.getState>) => (
      currentSessionId ? state.worktreeMetadata.get(currentSessionId) ?? null : null
    ),
    [currentSessionId],
  );
  const currentWorktreeMetadata = useSessionUIStore(currentWorktreeMetadataSelector);
  const currentSession = useCurrentSessionEntity(currentSessionId);
  const isNewSessionDraftOpen = useSessionUIStore((state) => Boolean(state.newSessionDraft?.open));

  const projectLabel = React.useMemo(() => {
    const directory = normalizePath(effectiveDirectory);
    if (!directory) return t('mobile.header.noProject');
    const metadataProject = currentWorktreeMetadata?.projectDirectory
      ? resolveProjectForDirectory(projects, currentWorktreeMetadata.projectDirectory)
      : null;
    const project = metadataProject ?? resolveProjectForSessionDirectory(projects, availableWorktreesByProject, directory);
    return getProjectDisplayLabel(project, directory) || t('mobile.header.noProject');
  }, [availableWorktreesByProject, currentWorktreeMetadata?.projectDirectory, effectiveDirectory, projects, t]);

  const sessionTitle = currentSession?.title?.trim();
  const primaryLabel = sessionTitle || (currentSessionId ? t('mobile.sessions.untitled') : projectLabel);
  const secondaryLabel = currentSessionId ? projectLabel : '';

  React.useEffect(() => {
    setMetadataOpen(false);
  }, [currentSessionId, effectiveDirectory]);

  const handleOpenSessions = useEvent(() => {
    setMetadataOpen(false);
    onOpenSessions();
  });

  const handleToggleMenu = useEvent(() => {
    setMetadataOpen(false);
    onToggleMenu();
  });

  return (
    <>
      <MobileSurfaceHeader>
          <button
            type="button"
            className="flex size-10 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            aria-label={t('mobile.sessions.openSheetAria')}
            onClick={handleOpenSessions}
            style={{ touchAction: 'manipulation' }}
          >
            <Icon name="folders" className="size-5" />
          </button>

          <MobileSessionMetadataButton
            open={metadataOpen}
            onOpenChange={setMetadataOpen}
            currentSessionId={currentSessionId}
            effectiveDirectory={effectiveDirectory}
            gitDirectory={gitDirectory}
            isNewSessionDraftOpen={isNewSessionDraftOpen}
            primaryLabel={primaryLabel}
            secondaryLabel={secondaryLabel}
          />

          {surfaceShortcuts ? (
            <>
              <button
                type="button"
                className={cn(
                  'flex size-10 shrink-0 items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                  surfaceShortcuts.activePanel === 'files'
                    ? 'bg-[var(--interactive-selection)] text-[var(--interactive-selectionForeground)]'
                    : 'text-muted-foreground hover:bg-interactive-hover hover:text-foreground',
                )}
                aria-label={t('mobile.menu.files')}
                aria-pressed={surfaceShortcuts.activePanel === 'files'}
                onClick={surfaceShortcuts.onToggleFiles}
                style={{ touchAction: 'manipulation' }}
              >
                <Icon name="file-text" className="size-5" />
              </button>
              <button
                type="button"
                className={cn(
                  'relative flex size-10 shrink-0 items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                  surfaceShortcuts.activePanel === 'changes'
                    ? 'bg-[var(--interactive-selection)] text-[var(--interactive-selectionForeground)]'
                    : 'text-muted-foreground hover:bg-interactive-hover hover:text-foreground',
                )}
                aria-label={t('mobile.menu.changes')}
                aria-pressed={surfaceShortcuts.activePanel === 'changes'}
                onClick={surfaceShortcuts.onToggleChanges}
                style={{ touchAction: 'manipulation' }}
              >
                <Icon name="git-branch" className="size-5" />
                {surfaceShortcuts.changesDirty ? (
                  <span className="absolute right-2 top-2 inline-flex size-2 rounded-full bg-primary" aria-hidden />
                ) : null}
              </button>
            </>
          ) : null}

          <button
            type="button"
            className="flex size-10 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            aria-label={t('mobile.header.openMenuAria')}
            aria-controls={MOBILE_OVERFLOW_MENU_ID}
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            onClick={handleToggleMenu}
            style={{ touchAction: 'manipulation' }}
          >
            <Icon name="more-2" className="size-5" />
          </button>
      </MobileSurfaceHeader>
    </>
  );
};

type PendingMobileChangesDiff = {
  path: string;
  staged: boolean;
  targetLine?: number;
  toolPatches?: ReadonlyArray<{ path: string; patch: string }>;
};

type PendingMobileFilePreview = {
  path: string;
  targetLine?: number;
};

const MobileShell: React.FC<{
  connection: UseMobileConnection;
  onActiveConnectionDeleted: () => void;
}> = ({ connection, onActiveConnectionDeleted }) => {
  const { t } = useI18n();
  const sync = useSync();
  useStreamingHaptics();
  useMobilePressHaptics();
  const mobileSessionPanelOpen = useUIStore((state) => state.mobileSessionPanelOpen);
  const setMobileSessionPanelOpen = useUIStore((state) => state.setMobileSessionPanelOpen);
  const scheduledTasksDialogOpen = useUIStore((state) => state.isScheduledTasksDialogOpen);
  const activeMainTab = useUIStore((state) => state.activeMainTab);
  const assistantCapability = useAssistantCapabilityQuery();
  const setActiveMainTab = useUIStore((state) => state.setActiveMainTab);
  const [filesOpen, setFilesOpen] = React.useState(false);
  const [filePreviewOpen, setFilePreviewOpen] = React.useState(false);
  const [pendingFilePreview, setPendingFilePreview] = React.useState<PendingMobileFilePreview | null>(null);
  const [changesOpen, setChangesOpen] = React.useState(false);
  const [turnDiffOpen, setTurnDiffOpen] = React.useState(false);
  const [turnDiffMessageId, setTurnDiffMessageId] = React.useState<string | null>(null);
  // Owning session for the turn-diff sheet; null = primary chat session.
  const [turnDiffSessionId, setTurnDiffSessionId] = React.useState<string | null>(null);
  /** Optional file to expand/scroll when the turn-diff sheet opens (from Changes preview row). */
  const [turnDiffTargetFilePath, setTurnDiffTargetFilePath] = React.useState<string | null>(null);
  const [turnDiffNavigationKey, setTurnDiffNavigationKey] = React.useState(0);
  const [mcpOpen, setMcpOpen] = React.useState(false);
  const [isMcpRefreshing, setIsMcpRefreshing] = React.useState(false);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [updateOpen, setUpdateOpen] = React.useState(false);
  const [directoryDialogOpen, setDirectoryDialogOpen] = React.useState(false);
  const [isHomeQrScanning, setIsHomeQrScanning] = React.useState(false);
  const [settingsInitialMobileStage, setSettingsInitialMobileStage] = React.useState<'nav' | 'page-content'>('nav');
  const [overflowOpen, setOverflowOpen] = React.useState(false);
  const [isTranscriptRefreshing, setIsTranscriptRefreshing] = React.useState(false);
  const toggleOverflowMenu = useEvent(() => setOverflowOpen((open) => !open));
  const closeOverflowMenu = useEvent(() => setOverflowOpen(false));
  // When set, the Changes surface opens directly into the per-file diff for this path.
  const [pendingChangesDiff, setPendingChangesDiff] = React.useState<PendingMobileChangesDiff | null>(null);
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const setSettingsPage = useUIStore((state) => state.setSettingsPage);
  const updateAvailable = useUpdateStore((state) => state.available);
  const updateRuntimeType = useUpdateStore((state) => state.runtimeType);
  const showCapacitorOnlyFeatures = React.useMemo(() => isCapacitorMobileApp(), []);
  const qrScanSupported = React.useMemo(() => isQrScanSupported(), []);
  const { data: mcpServers = [], refetch: refetchMcpConfigs } = useMcpConfigsQuery(currentDirectory ?? null, { enabled: mcpOpen });
  const { refetch: refetchMcpStatus } = useMcpStatusQuery(currentDirectory ?? null, { enabled: mcpOpen });
  const setMcpDraft = useMcpConfigStore((state) => state.setMcpDraft);
  const setSelectedMcp = useMcpConfigStore((state) => state.setSelectedMcp);
  const gitStatus = useGitStatus(normalizePath(currentDirectory) || null);
  const dirtyChangeCount = gitStatus?.files?.length ?? 0;

  React.useEffect(() => sessionEvents.onDirectoryRequest(() => setDirectoryDialogOpen(true)), []);

  // iPad (Capacitor): sessions live in a persistent full-height left sidebar
  // and Changes/Files in a right sidebar, instead of phone sheets/surfaces.
  const isIPad = React.useMemo(() => isIPadApp(), []);
  const orientation = useOrientation();
  const isPortrait = orientation === 'portrait';
  const [ipadSidebarOpen, setIpadSidebarOpen] = React.useState(isIPad && !isPortrait);
  const [ipadRightPanel, setIpadRightPanel] = React.useState<'files' | 'changes' | 'turn-diff' | null>(null);
  // Phone: Settings is a root tab. iPad keeps the half-sheet Settings surface.
  const openSettingsSurface = useEvent((section?: string) => {
    if (section) {
      setSettingsPage(section as Parameters<typeof setSettingsPage>[0]);
    }
    if (isIPad) {
      setSettingsInitialMobileStage(section ? 'page-content' : 'nav');
      setSettingsOpen(true);
      return;
    }
    useMobileNavigationStore.getState().setActiveTab('settings');
  });

  const openInstancesSettingsPage = useEvent(() => {
    openSettingsSurface('instances');
  });

  const openInstancesSecondary = useEvent(() => {
    useMobileNavigationStore.getState().openInstances();
  });

  const closeInstancesSecondary = useEvent(() => {
    useMobileNavigationStore.getState().closeSecondary();
  });

  // Home-menu scan is a global Capacitor capability: open the native scanner
  // without pushing the instances secondary page, then stay on / return to home.
  const scanConnectionFromHome = useEvent(async () => {
    if (isHomeQrScanning) return;
    setIsHomeQrScanning(true);
    try {
      const result = await scanConnectionQr();
      switch (result.status) {
        case 'ok':
          await connection.connect({
            url: result.url,
            clientToken: result.clientToken,
            label: result.label,
          });
          break;
        case 'pairing':
          await connection.redeemPairingConnection(result.pairing);
          break;
        case 'permission-denied':
          toast.error(t('mobile.connect.scan.permissionDenied'));
          break;
        case 'invalid':
          toast.error(t('mobile.connect.scan.invalid'));
          break;
        case 'unsupported':
          toast.error(t('mobile.connect.scan.unsupported'));
          break;
        case 'failed':
          toast.error(t('mobile.connect.scan.failed'));
          break;
        case 'cancelled':
        default:
          break;
      }
    } finally {
      setIsHomeQrScanning(false);
    }
  });

  const rootBackRoutesBlocked = mobileSessionPanelOpen
    || filesOpen
    || filePreviewOpen
    || changesOpen
    || turnDiffOpen
    || scheduledTasksDialogOpen
    || mcpOpen
    || settingsOpen
    || updateOpen
    || directoryDialogOpen
    || overflowOpen;
  useMobileNavigationDriver({
    enabled: !isIPad,
    rootRoutesBlocked: rootBackRoutesBlocked,
  });

  const toggleIpadSidebar = useEvent(() => {
    const willOpen = !ipadSidebarOpen;
    // Portrait doesn't fit both side panels next to a usable chat column:
    // opening one closes the other (iPadOS behaves the same way).
    if (willOpen && isPortrait) setIpadRightPanel(null);
    setIpadSidebarOpen(willOpen);
  });

  const openFilesSurface = useEvent(() => {
    setTurnDiffOpen(false);
    setTurnDiffMessageId(null);
    setTurnDiffSessionId(null);
    setFilePreviewOpen(false);
    setPendingFilePreview(null);
    if (isIPad) {
      setPendingChangesDiff(null);
      setIpadRightPanel('files');
      if (isPortrait) setIpadSidebarOpen(false);
      return;
    }
    setFilesOpen(true);
  });

  const closeFilePreview = useEvent(() => {
    setFilePreviewOpen(false);
    setPendingFilePreview(null);
  });

  /**
   * Read/Skill (and other direct file opens): phone uses the same gesture
   * resizable sheet as Edit diffs; iPad keeps the right Files panel + pending focus.
   */
  const openFileSurface = useEvent((preview: PendingMobileFilePreview) => {
    const path = preview.path.trim();
    if (!path) return;

    setTurnDiffOpen(false);
    setTurnDiffMessageId(null);
    setTurnDiffSessionId(null);
    setPendingChangesDiff(null);
    setChangesOpen(false);

    if (isIPad) {
      useUIStore.getState().setPendingFileFocusPath(path);
      setIpadRightPanel('files');
      if (isPortrait) setIpadSidebarOpen(false);
      return;
    }

    setFilesOpen(false);
    setPendingFilePreview({
      path,
      targetLine: typeof preview.targetLine === 'number' && Number.isFinite(preview.targetLine)
        ? Math.max(1, Math.trunc(preview.targetLine))
        : undefined,
    });
    setFilePreviewOpen(true);
  });

  // When a file-reference link inside chat markdown triggers
  // uiStore.openContextFile(...), the pending focus path is set even while
  // the Files surface is closed. Prefer the gesture file preview sheet on
  // phone; iPad still opens the right Files panel.
  const pendingFileFocusPath = useUIStore((state) => state.pendingFileFocusPath);
  React.useEffect(() => {
    if (!pendingFileFocusPath) {
      return;
    }
    if (isIPad) {
      openFilesSurface();
      return;
    }
    // openFileSurface clears the host path via Files surface consumption when
    // using openContextFile; for direct focus paths, open the gesture sheet
    // and clear the pending store entry so we do not re-open after dismiss.
    openFileSurface({ path: pendingFileFocusPath });
    useUIStore.getState().setPendingFileFocusPath(null);
  }, [pendingFileFocusPath, isIPad, openFilesSurface, openFileSurface]);

  const openChangesSurface = useEvent((diff: PendingMobileChangesDiff | null = null) => {
    setTurnDiffOpen(false);
    setTurnDiffMessageId(null);
    setTurnDiffSessionId(null);
    setTurnDiffTargetFilePath(null);
    setFilePreviewOpen(false);
    setPendingFilePreview(null);
    setPendingChangesDiff(diff);
    if (isIPad) {
      setIpadRightPanel('changes');
      if (isPortrait) setIpadSidebarOpen(false);
      return;
    }
    setChangesOpen(true);
  });

  const openTurnDiffSurface = useEvent((
    messageId?: string,
    sessionId?: string | null,
    filePath?: string | null,
  ) => {
    setPendingChangesDiff(null);
    setChangesOpen(false);
    setFilePreviewOpen(false);
    setPendingFilePreview(null);
    setTurnDiffMessageId(messageId ?? null);
    setTurnDiffSessionId(typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : null);
    const normalizedFile = typeof filePath === 'string' && filePath.trim() ? filePath.trim() : null;
    setTurnDiffTargetFilePath(normalizedFile);
    setTurnDiffNavigationKey((key) => key + 1);
    if (isIPad) {
      setIpadRightPanel('turn-diff');
      if (isPortrait) setIpadSidebarOpen(false);
      return;
    }
    setTurnDiffOpen(true);
  });

  const closeIpadRightPanel = useEvent(() => {
    setIpadRightPanel(null);
    setPendingChangesDiff(null);
    setTurnDiffTargetFilePath(null);
  });

  const toggleIpadRightPanel = useEvent((panel: 'files' | 'changes') => {
    if (ipadRightPanel === panel) {
      closeIpadRightPanel();
      return;
    }
    if (panel === 'files') openFilesSurface();
    else openChangesSurface();
  });

  // Keep the right panel's content mounted through the width-collapse
  // animation; drop it once the panel is fully closed.
  const lastIpadRightPanelRef = React.useRef<'files' | 'changes' | 'turn-diff'>('changes');
  if (ipadRightPanel) lastIpadRightPanelRef.current = ipadRightPanel;
  const [ipadRightContentMounted, setIpadRightContentMounted] = React.useState(false);
  React.useEffect(() => {
    if (!isIPad) return;
    if (ipadRightPanel) {
      setIpadRightContentMounted(true);
      return;
    }
    const id = window.setTimeout(() => setIpadRightContentMounted(false), 240);
    return () => window.clearTimeout(id);
  }, [ipadRightPanel, isIPad]);
  const renderedIpadRightPanel = ipadRightPanel ?? lastIpadRightPanelRef.current;

  const leftResize = useIpadSidebarResize('left', 'openchamber.ipad.leftSidebarWidth', IPAD_LEFT_SIDEBAR_WIDTH);
  const rightResize = useIpadSidebarResize('right', 'openchamber.ipad.rightSidebarWidth', IPAD_RIGHT_SIDEBAR_WIDTH);

  const mobileActions = React.useMemo<MobileAppActions>(
    () => ({
      openChanges: ({ diffPath, staged, targetLine } = {}) => {
        openChangesSurface(diffPath ? { path: diffPath, staged: staged === true, targetLine } : null);
      },
      openToolDiff: ({ diffPath, patches, targetLine }) => {
        openChangesSurface({ path: diffPath, staged: false, targetLine, toolPatches: patches });
      },
      openTurnDiff: openTurnDiffSurface,
      openFile: ({ path, targetLine }) => {
        openFileSurface({ path, targetLine });
      },
      openFiles: () => openFilesSurface(),
      openSettings: (section?: string) => {
        openSettingsSurface(section);
      },
    }),
    [openChangesSurface, openFileSurface, openFilesSurface, openSettingsSurface, openTurnDiffSurface],
  );

  const closeChanges = useEvent(() => {
    setChangesOpen(false);
    setPendingChangesDiff(null);
  });

  const closeTurnDiff = useEvent(() => {
    setTurnDiffOpen(false);
    setTurnDiffTargetFilePath(null);
  });

  // Expose the shell's panel-opening actions to the deep-link layer so openchamber:// URLs
  // (and notification taps / widgets) can navigate to these surfaces. Session and
  // new-session intents resolve directly against the store, so they aren't wired here.
  const deepLinkHandlers = React.useMemo(
    () => ({
      openSessions: () => {
        if (isIPad) {
          setIpadSidebarOpen(true);
          return;
        }
        useMobileNavigationStore.getState().setActiveTab('projects');
      },
      openView: (target: 'files' | 'mcp' | 'instances' | 'update') => {
        if (target === 'files') openFilesSurface();
        else if (target === 'mcp') setMcpOpen(true);
        else if (target === 'instances') openInstancesSettingsPage();
        else if (target === 'update') setUpdateOpen(true);
      },
      openChanges: ({ path, staged }: { path?: string; staged?: boolean } = {}) => {
        openChangesSurface(path ? { path, staged: staged === true } : null);
      },
      openSettings: (section?: string) => {
        openSettingsSurface(section);
      },
    }),
    [isIPad, openChangesSurface, openFilesSurface, openInstancesSettingsPage, openSettingsSurface],
  );
  useDeepLinkHandlers(deepLinkHandlers);

  // Horizontal swipes beginning on the explicitly marked Composer surface
  // switch to the previous or next Session. Transcript gestures are owned by
  // page-back and the Session List presentation below.
  const phoneSecondaryBackRef = React.useRef<(() => boolean) | null>(null);
  const chatMainRef = React.useRef<HTMLElement>(null);
  const chatAnimRef = React.useRef<HTMLDivElement>(null);
  const previousSessionHolderRef = React.useRef<HTMLDivElement>(null);
  const nextSessionHolderRef = React.useRef<HTMLDivElement>(null);
  const swipeDirectionRef = React.useRef<'prev' | 'next' | null>(null);
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const setCurrentSession = useSessionUIStore((state) => state.setCurrentSession);
  const currentSessionDirectorySelector = React.useMemo(
    () => (state: ReturnType<typeof useSessionUIStore.getState>) => (
      currentSessionId ? state.getDirectoryForSession(currentSessionId) : null
    ),
    [currentSessionId],
  );
  const currentSessionDirectory = useSessionUIStore(currentSessionDirectorySelector);
  const parentSessionTarget = useParentSessionTarget(currentSessionId, currentSessionDirectory || currentDirectory || undefined);
  const currentSessionStatus = useLiveSessionStatus(currentSessionId ?? '');
  useNativeLiveActivity();
  const isSessionBusy = currentSessionStatus?.type === 'busy' || currentSessionStatus?.type === 'retry';
  const refreshCurrentTranscript = useEvent(() => {
    const sessionID = currentSessionId;
    if (!sessionID || isTranscriptRefreshing || isSessionBusy) return;
    const directory = currentSessionDirectory || currentDirectory || undefined;

    setIsTranscriptRefreshing(true);
    void (async () => {
      try {
        await sync.refreshSessionTranscript(sessionID, { directory });
        toast.success(t('sessions.sidebar.session.menu.refreshTranscriptSuccess'));
      } catch {
        toast.error(t('sessions.sidebar.session.menu.refreshTranscriptFailed'));
      } finally {
        setIsTranscriptRefreshing(false);
      }
    })();
  });

  // Record the swipe direction; the animation itself runs in the layout effect below, once the
  // new session's content has committed — running it inline in the swipe callback raced the
  // re-render and dropped the animation on roughly every other switch.
  const recordSwipeDirection = useEvent((direction: 'prev' | 'next') => {
    swipeDirectionRef.current = direction;
  });
  const renderSwipeProgress = useEvent((progress: SwipeProgress | null) => {
    const chat = chatAnimRef.current;
    const previous = previousSessionHolderRef.current;
    const next = nextSessionHolderRef.current;
    if (!chat) return;

    if (!progress) {
      chat.style.transform = '';
      chat.style.opacity = '';
      chat.style.willChange = '';
      if (previous) {
        previous.style.transform = '';
        previous.style.willChange = '';
      }
      if (next) {
        next.style.transform = '';
        next.style.willChange = '';
      }
      return;
    }

    if (!chat.style.willChange) {
      chat.getAnimations().forEach((animation) => animation.cancel());
    }
    chat.style.willChange = 'transform, opacity';
    chat.style.transform = `translate3d(${progress.offsetX}px, 0, 0)`;
    chat.style.opacity = String(1 - progress.progress * 0.08);
    if (previous) {
      previous.style.willChange = 'transform';
      previous.style.transform = `translate3d(${progress.offsetX}px, 0, 0)`;
    }
    if (next) {
      next.style.willChange = 'transform';
      next.style.transform = `translate3d(${progress.offsetX}px, 0, 0)`;
    }
    const visibleHolder = progress.direction === 'prev' ? previous : next;
    if (!visibleHolder) return;
    Array.from(visibleHolder.children).forEach((child) => {
      if (child instanceof HTMLElement) child.style.opacity = progress.canSwitch ? '1' : '0.35';
    });
  });
  // Re-bind when the chat subtree mounts: on phone it only exists while the
  // secondary page is open; on iPad it is always mounted.
  const phoneSecondaryKind = useMobileNavigationStore((state) => state.secondary?.kind ?? null);
  const phoneChatMounted = !isIPad && (phoneSecondaryKind === 'chat' || phoneSecondaryKind === 'draft');
  // Overflow menu is anchored to the chat/detail header. Leaving that page or
  // switching sessions must dismiss it so it cannot float over another surface.
  React.useEffect(() => {
    if (!isIPad && !phoneChatMounted) {
      setOverflowOpen(false);
    }
  }, [isIPad, phoneChatMounted]);
  React.useEffect(() => {
    setOverflowOpen(false);
  }, [currentSessionId]);
  useEdgeSwipeSessionSwitch(chatMainRef, {
    onSwitch: recordSwipeDirection,
    onProgress: renderSwipeProgress,
  }, isIPad || phoneChatMounted);

  // A right-to-left swipe across the chat body opens the Session List
  // half-sheet. The opposite direction remains unclaimed for page-back.
  // Disabled when no phone Session chat is mounted or another overlay is open.
  const headerSwipeDisabled = (isIPad && activeMainTab === 'assistant')
    || (!isIPad && !phoneChatMounted)
    || mobileSessionPanelOpen
    || filesOpen
    || filePreviewOpen
    || changesOpen
    || turnDiffOpen
    || scheduledTasksDialogOpen
    || mcpOpen
    || settingsOpen
    || updateOpen
    || directoryDialogOpen
    || overflowOpen;
  const handleHeaderSwipeOpen = useEvent(() => {
    getMobileWindowMotionController(MOBILE_SESSIONS_WINDOW_ID)?.finish('commit');
  });
  const handleHeaderSwipePreviewStart = useEvent(() => {
    getMobileWindowMotionController(MOBILE_SESSIONS_WINDOW_ID)?.begin('present');
  });
  const handleHeaderSwipePreviewCancel = useEvent(() => {
    getMobileWindowMotionController(MOBILE_SESSIONS_WINDOW_ID)?.finish('cancel');
  });
  const renderHeaderSwipeProgress = useEvent((progress: number | null) => {
    if (progress !== null) getMobileWindowMotionController(MOBILE_SESSIONS_WINDOW_ID)?.update(progress);
  });
  useHeaderSwipeToSessions(chatMainRef, {
    onOpen: handleHeaderSwipeOpen,
    onPreviewStart: handleHeaderSwipePreviewStart,
    onPreviewCancel: handleHeaderSwipePreviewCancel,
    onProgress: renderHeaderSwipeProgress,
    disabled: headerSwipeDisabled,
  }, isIPad || phoneChatMounted);

  React.useLayoutEffect(() => {
    const direction = swipeDirectionRef.current;
    swipeDirectionRef.current = null;
    if (!direction) return; // only animate swipe-driven switches
    const element = chatAnimRef.current;
    if (!element || typeof element.animate !== 'function') return;
    element.getAnimations().forEach((animation) => animation.cancel());
    const fromX = direction === 'prev' ? -70 : 70;
    element.animate(
      [
        { opacity: 0.1, transform: `translateX(${fromX}px)` },
        { opacity: 1, transform: 'translateX(0)' },
      ],
      { duration: 300, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
    );
  }, [currentSessionId]);

  // Phone chat secondary page: MobilePhoneShell registers a handler that
  // closes the chat page before the app would minimize. Ref indirection keeps
  // the registration stable across MobilePhoneShell remounts.
  const registerPhoneSecondaryBack = useEvent((handler: (() => boolean) | null) => {
    phoneSecondaryBackRef.current = handler;
  });

  const handleNativeBack = useEvent(() => {
    if (overflowOpen) {
      setOverflowOpen(false);
      return true;
    }
    if (directoryDialogOpen) {
      setDirectoryDialogOpen(false);
      return true;
    }
    if (scheduledTasksDialogOpen) {
      window.dispatchEvent(new Event('oc:scheduled-tasks-close-request'));
      return true;
    }
    if (mobileSessionPanelOpen) {
      setMobileSessionPanelOpen(false);
      return true;
    }
    // Push-style details inside modal surfaces pop before their owning modal.
    if (mobileBackNavigationCoordinator.backImmediately('overlay')) {
      return true;
    }
    if (filePreviewOpen) {
      closeFilePreview();
      return true;
    }
    if (filesOpen) {
      setFilesOpen(false);
      return true;
    }
    if (turnDiffOpen) {
      closeTurnDiff();
      return true;
    }
    if (changesOpen) {
      closeChanges();
      return true;
    }
    if (mcpOpen) {
      setMcpOpen(false);
      return true;
    }
    if (settingsOpen) {
      setSettingsOpen(false);
      return true;
    }
    if (updateOpen) {
      setUpdateOpen(false);
      return true;
    }
    if (mobileBackNavigationCoordinator.requestAnimatedBack('root')) {
      return true;
    }
    // Phone chat secondary page closes before the app would minimize or
    // switch back to the root tab shell.
    if (phoneSecondaryBackRef.current?.()) {
      return true;
    }
    if (activeMainTab === 'assistant') {
      setActiveMainTab('chat');
      return true;
    }
    if (parentSessionTarget) {
      setCurrentSession(parentSessionTarget.id, parentSessionTarget.directory);
      return true;
    }
    return false;
  });

  useNativeAndroidBackButton(handleNativeBack);

  const showUpdateItem = updateAvailable && (updateRuntimeType === 'desktop' || updateRuntimeType === 'web');

  const openMcpCreateSettings = useEvent(() => {
    const baseName = 'new-mcp-server';
    let newName = baseName;
    let counter = 1;
    while (mcpServers.some((server) => server.name === newName)) {
      newName = `${baseName}-${counter}`;
      counter += 1;
    }

    const draft: McpDraft = {
      name: newName,
      scope: 'user',
      type: 'local',
      command: [],
      url: '',
      environment: [],
      headers: [],
      oauthEnabled: true,
      oauthClientId: '',
      oauthClientSecret: '',
      oauthScope: '',
      oauthRedirectUri: '',
      timeout: '',
      enabled: true,
    };

    setMcpDraft(draft);
    setSelectedMcp(newName);
    setMcpOpen(false);
    openSettingsSurface('mcp');
  });

  const refreshMcpOverlay = useEvent(() => {
    if (isMcpRefreshing) return;
    setIsMcpRefreshing(true);
    const minSpinPromise = new Promise((resolve) => window.setTimeout(resolve, 500));
    void Promise.all([
      refetchMcpStatus(),
      refetchMcpConfigs(),
      minSpinPromise,
    ]).finally(() => setIsMcpRefreshing(false));
  });

  const openNewSessionDraft = useSessionUIStore((state) => state.openNewSessionDraft);

  const overflowItems: OverflowItem[] = React.useMemo(
    () => {
      const items: OverflowItem[] = [
        // 新版移动端：右上角菜单首项改为新增会话（承接原 + 入口）
        {
          key: 'new-session',
          icon: 'chat-new',
          label: t('mobile.menu.newSession'),
          onSelect: () => {
            if (isIPad) {
              setActiveMainTab('chat');
              openNewSessionDraft();
              return;
            }
            useMobileNavigationStore.getState().openDraft();
          },
        },
      ];
      // iPad exposes Files/Changes as header shortcuts instead of menu items.
      if (!isIPad) {
        items.push(
          {
            key: 'files',
            icon: 'file-text',
            label: t('mobile.menu.files'),
            onSelect: () => openFilesSurface(),
          },
          {
            key: 'changes',
            icon: 'git-branch',
            label: t('mobile.menu.changes'),
            badge: dirtyChangeCount,
            onSelect: () => openChangesSurface(),
          },
        );
      }
      items.push({
        key: 'mcp',
        iconNode: <McpIcon className="size-5 shrink-0 text-muted-foreground" />,
        label: t('mobile.menu.mcp'),
        onSelect: () => setMcpOpen(true),
      });
      if (showUpdateItem) {
        items.push({
          key: 'update',
          icon: 'download',
          label: t('mobile.menu.update'),
          onSelect: () => setUpdateOpen(true),
        });
      }
      // Phone Settings lives on the root tab bar; only iPad still opens Settings
      // from the chat overflow menu (no bottom Settings tab there).
      if (isIPad) {
        items.push({
          key: 'settings',
          icon: 'settings-3',
          label: t('mobile.menu.settings'),
          onSelect: () => openSettingsSurface(),
        });
      }
      if (currentSessionId) {
        items.push({
          key: 'refresh-transcript',
          icon: 'refresh',
          label: t('sessions.sidebar.session.menu.refreshTranscript'),
          disabled: isTranscriptRefreshing || isSessionBusy,
          spinning: isTranscriptRefreshing,
          onSelect: refreshCurrentTranscript,
        });
      }
      return items;
    },
    [currentSessionId, dirtyChangeCount, isIPad, isSessionBusy, isTranscriptRefreshing, openChangesSurface, openFilesSurface, openNewSessionDraft, openSettingsSurface, refreshCurrentTranscript, setActiveMainTab, showUpdateItem, t],
  );

  return (
    <DedicatedMobileAppProvider actions={mobileActions}>
      <div
        className="oc-mobile-app-shell main-content-safe-area flex h-[100dvh] flex-row text-foreground"
        data-page-scroll-lock="true"
      >
        {/* iPad: persistent full-height sessions sidebar; the chat column and
            its header butt against it (iPadOS-style split layout). Always
            mounted so open/close animates width, same as the desktop Sidebar. */}
        {isIPad ? (
          <aside
            ref={leftResize.asideRef}
            className={cn(
              'relative flex h-full shrink-0 flex-col overflow-hidden border-r border-border/50 bg-sidebar will-change-[width] motion-reduce:transition-none',
              !ipadSidebarOpen && 'border-r-0',
            )}
            style={{
              width: ipadSidebarOpen ? leftResize.width : 0,
              minWidth: ipadSidebarOpen ? leftResize.width : 0,
              maxWidth: ipadSidebarOpen ? leftResize.width : 0,
              ['--oc-ipad-sidebar-width' as string]: `${leftResize.width}px`,
              overflowX: 'clip',
              paddingTop: 'var(--oc-safe-area-top, 0px)',
              transitionProperty: leftResize.isResizing ? 'none' : 'width, min-width, max-width',
              transitionDuration: '200ms',
              transitionTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)',
            }}
            aria-hidden={!ipadSidebarOpen}
            data-page-scroll-lock="true"
          >
            {ipadSidebarOpen ? (
              <IpadSidebarResizeHandle
                side="left"
                isResizing={leftResize.isResizing}
                ariaLabel={t('sidebar.resize.leftPanelAria')}
                handleProps={leftResize.handleProps}
              />
            ) : null}
            <div
              className={cn(
                'flex h-full shrink-0 flex-col transition-opacity duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
                leftResize.isResizing && 'pointer-events-none',
                !ipadSidebarOpen && 'pointer-events-none select-none opacity-0',
              )}
              style={{ width: 'var(--oc-ipad-sidebar-width)', overflowX: 'hidden' }}
            >
              <ErrorBoundary>
                <MobileSessionsSheet
                  open
                  variant="sidebar"
                  // The surface asks to close after picking a session/project or
                  // creating a worktree; the persistent landscape sidebar stays
                  // put, portrait gives the space back to the chat.
                  onOpenChange={(value) => {
                    if (!value && isPortrait) setIpadSidebarOpen(false);
                  }}
                />
              </ErrorBoundary>
            </div>
          </aside>
        ) : null}

        <div className="flex h-full min-w-0 flex-1 flex-col" data-page-scroll-lock="true">
          {isIPad ? (
            <>
              {activeMainTab !== 'assistant' ? <div>
                <MobileHeader
                  onOpenSessions={() => toggleIpadSidebar()}
                  menuOpen={overflowOpen}
                  onToggleMenu={toggleOverflowMenu}
                  surfaceShortcuts={{
                    activePanel: ipadRightPanel === 'turn-diff' ? 'changes' : ipadRightPanel,
                    changesDirty: dirtyChangeCount > 0,
                    onToggleFiles: () => toggleIpadRightPanel('files'),
                    onToggleChanges: () => toggleIpadRightPanel('changes'),
                  }}
                />
              </div> : null}
              <main ref={chatMainRef} className="relative min-h-0 flex-1 overflow-hidden" data-page-scroll-lock="true">
                <div
                  ref={previousSessionHolderRef}
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-y-0 -left-full flex w-full items-center justify-end gap-3 bg-background pr-4"
                >
                  <span className="typography-micro font-medium tracking-wide text-muted-foreground/60">
                    {t('helpDialog.item.previousSession')}
                  </span>
                  <span className="flex size-11 items-center justify-center rounded-full border border-border/70 bg-[var(--surface-elevated)] text-foreground shadow-sm">
                    <Icon name="arrow-left" className="size-5" />
                  </span>
                </div>
                <div
                  ref={nextSessionHolderRef}
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-y-0 left-full flex w-full items-center justify-start gap-3 bg-background pl-4"
                >
                  <span className="flex size-11 items-center justify-center rounded-full border border-border/70 bg-[var(--surface-elevated)] text-foreground shadow-sm">
                    <Icon name="arrow-right" className="size-5" />
                  </span>
                  <span className="typography-micro font-medium tracking-wide text-muted-foreground/60">
                    {t('helpDialog.item.nextSession')}
                  </span>
                </div>
                <div ref={chatAnimRef} className="relative h-full w-full bg-background">
                  <ErrorBoundary>
                    {activeMainTab === 'assistant' ? <AssistantView /> : <ChatView />}
                  </ErrorBoundary>
                </div>
              </main>
            </>
          ) : (
            <MobilePhoneShell
              className="min-h-0 flex-1"
              onAddProject={() => setDirectoryDialogOpen(true)}
              onScanQr={showCapacitorOnlyFeatures && qrScanSupported ? () => { void scanConnectionFromHome(); } : undefined}
              onSwitchInstance={showCapacitorOnlyFeatures ? openInstancesSecondary : undefined}
              onEnableAssistants={() => {
                openSettingsSurface('assistants');
              }}
              instancesPage={showCapacitorOnlyFeatures ? (
                <MobileInstancesSurface
                  connection={connection}
                  onConnect={() => undefined}
                  onActiveConnectionDeleted={onActiveConnectionDeleted}
                />
              ) : undefined}
              instancesSecondaryPage={showCapacitorOnlyFeatures ? (
                <div className="oc-settings-workspace oc-settings-workspace-mobile flex h-full min-h-0 flex-col bg-[var(--surface-background)]">
                  <MobileDetailNavigation
                    title={t('mobile.settings.switchInstance')}
                    backAriaLabel={t('header.actions.backAria')}
                    onBack={closeInstancesSecondary}
                  />
                  <div className="min-h-0 flex-1 overflow-y-auto px-[var(--oc-mobile-page-inline-inset)]">
                    <MobileFloatingSurface className="oc-mobile-settings-detail-card">
                      <MobileInstancesSurface
                        connection={connection}
                        onConnect={() => undefined}
                        onActiveConnectionDeleted={onActiveConnectionDeleted}
                      />
                    </MobileFloatingSurface>
                  </div>
                </div>
              ) : undefined}
              parentSessionTarget={
                parentSessionTarget
                  ? { id: parentSessionTarget.id, directory: parentSessionTarget.directory }
                  : null
              }
              registerSecondaryBackHandler={registerPhoneSecondaryBack}
              scheduledContent={(registerEditorBackHandler, onEditorActiveChange) => (
                <ScheduledTasksWorkspace
                  presentation="mobile-tab"
                  registerEditorBackHandler={registerEditorBackHandler}
                  onEditorActiveChange={onEditorActiveChange}
                />
              )}
              renderChat={(target) => (
                <MobileChatScreen
                  sessionId={target.sessionId}
                  directory={target.directory}
                  onBack={() => {
                    closeOverflowMenu();
                    mobileBackNavigationCoordinator.requestAnimatedBack('root');
                  }}
                  onOpenMenu={toggleOverflowMenu}
                  onCloseMenu={closeOverflowMenu}
                  menuOpen={target.active && overflowOpen}
                >
                  <main ref={target.active ? chatMainRef : undefined} className="relative h-full min-h-0 flex-1 overflow-hidden" data-page-scroll-lock="true">
                    {target.active ? (
                      <>
                        <div
                          ref={previousSessionHolderRef}
                          aria-hidden="true"
                          className="pointer-events-none absolute inset-y-0 -left-full flex w-full items-center justify-end gap-3 bg-background pr-4"
                        >
                          <span className="typography-micro font-medium tracking-wide text-muted-foreground/60">
                            {t('helpDialog.item.previousSession')}
                          </span>
                          <span className="flex size-11 items-center justify-center rounded-full border border-border/70 bg-[var(--surface-elevated)] text-foreground shadow-sm">
                            <Icon name="arrow-left" className="size-5" />
                          </span>
                        </div>
                        <div
                          ref={nextSessionHolderRef}
                          aria-hidden="true"
                          className="pointer-events-none absolute inset-y-0 left-full flex w-full items-center justify-start gap-3 bg-background pl-4"
                        >
                          <span className="flex size-11 items-center justify-center rounded-full border border-border/70 bg-[var(--surface-elevated)] text-foreground shadow-sm">
                            <Icon name="arrow-right" className="size-5" />
                          </span>
                          <span className="typography-micro font-medium tracking-wide text-muted-foreground/60">
                            {t('helpDialog.item.nextSession')}
                          </span>
                        </div>
                      </>
                    ) : null}
                    <div ref={target.active ? chatAnimRef : undefined} className="relative h-full w-full bg-background">
                      <ErrorBoundary>
                        <ChatView
                          readOnly={!target.active}
                          active={target.active}
                          selectionOverride={{
                            sessionId: target.sessionId || null,
                            directory: target.directory,
                            viewKey: target.viewKey,
                          }}
                        />
                      </ErrorBoundary>
                    </div>
                  </main>
                </MobileChatScreen>
              )}
            />
          )}
        </div>

        {/* iPad: Changes/Files live in a full-height right sidebar instead of
            the phone's fullscreen surfaces. Width animates like the desktop
            RightSidebar; content stays mounted through the collapse. */}
        {isIPad ? (
          <aside
            ref={rightResize.asideRef}
            className={cn(
              'relative flex h-full shrink-0 flex-col overflow-hidden border-l border-border/50 bg-background will-change-[width] motion-reduce:transition-none',
              !ipadRightPanel && 'border-l-0',
            )}
            style={{
              width: ipadRightPanel ? rightResize.width : 0,
              minWidth: ipadRightPanel ? rightResize.width : 0,
              maxWidth: ipadRightPanel ? rightResize.width : 0,
              ['--oc-ipad-sidebar-width' as string]: `${rightResize.width}px`,
              overflowX: 'clip',
              paddingTop: 'var(--oc-safe-area-top, 0px)',
              transitionProperty: rightResize.isResizing ? 'none' : 'width, min-width, max-width',
              transitionDuration: '200ms',
              transitionTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)',
            }}
            aria-hidden={!ipadRightPanel}
            data-page-scroll-lock="true"
          >
            {ipadRightPanel ? (
              <IpadSidebarResizeHandle
                side="right"
                isResizing={rightResize.isResizing}
                ariaLabel={t('sidebar.resize.rightPanelAria')}
                handleProps={rightResize.handleProps}
              />
            ) : null}
            <div
              className={cn(
                'flex h-full shrink-0 flex-col transition-opacity duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
                rightResize.isResizing && 'pointer-events-none',
                !ipadRightPanel && 'pointer-events-none select-none opacity-0',
              )}
              style={{ width: 'var(--oc-ipad-sidebar-width)', overflowX: 'hidden' }}
            >
              {ipadRightContentMounted ? (
                <ErrorBoundary>
                  {renderedIpadRightPanel === 'files' ? (
                    <MobileFilesSurface onClose={closeIpadRightPanel} />
                  ) : renderedIpadRightPanel === 'turn-diff' ? (
                    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground">
                      <header className="flex h-[var(--oc-header-height,56px)] shrink-0 items-center gap-2 border-b border-border/40 px-3">
                        <h2 className="min-w-0 flex-1 truncate typography-ui-label font-semibold text-foreground">
                          {t('mobile.nav.changes')}
                        </h2>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={closeIpadRightPanel}
                          aria-label={t('mobile.surface.closeAria')}
                          className="shrink-0 text-muted-foreground"
                          style={{ touchAction: 'manipulation' }}
                        >
                          <Icon name="close" className="size-5" />
                        </Button>
                      </header>
                      <div className="min-h-0 flex-1 overflow-hidden">
                        <DiffView
                          hideStackedFileSidebar
                          pinSelectedFileHeaderToTopOnNavigate
                          diffScope="turn"
                          turnMessageId={turnDiffMessageId}
                          sessionId={turnDiffSessionId}
                          targetFilePath={turnDiffTargetFilePath}
                          navigationRequestKey={turnDiffNavigationKey}
                          flushContent
                        />
                      </div>
                    </div>
                  ) : pendingChangesDiff?.toolPatches?.length ? (
                    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground">
                      <header className="flex h-[var(--oc-header-height,56px)] shrink-0 items-center gap-2 border-b border-border/40 px-3">
                        <h2 className="min-w-0 flex-1 truncate typography-ui-label font-semibold text-foreground">
                          {pendingChangesDiff.toolPatches.length > 1
                            ? t('mobile.nav.changes')
                            : pendingChangesDiff.path}
                        </h2>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={closeIpadRightPanel}
                          aria-label={t('mobile.surface.closeAria')}
                          className="shrink-0 text-muted-foreground"
                          style={{ touchAction: 'manipulation' }}
                        >
                          <Icon name="close" className="size-5" />
                        </Button>
                      </header>
                      <div className="min-h-0 flex-1 overflow-hidden">
                        <DiffView
                          hideStackedFileSidebar
                          diffScope="turn"
                          targetFilePath={pendingChangesDiff.path}
                          targetLine={pendingChangesDiff.targetLine ?? null}
                          toolPatches={pendingChangesDiff.toolPatches}
                          singleFileView={pendingChangesDiff.toolPatches.length === 1}
                          flushContent
                        />
                      </div>
                    </div>
                  ) : (
                    <MobileChangesSurface
                      onClose={closeIpadRightPanel}
                      initialDiffPath={pendingChangesDiff?.path ?? null}
                      initialDiffStaged={pendingChangesDiff?.staged === true}
                      initialDiffTargetLine={pendingChangesDiff?.targetLine ?? null}
                    />
                  )}
                </ErrorBoundary>
              ) : null}
            </div>
          </aside>
        ) : null}

        <DirectoryExplorerDialog
          open={directoryDialogOpen}
          onOpenChange={setDirectoryDialogOpen}
          forceMobile
        />

        <MobileOverflowMenu
          open={overflowOpen}
          onClose={() => setOverflowOpen(false)}
          items={overflowItems}
          rightOffset={isIPad && ipadRightPanel ? rightResize.width : 0}
        />

        <ScheduledTasksDialog />

        {/* Mount only while open so each surface computes safe-area layout
            fresh. open={state} (not a bare `open`) is required: dismiss settle
            re-reads the controlled prop before unmount; a hardcoded true makes
            the sheet flash back up after a gesture dismiss. */}
        {filesOpen ? (
          <MobileResizableSheet
            id={MOBILE_FILES_WINDOW_ID}
            open={filesOpen}
            onOpenChange={(nextOpen) => {
              if (!nextOpen) setFilesOpen(false);
            }}
            ariaLabel={t('mobile.menu.files')}
            closeAriaLabel={t('mobile.surface.closeAria')}
            resizeAriaLabel={t('mobile.sessions.sheet.resizeAria')}
            initiallyExpanded
          >
            <ErrorBoundary>
              <MobileFilesSurface onClose={() => setFilesOpen(false)} />
            </ErrorBoundary>
          </MobileResizableSheet>
        ) : null}

        {filePreviewOpen && pendingFilePreview ? (
          <MobileResizableSheet
            id={MOBILE_DIRECT_FILE_WINDOW_ID}
            open={filePreviewOpen}
            onOpenChange={(nextOpen) => {
              if (!nextOpen) closeFilePreview();
            }}
            title={(
              <h2 className="truncate typography-ui-label font-semibold text-foreground">
                {pendingFilePreview.path.split(/[/\\]/).filter(Boolean).at(-1) ?? pendingFilePreview.path}
              </h2>
            )}
            ariaLabel={t('mobile.menu.files')}
            closeAriaLabel={t('mobile.surface.closeAria')}
            resizeAriaLabel={t('mobile.changes.sheet.resizeAria')}
            initiallyExpanded
          >
            <ErrorBoundary>
              <MobileFilesSurface
                key={pendingFilePreview.path}
                onClose={closeFilePreview}
                initialFilePath={pendingFilePreview.path}
                directFilePreview
                hideFileHeader
              />
            </ErrorBoundary>
          </MobileResizableSheet>
        ) : null}

        <MobileResizableSheet
            id={MOBILE_TURN_DIFF_WINDOW_ID}
            open={turnDiffOpen}
            onOpenChange={(nextOpen) => {
              if (!nextOpen) closeTurnDiff();
            }}
            title={(
              <h2 className="truncate typography-ui-label font-semibold text-foreground">
                {t('mobile.nav.changes')}
              </h2>
            )}
            ariaLabel={t('mobile.nav.changes')}
            closeAriaLabel={t('mobile.surface.closeAria')}
            resizeAriaLabel={t('mobile.changes.sheet.resizeAria')}
            initiallyExpanded
          >
            <ErrorBoundary>
              <DiffView
                hideStackedFileSidebar
                pinSelectedFileHeaderToTopOnNavigate
                diffScope="turn"
                turnMessageId={turnDiffMessageId}
                sessionId={turnDiffSessionId}
                targetFilePath={turnDiffTargetFilePath}
                navigationRequestKey={turnDiffNavigationKey}
                flushContent
              />
            </ErrorBoundary>
        </MobileResizableSheet>

        {changesOpen && pendingChangesDiff ? (
          <MobileResizableSheet
            id={MOBILE_DIRECT_DIFF_WINDOW_ID}
            open={changesOpen}
            onOpenChange={(nextOpen) => {
              if (!nextOpen) closeChanges();
            }}
            title={(
              <h2 className="truncate typography-ui-label font-semibold text-foreground">
                {pendingChangesDiff.toolPatches && pendingChangesDiff.toolPatches.length > 1
                  ? t('mobile.nav.changes')
                  : pendingChangesDiff.path}
              </h2>
            )}
            ariaLabel={t('mobile.menu.changes')}
            closeAriaLabel={t('mobile.surface.closeAria')}
            resizeAriaLabel={t('mobile.changes.sheet.resizeAria')}
            initiallyExpanded
          >
            <ErrorBoundary>
              {pendingChangesDiff.toolPatches?.length ? (
                <DiffView
                  hideStackedFileSidebar
                  diffScope="turn"
                  targetFilePath={pendingChangesDiff.path}
                  targetLine={pendingChangesDiff.targetLine ?? null}
                  toolPatches={pendingChangesDiff.toolPatches}
                  singleFileView={pendingChangesDiff.toolPatches.length === 1}
                  flushContent
                />
              ) : (
                <MobileChangesSurface
                  initialDiffPath={pendingChangesDiff.path}
                  initialDiffStaged={pendingChangesDiff.staged}
                  initialDiffTargetLine={pendingChangesDiff.targetLine ?? null}
                  hideDiffHeader
                />
              )}
            </ErrorBoundary>
          </MobileResizableSheet>
        ) : changesOpen ? (
          <MobileResizableSheet
            id={MOBILE_CHANGES_WINDOW_ID}
            open={changesOpen}
            onOpenChange={(nextOpen) => {
              if (!nextOpen) closeChanges();
            }}
            ariaLabel={t('mobile.menu.changes')}
            closeAriaLabel={t('mobile.surface.closeAria')}
            resizeAriaLabel={t('mobile.changes.sheet.resizeAria')}
            initiallyExpanded
          >
            <ErrorBoundary>
              <MobileChangesSurface
                onClose={closeChanges}
                initialDiffPath={pendingChangesDiff?.path ?? null}
                initialDiffStaged={pendingChangesDiff?.staged === true}
                initialDiffTargetLine={pendingChangesDiff?.targetLine ?? null}
              />
            </ErrorBoundary>
          </MobileResizableSheet>
        ) : null}

        {mcpOpen ? (
          <MobileResizableSheet
            id={MOBILE_MCP_WINDOW_ID}
            open={mcpOpen}
            onOpenChange={(nextOpen) => {
              if (!nextOpen) setMcpOpen(false);
            }}
            title={(
              <h2 className="truncate typography-ui-label font-semibold text-foreground">
                {t('mcpDropdown.title')}
              </h2>
            )}
            trailing={(
              <>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={openMcpCreateSettings}
                  aria-label={t('settings.mcp.sidebar.actions.addServerTitle')}
                  title={t('settings.mcp.sidebar.actions.addServerTitle')}
                  style={{ touchAction: 'manipulation' }}
                >
                  <Icon name="add" className="size-5" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={refreshMcpOverlay}
                  disabled={isMcpRefreshing}
                  aria-label={t('mcpDropdown.actions.refreshAria')}
                  title={t('mcpDropdown.actions.refreshAria')}
                  style={{ touchAction: 'manipulation' }}
                >
                  <Icon name="refresh" className={cn('size-5', isMcpRefreshing && 'animate-spin')} />
                </Button>
              </>
            )}
            ariaLabel={t('mcpDropdown.title')}
            closeAriaLabel={t('mobile.surface.closeAria')}
            resizeAriaLabel={t('mobile.sessions.sheet.resizeAria')}
            initiallyExpanded
          >
            <ErrorBoundary>
              <McpDropdownContent
                active
                className="h-full"
                listClassName="max-h-none"
                hideHeader
                mobileListDensity
              />
            </ErrorBoundary>
          </MobileResizableSheet>
        ) : null}

        {settingsOpen && isIPad ? (
          <MobileResizableSheet
            id={MOBILE_SETTINGS_WINDOW_ID}
            open={settingsOpen}
            onOpenChange={(nextOpen) => {
              if (!nextOpen) setSettingsOpen(false);
            }}
            ariaLabel={t('mobile.menu.settings')}
            closeAriaLabel={t('mobile.surface.closeAria')}
            resizeAriaLabel={t('mobile.sessions.sheet.resizeAria')}
            initiallyExpanded
          >
            <ErrorBoundary>
              <SettingsView
                forceMobile
                isWindowed
                initialMobileStage={settingsInitialMobileStage}
                visiblePageSlugs={[...MOBILE_SETTINGS_PAGE_SLUGS]}
                onClose={() => setSettingsOpen(false)}
                mobileInstancesPage={showCapacitorOnlyFeatures ? (
                  <MobileInstancesSurface
                    connection={connection}
                    onConnect={() => setSettingsOpen(false)}
                    onActiveConnectionDeleted={onActiveConnectionDeleted}
                  />
                ) : undefined}
              />
            </ErrorBoundary>
          </MobileResizableSheet>
        ) : null}

        {updateOpen ? (
          <MobileResizableSheet
            id={MOBILE_UPDATE_WINDOW_ID}
            open={updateOpen}
            onOpenChange={(nextOpen) => {
              if (!nextOpen) setUpdateOpen(false);
            }}
            title={(
              <h2 className="truncate typography-ui-label font-semibold text-foreground">
                {t('mobile.menu.update')}
              </h2>
            )}
            ariaLabel={t('mobile.menu.update')}
            closeAriaLabel={t('mobile.surface.closeAria')}
            resizeAriaLabel={t('mobile.sessions.sheet.resizeAria')}
            initiallyExpanded
          >
            <ErrorBoundary>
              <div className="h-full overflow-auto px-5 py-4">
                <AboutSettings initialUpdateDialogOpen />
              </div>
            </ErrorBoundary>
          </MobileResizableSheet>
        ) : null}
      </div>
      <AssistantShareWelcome
        enabled={showCapacitorOnlyFeatures
          && activeMainTab === 'assistant'
          && assistantCapability.data?.supported === true
          && assistantCapability.data?.enabled === true}
      />
      <ErrorBoundary>
        <MobileSessionStatusBar />
      </ErrorBoundary>
    </DedicatedMobileAppProvider>
  );
};

export function MobileApp({ apis }: MobileAppProps) {
  React.useEffect(() => startPerfDiagnosticsController(), []);

  const { t } = useI18n();
  const initializeApp = useConfigStore((state) => state.initializeApp);
  const isInitialized = useConfigStore((state) => state.isInitialized);
  const isConnected = useConfigStore((state) => state.isConnected);
  const connectionPhase = useConfigStore((state) => state.connectionPhase);
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const newSessionDraftOpen = useSessionUIStore((state) => Boolean(state.newSessionDraft?.open));
  const error = useSessionUIStore((state) => state.error);
  const clearError = useSessionUIStore((state) => state.clearError);
  const setIsMobile = useUIStore((state) => state.setIsMobile);
  const refreshGitHubAuthStatus = useGitHubAuthStore((state) => state.refreshStatus);
  const projects = useProjectsStore((state) => state.projects);
  const [connectionEpoch, setConnectionEpoch] = React.useState(0);
  const [runtimeEndpointEpoch, setRuntimeEndpointEpoch] = React.useState(0);
  const [showConnectionRecovery, setShowConnectionRecovery] = React.useState(false);
  // Cold-launch auto-connect to the last instance: 'pending'/'attempting' hold the
  // splash so we don't flash the connect screen; 'done' means we either connected or
  // exhausted the attempt (then the connect screen shows).
  const [autoConnectPhase, setAutoConnectPhase] = React.useState<'pending' | 'attempting' | 'done'>('pending');
  // The instance the splash says we are connecting to. Read once on mount —
  // auto-connect targets the most-recent saved connection from the same list.
  const autoConnectLabel = React.useMemo(() => getAutoConnectTargetLabel(), []);
  // Bumped to force a re-render (and thus a fresh `sdk` prop for SyncProvider)
  // after a same-device transport swap — reconnects the sync layer in place with
  // no remount. The value itself is unused; only the re-render matters.
  const [, bumpTransportSwitch] = React.useReducer((count: number) => count + 1, 0);
  const isNativeMobileApp = React.useMemo(() => isCapacitorMobileApp(), []);
  const lastNativeResumeSyncEventAtRef = React.useRef(0);
  const nativeResumeValidationSeqRef = React.useRef(0);
  const pairingConnection = useMobileConnection(() => {
    setAutoConnectPhase('done');
    setConnectionEpoch((value) => value + 1);
  });
  const handlePairingDeepLink = useEvent((pairing: PairingConnectionPayload) => {
    void pairingConnection.redeemPairingConnection(pairing);
  });
  usePairingDeepLinkHandler(handlePairingDeepLink);
  const initialDeepLinkKind = useDeepLinkSource({ ready: isNativeMobileApp && isConnected && isInitialized });

  React.useEffect(() => {
    if (!pairingConnection.error || !getRuntimeApiBaseUrl()) return;
    toast.error(pairingConnection.error);
  }, [pairingConnection.error]);

  const handleNativeResume = useEvent(() => {
    const apiBaseUrl = getRuntimeApiBaseUrl();
    const validationSeq = nativeResumeValidationSeqRef.current + 1;
    nativeResumeValidationSeqRef.current = validationSeq;

    if (!apiBaseUrl) {
      // Already disconnected — e.g. a previous re-probe ran mid network flux
      // (Android Wi-Fi switch with no cellular fallback) and found nothing
      // reachable. When a resume/online signal arrives, silently retry the last
      // saved instance instead of dead-ending on the connect screen until the
      // user restarts the app. Success fires runtime-endpoint-changed, which
      // re-bootstraps everything.
      void autoConnectLastInstance();
      return;
    }

    // Re-probe the active device's transports on resume: the network may have
    // changed while the app slept, so hot-switch LAN⇄relay if a better transport
    // is now reachable — no re-pairing. A 'switched' outcome already fired the
    // runtime-endpoint-changed subscription (which re-bootstraps the app), so we
    // only refresh in place when the transport is 'unchanged'.
    const refreshInPlace = () => {
      void initializeApp();
      void refreshGitHubAuthStatus(apis.github, { force: true });
      // Catalog recovery is owned by useStartupCatalogRecovery; resume only
      // re-runs initializeApp and auth. Empty catalogs re-enter recovery when
      // isConnected stays true or connectionEpoch remounts bootstrap.
      void useConfigStore.getState().refreshMissingCatalogs({ source: 'mobileApp:nativeResume' });
    };
    const disconnect = () => {
      switchRuntimeEndpoint({ apiBaseUrl: '', clientToken: null, runtimeKey: 'mobile-disconnected' });
      setConnectionEpoch((value) => value + 1);
    };

    void reprobeActiveConnection().then((outcome) => {
      if (nativeResumeValidationSeqRef.current !== validationSeq) return;
      if (outcome === 'no-connection') {
        disconnect();
        return;
      }
      if (outcome === 'unreachable') {
        // Right after a resume or Wi-Fi switch the network is often still
        // settling (on Android without a SIM there is NO connectivity at all for
        // a few seconds), so a single fast probe races the network coming up.
        // Retry once after a grace period while the active transport recovers.
        window.setTimeout(() => {
          if (nativeResumeValidationSeqRef.current !== validationSeq) return;
          void reprobeActiveConnection().then((retry) => {
            if (nativeResumeValidationSeqRef.current !== validationSeq) return;
            if (retry === 'switched') return;
            if (retry === 'unchanged') {
              refreshInPlace();
              return;
            }
            // A reachability probe can lose a short network race while the
            // active Relay tunnel is reconnecting. Keep the current runtime
            // and its catalog snapshot so the tunnel/event recovery path can
            // restore the connection without blanking the model picker.
            return;
          });
        }, 4000);
        return;
      }
      if (outcome === 'switched') return;

      refreshInPlace();
    });

    const now = Date.now();
    if (now - lastNativeResumeSyncEventAtRef.current >= NATIVE_RESUME_SYNC_EVENT_THROTTLE_MS) {
      lastNativeResumeSyncEventAtRef.current = now;
      window.dispatchEvent(new Event('openchamber:system-resume'));
    }
  });

  useNativeMobileChrome();
  useNativeMobileLifecycle(handleNativeResume);

  // Network-change re-probe. The resume hook only fires on background→foreground,
  // but on Android switching Wi-Fi (quick-settings tile) does NOT background the
  // app — no visibility/appState event ever fires, so the app would sit on a dead
  // LAN transport instead of hot-switching to relay. The webview's `online` event
  // fires on connectivity changes (new Wi-Fi, cellular back, airplane off), so
  // run the same re-probe then. Debounced: the first seconds after `online` the
  // route is often not usable yet, and rapid offline/online flaps must collapse
  // into one probe. iOS also gets this (harmless — same seq-guarded operation the
  // resume path runs; a concurrent duplicate supersedes via the seq ref).
  React.useEffect(() => {
    if (!isNativeMobileApp) return;
    let timer: number | undefined;
    const handleOnline = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => handleNativeResume(), 1500);
    };
    window.addEventListener('online', handleOnline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.clearTimeout(timer);
    };
  }, [isNativeMobileApp, handleNativeResume]);

  React.useEffect(() => {
    registerRuntimeAPIs(apis);
    return () => registerRuntimeAPIs(null);
  }, [apis]);

  // Capgo app-ready must fire on load, not after server connection — readiness is
  // about the JS shell surviving the first paint, not remote connectivity.
  React.useEffect(() => {
    if (!isNativeMobileApp) return;
    void getCapgoUpdater().then((updater) => {
      if (!updater) return;
      void updater.notifyAppReady().catch(() => undefined);
    });
  }, [isNativeMobileApp]);

  React.useEffect(() => {
    if (!isNativeMobileApp) return;

    let disposed = false;
    const cleanups: Array<() => void> = [];

    void getCapgoUpdater().then(async (updater) => {
      if (!updater || disposed) return;

      try {
        const download = await updater.addListener('download', (event) => {
          useUpdateStore.getState().setOtaDownloadPercent(event.percent);
        });
        const downloadFailed = await updater.addListener('downloadFailed', () => {
          useUpdateStore.getState().setOtaDownloadFailed();
        });
        const downloadComplete = await updater.addListener('downloadComplete', () => {
          useUpdateStore.getState().setOtaPhase('pending_restart');
        });
        const appReloaded = await updater.addListener('appReloaded', () => {
          useUpdateStore.getState().setOtaPhase('pending_restart');
        });
        const autoRevert = await updater.addListener('autoRevert', () => {
          console.warn('[OTA] Capgo auto-reverted the last bundle');
          useUpdateStore.getState().setOtaPhase('error', 'OTA update was reverted');
        });

        if (disposed) {
          void download.remove();
          void downloadFailed.remove();
          void downloadComplete.remove();
          void appReloaded.remove();
          void autoRevert.remove();
          return;
        }

        cleanups.push(
          () => void download.remove(),
          () => void downloadFailed.remove(),
          () => void downloadComplete.remove(),
          () => void appReloaded.remove(),
          () => void autoRevert.remove(),
        );
      } catch (error) {
        console.warn('[OTA] Failed to subscribe to Capgo updater events:', error);
      }
    });

    return () => {
      disposed = true;
      for (const cleanup of cleanups) cleanup();
    };
  }, [isNativeMobileApp]);

  // Switching instances (or disconnecting) only changes the runtime endpoint; the
  // stores still hold the previous instance's data. Mirror the web App.tsx reset
  // sequence so the UI fully re-bootstraps against the new server instead of going
  // stale. The SyncProvider is keyed by runtimeEndpointEpoch so it remounts too.
  React.useEffect(() => {
    return subscribeRuntimeEndpointChanged((detail) => {
      // A LAN⇄relay swap for the SAME device keeps the runtime key stable. Treat
      // that as a transport-only change: rebind the sync layer to the new
      // transport but keep the user's session/connection state — no reconnecting
      // screen, no bounce back to the draft. Only a real instance switch (key
      // change) does the full reset.
      const sameDevice = Boolean(detail.runtimeKey) && detail.runtimeKey === detail.previousRuntimeKey;
      if (sameDevice) {
        // Transport-only swap for the same device: rebind the SDK to the new
        // transport and force a re-render so SyncProvider receives the new `sdk`
        // prop. Its event-pipeline + bootstrap effects (keyed on `sdk`) then
        // reconnect over the new transport WITHOUT remounting — so the message
        // pagination refs, the open session, and the whole view are preserved.
        // No key bump, no flash, no bounce to the draft.
        reconnectAppForTransportSwitch();
        bumpTransportSwitch();
        return;
      }
      resetAppForRuntimeEndpointChange(detail);
      // Drop phone navigation state — the old runtime's chat/draft targets must
      // never materialize into the new runtime's session store.
      useMobileNavigationStore.getState().reset();
      setRuntimeEndpointEpoch((epoch) => epoch + 1);
      setConnectionEpoch((epoch) => epoch + 1);
    });
  }, []);

  // On cold launch, silently reconnect to the most-recent saved instance so a
  // returning user — and notification deep-links — land in the app instead of the
  // connect screen. The splash is held while we try (see render below). If there's
  // no saved instance, it's unreachable, or it needs a (re)login, we fall through
  // to the connect screen. A successful switchRuntimeEndpoint fires the endpoint-
  // changed subscription above, which bumps the epochs and bootstraps the app.
  React.useEffect(() => {
    if (initialDeepLinkKind === 'pending') return;
    if (initialDeepLinkKind === 'connect') {
      setAutoConnectPhase('done');
      return;
    }
    if (!isNativeMobileApp || isConnected || getRuntimeApiBaseUrl()) {
      setAutoConnectPhase('done');
      return;
    }
    let cancelled = false;
    setAutoConnectPhase('attempting');
    void handlePendingNativeAssistantOpen()
      .then((handled) => handled ? true : autoConnectLastInstance())
      .catch(() => false)
      .then(() => {
        if (!cancelled) setAutoConnectPhase('done');
      });
    return () => {
      cancelled = true;
    };
    // Run once on mount — auto-connect is a cold-launch concern only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialDeepLinkKind]);

  React.useEffect(() => {
    setIsMobile(true);
  }, [setIsMobile]);

  React.useEffect(() => {
    // Never bootstrap without a runtime endpoint on native: with apiBaseUrl ''
    // the resolver falls back to the webview's own origin, where Capacitor's
    // static server answers every request with index.html — the bootstrap
    // "succeeds" against a fake backend and flips isConnected back on, leaving
    // the user in an empty shell after a disconnect.
    if (isNativeMobileApp && !getRuntimeApiBaseUrl()) return;
    void initializeApp();
  }, [connectionEpoch, initializeApp, isNativeMobileApp]);

  useStartupCatalogRecovery({
    enabled: !isNativeMobileApp || Boolean(getRuntimeApiBaseUrl()),
    source: 'mobileApp:recovery',
  });

  React.useEffect(() => {
    if (!isConnected) return;
    opencodeClient.setDirectory(currentDirectory);
  }, [currentDirectory, isConnected]);

  // Gated on isConnected (and re-run on reconnect/instance switch): probing the
  // GitHub auth status before the runtime is reachable cached a "not connected"
  // answer that stuck until something else forced a re-check.
  React.useEffect(() => {
    if (!isConnected) return;
    void refreshGitHubAuthStatus(apis.github, { force: true });
  }, [apis.github, isConnected, refreshGitHubAuthStatus]);

  // Discover linked worktrees for every known project so Projects home, draft
  // selectors, and session sheets share the same catalog as desktop sidebar.
  // Authoritative write path: forceRefreshProjectWorktreeCatalog (invalidate +
  // list + per-project store merge) — same as topology sync / PC "sync sessions".
  // Do not bulk-replace availableWorktreesByProject from a non-force list: a
  // stale 30s cache or partial failure can wipe topology results (mobile missing
  // worktrees that PC already shows).
  // Gated on isConnected: probing before the runtime is reachable failed silently.
  React.useEffect(() => {
    if (!isConnected || projects.length === 0) return;
    let cancelled = false;

    const run = async () => {
      await Promise.all(
        projects.map(async (project) => {
          const projectPath = normalizePath(project.path);
          if (!projectPath) return;
          try {
            const cachedIsGitRepo = useGitStore.getState().directories.get(projectPath)?.isGitRepo;
            const isGitRepo =
              cachedIsGitRepo ?? (await import('@/lib/gitApi').then((m) => m.checkIsGitRepository(projectPath)));
            if (!isGitRepo || cancelled) return;
            await forceRefreshProjectWorktreeCatalog(
              { id: project.id, path: projectPath },
              { isCurrent: () => !cancelled },
            );
          } catch {
            // Best-effort per project: forceRefresh only writes on success, so a
            // failed probe keeps previously known (persisted / topology) entries.
          }
        }),
      );
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [isConnected, projects]);

  React.useEffect(() => {
    if (!error) return;
    const timeout = window.setTimeout(() => clearError(), 5000);
    return () => window.clearTimeout(timeout);
  }, [clearError, error]);

  React.useEffect(() => {
    // Native: only while an instance is selected and reconnecting. Browser: the
    // runtime is same-origin (no explicit base URL), so any not-connected spell
    // counts — the splash holds until this fires, then the error screen shows.
    const waitingOnConnection = !isConnected && (isNativeMobileApp ? Boolean(getRuntimeApiBaseUrl()) : true);
    if (!waitingOnConnection) {
      setShowConnectionRecovery(false);
      return;
    }
    const timeout = window.setTimeout(() => setShowConnectionRecovery(true), 8000);
    return () => window.clearTimeout(timeout);
  }, [isConnected, isNativeMobileApp, connectionEpoch, runtimeEndpointEpoch]);

  useAppFontEffects();
  usePushVisibilityBeacon({ enabled: true });
  useWindowTitle();
  useRouter();
  // APNs is the only notification channel on the native app (background-capable,
  // focus-suppressed server-side via the visibility beacon). Local notifications are
  // intentionally disabled — they can't tell foreground from background in a WKWebView
  // (document.hasFocus() is unreliable) and leaked while the app was open; the in-app SSE
  // notification dispatch is no-op'd for native in renderMobileApp.
  useNativePushRegistration({ enabled: isNativeMobileApp && isConnected });
  const fontsReady = useFontsReady();

  // `isConnected` is a LIVE flag that flips false on every transient SSE/WS drop and
  // back true on reconnect. We must NOT blank the whole app to a loader on those —
  // only on the initial connect / instance switch (connectionPhase 'connecting').
  // While 'reconnecting' (we were connected before), keep MobileShell mounted so the
  // UI doesn't reload on every network blip.
  const isReconnecting = !isConnected && connectionPhase === 'reconnecting';

  // Hold a logo splash until the UI web font is loaded, so the first UI the user sees
  // already uses the real font instead of flashing the fallback and reflowing (FOUT).
  if (!fontsReady) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-background text-foreground">
        <OpenChamberLogo width={120} height={120} isAnimated />
      </main>
    );
  }

  // No runtime endpoint on native = explicitly disconnected (last instance
  // deleted, revoked token, unreachable). The connect screen is the only valid
  // UI then — regardless of what a stale isConnected flag claims (the store can
  // be poisoned by a bootstrap that ran against the webview's own origin).
  const hasRuntimeEndpoint = Boolean(getRuntimeApiBaseUrl());

  if (isNativeMobileApp && (!hasRuntimeEndpoint || (!isConnected && !isReconnecting))) {
    // A runtime endpoint is already selected (first connect or switching instances):
    // show a loader while it re-bootstraps instead of flashing the onboarding screen.
    if (hasRuntimeEndpoint) {
      return (
        <main className="flex min-h-dvh items-center justify-center bg-background px-6 text-center text-foreground">
          <div className="flex max-w-sm flex-col items-center gap-4">
            <OpenChamberLogo width={120} height={120} isAnimated={!showConnectionRecovery} />
            {showConnectionRecovery ? (
              <>
                <div className="space-y-2">
                  <h1 className="typography-h3 text-foreground">{t('sessionAuth.error.networkTitle')}</h1>
                  <p className="typography-body text-muted-foreground">{t('sessionAuth.error.networkDescription')}</p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    switchRuntimeEndpoint({ apiBaseUrl: '', clientToken: null, runtimeKey: 'mobile-disconnected' });
                    setConnectionEpoch((value) => value + 1);
                  }}
                >
                  {t('mobile.connect.cancelPassword')}
                </Button>
              </>
            ) : null}
          </div>
        </main>
      );
    }
    // Cold-launch auto-connect is still resolving — hold the splash instead of
    // flashing the connect screen. Only show the connect screen once we've finished
    // (no saved instance, unreachable, or needs re-login).
    if (autoConnectPhase !== 'done') {
      return (
        <main className="relative flex min-h-dvh items-center justify-center bg-background text-foreground">
          <OpenChamberLogo width={120} height={120} isAnimated />
          {/* Absolutely positioned below the (still perfectly centered) logo so
              the text never pushes it up. 50% + half the 120px logo + a gap. */}
          {autoConnectLabel ? (
            <div className="absolute inset-x-0 top-[calc(50%+84px)] flex flex-col items-center gap-0.5 px-6 text-center">
              <p className="typography-small text-muted-foreground">{t('mobile.connect.splash.connectingTo')}</p>
              <p className="typography-small text-foreground">
                {autoConnectLabel}
                <BusyDots />
              </p>
            </div>
          ) : null}
        </main>
      );
    }
    return <MobileConnectionWelcome connection={pairingConnection} />;
  }

  if (!isConnected && !isReconnecting) {
    // Browser: the initial connect takes a beat — hold the logo splash instead
    // of flashing the unreachable-server error while it resolves. The error
    // only shows once the recovery delay has expired (genuinely unreachable).
    if (!showConnectionRecovery) {
      return (
        <main className="flex min-h-dvh items-center justify-center bg-background text-foreground">
          <OpenChamberLogo width={120} height={120} isAnimated />
        </main>
      );
    }
    return (
      <main className="flex min-h-dvh items-center justify-center bg-background px-6 text-center text-foreground">
        <div className="max-w-sm space-y-3">
          <h1 className="typography-h3 text-foreground">{t('sessionAuth.error.networkTitle')}</h1>
          <p className="typography-body text-muted-foreground">{t('sessionAuth.error.networkDescription')}</p>
        </div>
      </main>
    );
  }

  return (
    <ErrorBoundary>
      <SyncProvider key={runtimeEndpointEpoch} sdk={opencodeClient.getSdkClient()} directory={currentDirectory || ''} bootstrapDirectory={!(newSessionDraftOpen && currentSessionId === null)}>
        <RuntimeAPIProvider apis={apis}>
          <TooltipProvider delayDuration={300} skipDelayDuration={150}>
            <div className="h-full bg-background text-foreground">
              <SessionStartupCoordinator />
              <MobileShareBridge />
              <SyncAppEffects embeddedBackgroundWorkEnabled={isInitialized} />
              <OpenCodeUpdateToast />
              <MobileAppUpdateToast />
              <MobileOtaUpdateNotice />
              <MobileShell connection={pairingConnection} onActiveConnectionDeleted={() => {
                switchRuntimeEndpoint({ apiBaseUrl: '', clientToken: null, runtimeKey: 'mobile-disconnected' });
                useMobileNavigationStore.getState().reset();
                setConnectionEpoch((value) => value + 1);
              }} />
              <Toaster position="top-center" offset="calc(var(--oc-safe-area-top, 0px) + 16px)" />
              {isInitialized ? <ConfigUpdateOverlay /> : null}
            </div>
          </TooltipProvider>
        </RuntimeAPIProvider>
      </SyncProvider>
    </ErrorBoundary>
  );
}
