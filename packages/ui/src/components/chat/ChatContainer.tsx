import React from 'react';
import {
    useEvent,
    useEventListener,
    useIsomorphicLayoutEffect,
    useMount,
    useResizeObserver,
    useUnmount,
} from '@reactuses/core';
import type { Message, Part } from '@opencode-ai/sdk/v2';
import type { PermissionRequest } from '@/types/permission';
import type { QuestionRequest } from '@/types/question';

import { ChatInput } from './ChatInput';
import { ImageSaveActionsHost } from './ImageSaveActionsHost';
import type { ChatInputSurface } from './chatInputSurface';
import {
    resolveChatContainerHostFeatures,
    resolveChatHistoryLoadState,
    resolveChatHistoryPaginationLoading,
    hasChatTranscriptShell,
    resolveChatSessionTranscriptGate,
    resolveDesktopLoadOlderStatusVisibility,
    resolveMobileLoadOlderBusy,
    resolveMobileLoadOlderVisibility,
    mergePendingUserMessagePresentations,
    pendingUserMessagesImplyWorking,
    resolveRetainedTranscript,
    type ChatContainerHost,
    type ChatContainerHostFeatures,
    type PaintedTranscript,
} from './chatContainerHost';
import { hasUserDisplayableParts } from './message/normalizeUserDisplayParts';
import {
    createExplicitSessionSurface,
    SessionSurfaceContext,
} from './SessionSurfaceContext';
import { ReadOnlyPromptBanner } from './ReadOnlyPromptBanner';
import { DraftPresetChips } from './DraftPresetChips';
import { useInputStore } from '@/sync/input-store';
import { useUIStore } from '@/stores/useUIStore';
import { Skeleton } from '@/components/ui/skeleton';
import ChatEmptyState from './ChatEmptyState';
import { useGlobalSyncStore } from '@/sync/global-sync-store';
import MessageList, { type MessageListHandle } from './MessageList';
import { PermissionCard } from './PermissionCard';
import { QuestionCard } from './QuestionCard';
import { StatusRowContainer } from './StatusRowContainer';
import ScrollToBottomButton from './components/ScrollToBottomButton';
import { PromptNavigatorRail } from './components/PromptNavigatorRail';
import { ScrollShadow } from '@/components/ui/ScrollShadow';
import { useFeatureFlagsStore } from '@/stores/useFeatureFlagsStore';
import { useChatAutoFollow, type AnimationHandlers, type ContentChangeReason } from '@/hooks/useChatAutoFollow';
import { useHistoryUpwardIntent } from '@/hooks/lib/chatUpwardIntent';
import { useMobileComposerSwap } from './useMobileComposerSwap';
import { useChatTimelineController } from './hooks/useChatTimelineController';
import { createAssistantSessionDivider, mergeHostedCurrentSessionHistory, stitchHostedSessionHistory } from './hostedSessionHistory';
import type { ChatMessageEntry } from './lib/turns/types';
import {
    CHAT_TAIL_SPACER_DESKTOP_HEIGHT,
    CHAT_TAIL_SPACER_MOBILE_HEIGHT,
    CHAT_TAIL_SPACER_MOBILE_WITH_FOOT_INSET_HEIGHT,
} from './lib/scroll/chatTailSpacer';
import { TimelineDialog } from './TimelineDialog';
import { useChatTurnNavigation } from './hooks/useChatTurnNavigation';
import { useChatSurfaceMode } from './useChatSurfaceMode';
import { useMobileAppActions } from '@/apps/mobileAppContext';
import { Button } from '@/components/ui/button';
import { OverlayScrollbar } from '@/components/ui/OverlayScrollbar';
import { Icon } from "@/components/icon/Icon";
import { cn, formatDirectoryName } from '@/lib/utils';
import { getProviderModelDisplayName } from '@/lib/modelDisplay';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useConfigStore } from '@/stores/useConfigStore';

// New sync system imports
import { useSessionUIStore, type PendingUserMessagePresentation } from '@/sync/session-ui-store';
import { useStreamingStore } from '@/sync/streaming';
import {
    useSessionMessageCount,
    useSessionMessageLoadState,
    useSessionMessageRecords,
    useSessionMaterializationStatus,
    useSessionTranscriptHydration,
    useSessionTranscriptPagination,
    useSyncDirectory,
    useSessionStatus,
    useSessionStatusObservedAt,
    useSessionStatusSnapshotAt,
    useScopedBlockingPermissions,
    useScopedBlockingQuestions,
    useParentSessionTarget,
    useSession,
    useCurrentSessionEntity,
    setActiveSession,
} from '@/sync/sync-context';
import { useSync } from '@/sync/use-sync';
import {
    ensureTranscriptInitial,
    fetchTranscriptPreviousPage,
    getTranscriptRepository,
    refreshTranscriptFromAuthority,
    retryTranscriptInitial,
    transcriptScope,
} from '@/sync/transcript-repository-runtime';
import {
    recordTranscriptDiagnostics,
    recordTranscriptDiff,
    snapshotTranscriptDiagnostics,
    tryCaptureTranscriptCanonicalSnapshot,
} from '@/sync/transcript-diagnostics-runtime';
import {
    INITIAL_TRANSCRIPT_STALL_STATE,
    TRANSCRIPT_STALL_COOLDOWN_MS,
    TRANSCRIPT_STALL_MAX_ATTEMPTS,
    TRANSCRIPT_STALL_POLL_MS,
    TRANSCRIPT_STALL_THRESHOLD_MS,
    advanceTranscriptStallState,
    buildTranscriptTailFingerprint,
    reportTranscriptStall,
} from './transcriptStallWatchdog';

import { useRecoverPendingQuestions } from '@/hooks/useRecoverPendingQuestions';
import { useI18n } from '@/lib/i18n';
import { BusyDots } from './message/parts/BusyDots';
import { isMobileSurfaceRuntime } from '@/lib/runtimeSurface';
import { isVSCodeRuntime } from '@/lib/desktop';
import { useShallow } from 'zustand/react/shallow';
import { markSessionSwitchContentCommitted } from '@/lib/sessionSwitchPerf';
import { scheduleAfterPaintTask } from '@/lib/afterPaintTaskQueue';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import {
    applySessionViewSelectionIntent,
    commitMaterializedSessionView,
    createSessionViewRenderIntent,
    materializeSessionViewRenderIntent,
    recordSessionViewEstimate,
    reconcileSessionViewCache,
    resolveActiveSessionViewKey,
    type SessionViewCacheLimits,
    type SessionViewRenderState,
    type SessionViewSelection,
} from './sessionViewCache';
import { getEmbeddedSessionChatOriginSessionId } from '@/components/layout/contextPanelEmbeddedChat';
import { isFullySyntheticMessage } from '@/lib/messages/synthetic';
import { normalizeUserDisplayParts } from './message/normalizeUserDisplayParts';
import { findShellCommandForMessage, isUserShellMarkerMessage } from './lib/shellBridge';
import { resolveContextPanelSessionExecution } from '@/components/layout/contextPanelSessionExecution';
import {
    resolveChatPromptAvailability,
    resolveSessionIdentityPending,
    resolveSubagentReadOnlyBannerLatch,
    type SubagentReadOnlyBannerLatch,
} from './chatPromptAvailability';
import { shouldEnsureChatSessionRenderable } from './chatSessionMaterialization';

const EMPTY_MESSAGES: Array<{ info: Message; parts: Part[] }> = [];
const EMPTY_PENDING_USER_MESSAGES: readonly PendingUserMessagePresentation[] = [];
const IDLE_SESSION_STATUS = { type: 'idle' as const };
const CHAT_FORCE_SCROLL_BOTTOM_EVENT = 'openchamber:chat-force-scroll-bottom';
/** useEventListener attaches to window when target is null — pass a no-op getter instead. */
const NO_EVENT_TARGET = () => undefined;
const DEFAULT_RETRY_MESSAGE = 'Quota limit reached. Retrying automatically.';
const MEBIBYTE = 1024 * 1024;
const DEFAULT_SESSION_VIEW_ESTIMATED_BYTES = MEBIBYTE;
const SESSION_VIEW_MESSAGE_BUCKET_SIZE = 20;
const SESSION_VIEW_MESSAGE_BUCKET_BYTES = MEBIBYTE;
const MAX_SINGLE_SESSION_VIEW_ESTIMATED_BYTES = 16 * MEBIBYTE;
const DESKTOP_SESSION_VIEW_CACHE_LIMITS: SessionViewCacheLimits = {
    maxEntries: 3,
    maxEstimatedBytes: 32 * MEBIBYTE,
};
const CONSTRAINED_SESSION_VIEW_CACHE_LIMITS: SessionViewCacheLimits = {
    maxEntries: 2,
    maxEstimatedBytes: 32 * MEBIBYTE,
};
const subscribeRuntimeKey = (notify: () => void): (() => void) => {
    return subscribeRuntimeEndpointChanged(() => notify());
};
const CHAT_SCROLL_STYLE = {
    overflowAnchor: 'none',
    overscrollBehavior: 'contain',
    overscrollBehaviorY: 'contain',
} as const;
// The list owns its scroll element, so `data-scrollbar` / `data-scroll-shadow`
// cannot be declared in JSX on that path. Several consumers reach the chat
// scroller through `closest('[data-scrollbar="chat"]')`, and the chat scrollbar
// skin is keyed on it too. Stable identity: it feeds a ref callback.
const LEGEND_SCROLL_DATASET = { scrollbar: 'chat', scrollShadow: 'true', orientation: 'vertical' } as const;

const DesktopComposerEdgeFade: React.FC = () => (
    <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-full z-0 h-11 bg-gradient-to-t from-[var(--surface-background)] to-transparent"
    />
);
// Mobile head/foot clearance for the floating navigation header and composer.
// The old path takes this from CSS padding on the scroll container's content
// div. The list derives its content size analytically — measured header/footer
// plus padding read from *style objects*, never from classes — so CSS padding
// there would be invisible to its scroll math (`isAtEnd`, end maintenance).
// Measured spacers in the header/footer slots keep that math honest.
// The list subtracts the measured header (safe area + nav) and this
// footer from send-park usable height so the reserved hole is the
// middle window, not a leftover of the full immersive scroller.
const MOBILE_TIMELINE_HEAD_SPACER_HEIGHT = 'calc(max(0.625rem, var(--oc-safe-area-top, 0px)) + var(--oc-mobile-detail-navigation-height) + 1.25rem)';
const MOBILE_TIMELINE_FOOT_SPACER_HEIGHT = CHAT_TAIL_SPACER_MOBILE_WITH_FOOT_INSET_HEIGHT;
const CHAT_NAVIGATION_IGNORED_TARGET_SELECTOR = [
    'a[href]',
    'button',
    'input',
    'select',
    'textarea',
    '[contenteditable="true"]',
    '[role="button"]',
    '[role="combobox"]',
    '[role="dialog"]',
    '[role="listbox"]',
    '[role="menu"]',
    '[role="menuitem"]',
    '[role="option"]',
    '[role="textbox"]',
    '[data-radix-popper-content-wrapper]',
].join(',');
type SessionMessageRecord = { info: Message; parts: Part[] };

const isHTMLElement = (target: EventTarget | null): target is HTMLElement => {
    return target instanceof HTMLElement;
};

const shouldIgnoreChatNavigationTarget = (target: EventTarget | null): boolean => {
    if (!isHTMLElement(target)) {
        return false;
    }

    return Boolean(target.closest(CHAT_NAVIGATION_IGNORED_TARGET_SELECTOR));
};

const shouldIgnoreChatNavigationForFocus = (activeElement: Element | null, scrollContainer: HTMLElement | null): boolean => {
    if (typeof document === 'undefined') {
        return true;
    }

    if (!activeElement || activeElement === document.body || activeElement === document.documentElement) {
        return true;
    }

    if (shouldIgnoreChatNavigationTarget(activeElement)) {
        return true;
    }

    return !scrollContainer?.contains(activeElement);
};

const hasBlockingChatOverlay = (): boolean => {
    const {
        isAboutDialogOpen,
        isCommandPaletteOpen,
        isHelpDialogOpen,
        isImagePreviewOpen,
        isMultiRunLauncherOpen,
        isSessionSwitcherOpen,
        isSettingsDialogOpen,
    } = useUIStore.getState();

    return isAboutDialogOpen
        || isCommandPaletteOpen
        || isHelpDialogOpen
        || isImagePreviewOpen
        || isMultiRunLauncherOpen
        || isSessionSwitcherOpen
        || isSettingsDialogOpen;
};

type HydratingToolSkeletonRow = {
    id: string;
    titleWidth: string;
    detailWidth: string;
};

type ChatViewportProps = {
    currentSessionId: string;
    virtualizerKey: string;
    isDesktopExpandedInput: boolean;
    isMobile: boolean;
    stickyUserHeader: boolean;
    directory?: string;
    scrollRef: React.RefObject<HTMLDivElement | null>;
    messageListRef: React.RefObject<MessageListHandle | null>;
    pendingRevealWork: boolean;
    renderedMessages: SessionMessageRecord[];
    isLoadingOlder: boolean;
    sessionIsWorking: boolean;
    streamingMessageId: string | null;
    activeStreamingPhase: import('./message/types').StreamPhase | null;
    retryOverlay: {
        sessionId: string;
        message: string;
        confirmedAt?: number;
        fallbackTimestamp?: number;
    } | null;
    handleMessageContentChange: (reason?: ContentChangeReason) => void;
    getAnimationHandlers: (messageId: string) => AnimationHandlers;
    handleHistoryScroll: () => void;
    handleHistoryUpwardIntent: () => void;
    onTimelineIsAtEndChange: (isAtEnd: boolean, showScrollButton?: boolean) => void;
    timelineFollowSuspended: boolean;
    timelineHistoryAnchorToken: number;
    scrollToBottom: () => void;
    sessionQuestions: QuestionRequest[];
    sessionPermissions: PermissionRequest[];
    isProgrammaticFollowActive: boolean;
    showLoadOlderButton: boolean;
    onLoadOlder: () => void;
    turnIds: string[];
    activeTurnId: string | null;
    onSelectTurn: (turnId: string) => void;
    showPromptNavigator: boolean;
    canLoadEarlierPrompts: boolean;
    isLoadingOlderPrompts: boolean;
    onLoadEarlierPrompts: () => void;
};

const ChatViewport = React.memo(({
    currentSessionId,
    virtualizerKey,
    isDesktopExpandedInput,
    isMobile,
    stickyUserHeader,
    directory,
    scrollRef,
    messageListRef,
    pendingRevealWork,
    renderedMessages,
    isLoadingOlder,
    sessionIsWorking,
    streamingMessageId,
    activeStreamingPhase,
    retryOverlay,
    handleMessageContentChange,
    getAnimationHandlers,
    handleHistoryScroll,
    handleHistoryUpwardIntent,
    onTimelineIsAtEndChange,
    timelineFollowSuspended,
    timelineHistoryAnchorToken,
    scrollToBottom,
    sessionQuestions,
    sessionPermissions,
    isProgrammaticFollowActive,
    showLoadOlderButton,
    onLoadOlder,
    turnIds,
    activeTurnId,
    onSelectTurn,
    showPromptNavigator,
    canLoadEarlierPrompts,
    isLoadingOlderPrompts,
    onLoadEarlierPrompts,
}: ChatViewportProps) => {
    const { t } = useI18n();
    const legendTimelineEnabled = useFeatureFlagsStore((state) => state.legendTimelineEnabled);
    // Spinner/disabled is mutation-owned only (isLoadingOlder); background
    // prefetch/SWR loading never drives the button.
    const loadOlderBusy = resolveMobileLoadOlderBusy({ isLoadingOlder });
    // Desktop has no load-older button — show a restrained muted status while
    // scroll/auto-fill pagination is in flight so a long Host wait is not silent.
    const showDesktopLoadOlderStatus = resolveDesktopLoadOlderStatusVisibility({
        isMobile,
        isLoadingOlder: loadOlderBusy,
    });
    const promptPreviewsByTurnIdRef = React.useRef<Map<string, Part[]>>(new Map());
    // Cache normalized parts per source array so unchanged messages keep the
    // same reference and the memo below can bail out to the previous map.
    const normalizedPromptPartsCache = React.useRef(new WeakMap<Part[], Part[]>());
    // Shell-mode prompts show their extracted command; cache by message id so
    // the parts array reference is stable while the command is unchanged.
    const shellPreviewCache = React.useRef(new Map<string, { command: string; parts: Part[] }>());
    const promptPreviewsByTurnId = React.useMemo(() => {
        const next = new Map<string, Part[]>();
        for (let index = 0; index < renderedMessages.length; index += 1) {
            const message = renderedMessages[index];
            if (message.info.role !== 'user') {
                continue;
            }
            if (isUserShellMarkerMessage(message)) {
                const command = findShellCommandForMessage(renderedMessages, index) ?? '';
                const cached = shellPreviewCache.current.get(message.info.id);
                if (cached && cached.command === command) {
                    next.set(message.info.id, cached.parts);
                } else {
                    const parts = [{ type: 'text', text: command ? `$ ${command}` : '/shell' } as Part];
                    shellPreviewCache.current.set(message.info.id, { command, parts });
                    next.set(message.info.id, parts);
                }
                continue;
            }
            // Other fully synthetic user messages (loop continuations,
            // plan-mode injections) are not prompts the user typed — keep
            // them out of the navigator entirely.
            if (isFullySyntheticMessage(message.parts)) {
                continue;
            }
            let displayParts = normalizedPromptPartsCache.current.get(message.parts);
            if (!displayParts) {
                displayParts = normalizeUserDisplayParts(message.parts);
                normalizedPromptPartsCache.current.set(message.parts, displayParts);
            }
            if (displayParts.length === 0) {
                continue;
            }
            next.set(message.info.id, displayParts);
        }
        const prev = promptPreviewsByTurnIdRef.current;
        if (prev.size === next.size) {
            let unchanged = true;
            for (const [id, parts] of next) {
                if (prev.get(id) !== parts) {
                    unchanged = false;
                    break;
                }
            }
            if (unchanged) {
                return prev;
            }
        }
        promptPreviewsByTurnIdRef.current = next;
        return next;
    }, [renderedMessages]);
    // Only real (non-synthetic) prompts become rail entries; selection still
    // targets the same turn anchors as the timeline.
    const promptTurnIds = React.useMemo(
        () => turnIds.filter((id) => promptPreviewsByTurnId.has(id)),
        [promptPreviewsByTurnId, turnIds],
    );
    // If the viewport sits in a filtered-out (synthetic) turn, treat the
    // nearest preceding real prompt as active so the rail doesn't jump.
    const railActiveTurnId = React.useMemo(() => {
        if (!activeTurnId || promptPreviewsByTurnId.has(activeTurnId)) {
            return activeTurnId;
        }
        const activeIndex = turnIds.indexOf(activeTurnId);
        for (let index = activeIndex - 1; index >= 0; index -= 1) {
            const turnId = turnIds[index];
            if (promptPreviewsByTurnId.has(turnId)) {
                return turnId;
            }
        }
        return null;
    }, [activeTurnId, promptPreviewsByTurnId, turnIds]);
    const focusScrollContainer = useEvent((event: React.MouseEvent<HTMLElement>) => {
        if (event.defaultPrevented || shouldIgnoreChatNavigationTarget(event.target)) {
            return;
        }

        if (typeof window !== 'undefined' && window.getSelection()?.type === 'Range') {
            return;
        }

        scrollRef.current?.focus({ preventScroll: true });
    });

    // Auto-follow is off on the legend path, and it used to be what listened for
    // explicit upward gestures. Without this, reaching the top would stop firing
    // scroll events and earlier history could never be requested again.
    useHistoryUpwardIntent({
        scrollRef,
        enabled: legendTimelineEnabled,
        onUpwardIntent: handleHistoryUpwardIntent,
    });

    if (legendTimelineEnabled) {
        return (
            <div
                className={cn(
                    'relative min-h-0',
                    isDesktopExpandedInput
                        ? 'absolute inset-0 opacity-0 pointer-events-none'
                        : 'flex-1'
                )}
                aria-hidden={isDesktopExpandedInput}
            >
                <div className="absolute inset-0">
                    <MessageList
                        ref={messageListRef}
                        sessionKey={currentSessionId}
                        virtualizerKey={virtualizerKey}
                        disableStaging={pendingRevealWork}
                        messages={renderedMessages}
                        sessionIsWorking={sessionIsWorking}
                        activeStreamingMessageId={streamingMessageId}
                        activeStreamingPhase={activeStreamingPhase}
                        retryOverlay={retryOverlay}
                        onMessageContentChange={handleMessageContentChange}
                        getAnimationHandlers={getAnimationHandlers}
                        isLoadingOlder={isLoadingOlder}
                        scrollToBottom={scrollToBottom}
                        scrollRef={scrollRef}
                        directory={directory}
                        timelineScrollClassName="absolute inset-0 z-0 chat-scroll overlay-scrollbar-target"
                        timelineScrollStyle={CHAT_SCROLL_STYLE}
                        timelineScrollDataset={LEGEND_SCROLL_DATASET}
                        timelineOnScroll={handleHistoryScroll}
                        timelineFollowEnabled={!pendingRevealWork && !timelineFollowSuspended}
                        timelineHistoryAnchorToken={timelineHistoryAnchorToken}
                        timelineOnIsAtEndChange={onTimelineIsAtEndChange}
                        headerSlot={(
                            <>
                                {isMobile && (
                                    <div
                                        className="flex-shrink-0"
                                        style={{ height: MOBILE_TIMELINE_HEAD_SPACER_HEIGHT }}
                                        aria-hidden="true"
                                    />
                                )}
                                {showLoadOlderButton && (
                                    <div className="flex justify-center pt-3 pb-1">
                                        <Button
                                            variant="secondary"
                                            size="sm"
                                            onClick={onLoadOlder}
                                            disabled={loadOlderBusy}
                                            aria-busy={loadOlderBusy}
                                        >
                                            {loadOlderBusy && (
                                                <Icon name="loader-4" className="size-4 animate-spin" />
                                            )}
                                            {t('chat.history.loadOlder')}
                                        </Button>
                                    </div>
                                )}
                                {showDesktopLoadOlderStatus && (
                                    <div
                                        className="absolute inset-x-0 top-0 z-20 flex justify-center pointer-events-none"
                                        role="status"
                                        aria-live="polite"
                                    >
                                        <div className="flex items-center justify-center gap-1.5 pt-3 pb-1">
                                            <Icon
                                                name="loader-4"
                                                className="size-3.5 animate-spin text-[var(--surface-mutedForeground)]"
                                                aria-hidden="true"
                                            />
                                            <span className="typography-meta text-[var(--surface-mutedForeground)]">
                                                {t('chat.history.loadingMore')}
                                            </span>
                                        </div>
                                    </div>
                                )}
                            </>
                        )}
                        footerSlot={(
                            <>
                                {(sessionQuestions.length > 0 || sessionPermissions.length > 0) && (
                                    <div>
                                        {sessionQuestions.map((question) => (
                                            <QuestionCard key={question.id} question={question} />
                                        ))}
                                        {sessionPermissions.map((permission) => (
                                            <PermissionCard key={permission.id} permission={permission} />
                                        ))}
                                    </div>
                                )}

                                <div
                                    className="flex-shrink-0"
                                    style={{ height: isMobile ? MOBILE_TIMELINE_FOOT_SPACER_HEIGHT : CHAT_TAIL_SPACER_DESKTOP_HEIGHT }}
                                    aria-hidden="true"
                                />
                            </>
                        )}
                    />
                    <OverlayScrollbar containerRef={scrollRef} suppressVisibility={isProgrammaticFollowActive} userIntentOnly observeMutations={false} />
                    {showPromptNavigator && promptTurnIds.length >= 2 ? (
                        <PromptNavigatorRail
                            turnIds={promptTurnIds}
                            previewsByTurnId={promptPreviewsByTurnId}
                            activeTurnId={railActiveTurnId}
                            onSelectTurn={onSelectTurn}
                            canLoadEarlier={canLoadEarlierPrompts}
                            isLoadingOlder={isLoadingOlderPrompts}
                            onLoadEarlier={onLoadEarlierPrompts}
                        />
                    ) : null}
                </div>
            </div>
        );
    }

    return (
        <div
            className={cn(
                'relative min-h-0',
                isDesktopExpandedInput
                    ? 'absolute inset-0 opacity-0 pointer-events-none'
                    : 'flex-1'
            )}
            aria-hidden={isDesktopExpandedInput}
        >
            <div className="absolute inset-0">
                <ScrollShadow
                    className={cn(
                        'absolute inset-0 overflow-y-auto overflow-x-hidden z-0 chat-scroll overlay-scrollbar-target',
                    )}
                    ref={scrollRef}
                    style={CHAT_SCROLL_STYLE}
                    observeMutations={false}
                    hideTopShadow={isMobile && stickyUserHeader}
                    // Mobile: the composer is a solid page foot — a bottom scroll
                    // mask reads as a soft full-width edge under the last messages.
                    hideBottomShadow={isMobile}
                    tabIndex={0}
                    onClick={focusScrollContainer}
                    onScroll={handleHistoryScroll}
                    data-scroll-shadow="true"
                    data-scrollbar="chat"
                >
                    <div className={cn('oc-chat-scroll-content relative z-0 min-h-full', isMobile && 'chat-scroll-foot-inset')}>
                        {showLoadOlderButton && (
                            <div className="flex justify-center pt-3 pb-1">
                                <Button
                                    variant="secondary"
                                    size="sm"
                                    onClick={onLoadOlder}
                                    disabled={loadOlderBusy}
                                    aria-busy={loadOlderBusy}
                                >
                                    {loadOlderBusy && (
                                        <Icon name="loader-4" className="size-4 animate-spin" />
                                    )}
                                    {t('chat.history.loadOlder')}
                                </Button>
                            </div>
                        )}
                        {showDesktopLoadOlderStatus && (
                            <div
                                className="absolute inset-x-0 top-0 z-20 flex justify-center pointer-events-none"
                                role="status"
                                aria-live="polite"
                            >
                                <div className="flex items-center justify-center gap-1.5 pt-3 pb-1">
                                    <Icon
                                        name="loader-4"
                                        className="size-3.5 animate-spin text-[var(--surface-mutedForeground)]"
                                        aria-hidden="true"
                                    />
                                    <span className="typography-meta text-[var(--surface-mutedForeground)]">
                                        {t('chat.history.loadingMore')}
                                    </span>
                                </div>
                            </div>
                        )}
                        <MessageList
                            ref={messageListRef}
                            sessionKey={currentSessionId}
                            virtualizerKey={virtualizerKey}
                            disableStaging={pendingRevealWork}
                            messages={renderedMessages}
                            sessionIsWorking={sessionIsWorking}
                            activeStreamingMessageId={streamingMessageId}
                            activeStreamingPhase={activeStreamingPhase}
                            retryOverlay={retryOverlay}
                            onMessageContentChange={handleMessageContentChange}
                            getAnimationHandlers={getAnimationHandlers}
                            isLoadingOlder={isLoadingOlder}
                            scrollToBottom={scrollToBottom}
                            scrollRef={scrollRef}
                            directory={directory}
                        />
                        {(sessionQuestions.length > 0 || sessionPermissions.length > 0) && (
                            <div>
                                {sessionQuestions.map((question) => (
                                    <QuestionCard key={question.id} question={question} />
                                ))}
                                {sessionPermissions.map((permission) => (
                                    <PermissionCard key={permission.id} permission={permission} />
                                ))}
                            </div>
                        )}

                        <div className="mb-1">
                            <StatusRowContainer />
                        </div>

                        {/* The chrome reservation itself comes from
                            `.chat-scroll-foot-inset` padding on this content
                            wrapper, so the tail here is the breathing room only. */}
                        <div
                            className="flex-shrink-0"
                            style={{ height: isMobile ? CHAT_TAIL_SPACER_MOBILE_HEIGHT : CHAT_TAIL_SPACER_DESKTOP_HEIGHT }}
                            aria-hidden="true"
                        />
                    </div>
                </ScrollShadow>
                <OverlayScrollbar containerRef={scrollRef} suppressVisibility={isProgrammaticFollowActive} userIntentOnly observeMutations={false} />
                {showPromptNavigator && promptTurnIds.length >= 2 ? (
                    <PromptNavigatorRail
                        turnIds={promptTurnIds}
                        previewsByTurnId={promptPreviewsByTurnId}
                        activeTurnId={railActiveTurnId}
                        onSelectTurn={onSelectTurn}
                        canLoadEarlier={canLoadEarlierPrompts}
                        isLoadingOlder={isLoadingOlderPrompts}
                        onLoadEarlier={onLoadEarlierPrompts}
                    />
                ) : null}
            </div>
        </div>
    );
}, (prev, next) => {
    return prev.currentSessionId === next.currentSessionId
        && prev.virtualizerKey === next.virtualizerKey
        && prev.isDesktopExpandedInput === next.isDesktopExpandedInput
        && prev.isMobile === next.isMobile
        && prev.stickyUserHeader === next.stickyUserHeader
        && prev.directory === next.directory
        && prev.scrollRef === next.scrollRef
        && prev.messageListRef === next.messageListRef
        && prev.pendingRevealWork === next.pendingRevealWork
        && prev.renderedMessages === next.renderedMessages
        && prev.isLoadingOlder === next.isLoadingOlder
        && prev.sessionIsWorking === next.sessionIsWorking
        && prev.streamingMessageId === next.streamingMessageId
        && prev.activeStreamingPhase === next.activeStreamingPhase
        && prev.retryOverlay === next.retryOverlay
        && prev.handleMessageContentChange === next.handleMessageContentChange
        && prev.getAnimationHandlers === next.getAnimationHandlers
        && prev.handleHistoryScroll === next.handleHistoryScroll
        && prev.handleHistoryUpwardIntent === next.handleHistoryUpwardIntent
        && prev.onTimelineIsAtEndChange === next.onTimelineIsAtEndChange
        && prev.timelineFollowSuspended === next.timelineFollowSuspended
        && prev.timelineHistoryAnchorToken === next.timelineHistoryAnchorToken
        && prev.scrollToBottom === next.scrollToBottom
        && prev.sessionQuestions === next.sessionQuestions
        && prev.sessionPermissions === next.sessionPermissions
        && prev.isProgrammaticFollowActive === next.isProgrammaticFollowActive
        && prev.showLoadOlderButton === next.showLoadOlderButton
        && prev.onLoadOlder === next.onLoadOlder
        && prev.turnIds === next.turnIds
        && prev.activeTurnId === next.activeTurnId
        && prev.onSelectTurn === next.onSelectTurn
        && prev.showPromptNavigator === next.showPromptNavigator
        && prev.canLoadEarlierPrompts === next.canLoadEarlierPrompts
        && prev.isLoadingOlderPrompts === next.isLoadingOlderPrompts
        && prev.onLoadEarlierPrompts === next.onLoadEarlierPrompts;
});

ChatViewport.displayName = 'ChatViewport';

const HYDRATING_SKELETON_ITEMS: Array<{
    id: number;
    toolRows: HydratingToolSkeletonRow[];
    textWidths: [string, string, string];
}> = [
    {
        id: 1,
        toolRows: [
            { id: 'search', titleWidth: 'w-24', detailWidth: 'w-52' },
            { id: 'read', titleWidth: 'w-20', detailWidth: 'w-36' },
            { id: 'edit', titleWidth: 'w-24', detailWidth: 'w-64' },
        ],
        textWidths: ['w-24', 'w-[92%]', 'w-[78%]'],
    },
    {
        id: 2,
        toolRows: [
            { id: 'read', titleWidth: 'w-20', detailWidth: 'w-40' },
            { id: 'search', titleWidth: 'w-24', detailWidth: 'w-48' },
        ],
        textWidths: ['w-20', 'w-[88%]', 'w-[70%]'],
    },
    {
        id: 3,
        toolRows: [
            { id: 'shell', titleWidth: 'w-28', detailWidth: 'w-44' },
            { id: 'edit', titleWidth: 'w-24', detailWidth: 'w-56' },
        ],
        textWidths: ['w-24', 'w-[84%]', 'w-[64%]'],
    },
];

const getProjectDisplayLabel = (project: { label?: string; path: string }): string => {
    return formatDirectoryName(project.path);
};

const renderDraftTitle = (title: string, projectLabel: string | null): React.ReactNode => {
    if (!projectLabel) return title;
    const projectIndex = title.indexOf(projectLabel);
    if (projectIndex === -1) return title;

    return (
        <>
            {title.slice(0, projectIndex)}
            <span className="font-medium">{projectLabel}</span>
            {title.slice(projectIndex + projectLabel.length)}
        </>
    );
};

type ChatContainerProps = {
    autoOpenDraft?: boolean;
    readOnly?: boolean;
    active?: boolean;
    host?: ChatContainerHost;
    /** Binds one phone navigation page to an explicit route and skips the primary retained-view cache. */
    explicitSession?: {
        sessionId: string | null;
        directory: string | null;
        viewKey: string;
        active: boolean;
    };
};

type ChatContainerContentProps = Omit<ChatContainerProps, 'host'> & {
    sessionId: string | null;
    sessionDirectory: string | null;
    sessionViewKey?: string;
    onSessionViewEstimateChange?: (key: string, estimatedBytes: number) => void;
    composerSurface?: ChatInputSurface;
    hostedFeatures?: Required<ChatContainerHostFeatures>;
    assistantHistory?: ChatContainerHost['assistantHistory'];
    onRevertMessage?: (messageId: string) => Promise<void>;
    warning?: string | null;
    pendingUserMessages?: readonly PendingUserMessagePresentation[];
    onPendingUserMessagesMaterialized?: (messageIDs: readonly string[]) => void;
};

const estimateSessionViewBytes = (messageCount: number): number => {
    const messageBuckets = Math.ceil(Math.max(0, messageCount) / SESSION_VIEW_MESSAGE_BUCKET_SIZE);
    return Math.min(
        MAX_SINGLE_SESSION_VIEW_ESTIMATED_BYTES,
        DEFAULT_SESSION_VIEW_ESTIMATED_BYTES + messageBuckets * SESSION_VIEW_MESSAGE_BUCKET_BYTES,
    );
};

const ChatContainerContent: React.FC<ChatContainerContentProps> = ({
    autoOpenDraft = true,
    readOnly = false,
    active = true,
    sessionId: currentSessionId,
    sessionDirectory: currentSessionDirectory,
    sessionViewKey,
    onSessionViewEstimateChange,
    composerSurface,
    hostedFeatures,
    assistantHistory,
    onRevertMessage,
    warning = null,
    pendingUserMessages: hostPendingUserMessages = EMPTY_PENDING_USER_MESSAGES,
    onPendingUserMessagesMaterialized,
}) => {
    const hostFeatures = hostedFeatures ?? resolveChatContainerHostFeatures(undefined);
    const { t } = useI18n();
    useIsomorphicLayoutEffect(() => {
        markSessionSwitchContentCommitted();
    }, []);
    // Session UI state
    const openNewSessionDraft = useSessionUIStore((s) => s.openNewSessionDraft);
    const setCurrentSession = useSessionUIStore((s) => s.setCurrentSession);
    const newSessionDraft = useSessionUIStore((s) => s.newSessionDraft);
    const draftSubmitting = useSessionUIStore((s) => s.newSessionDraft.draftSubmitting ?? false);
    const draftEstablishing = useSessionUIStore((s) => s.newSessionDraft.draftEstablishing ?? false);
    const forkTransition = useSessionUIStore((s) => s.forkTransition);
    const projects = useProjectsStore((s) => s.projects);
    const activeProjectId = useProjectsStore((s) => s.activeProjectId);
    const providers = useConfigStore((state) => state.providers);

    // Sync actions
    const sync = useSync();
    const syncDirectory = useSyncDirectory();
    const effectiveSessionDirectory = currentSessionDirectory ?? syncDirectory;
    // Hosted surfaces (Assistant) never call setCurrentSession, so without this
    // orphaned SSE part events fall back to the primary chat directory and the
    // assistant store never receives user text parts. Layout-phase so routing is
    // ready before paint/event delivery (same contract as timeline DOM sync).
    useIsomorphicLayoutEffect(() => {
        if (!active || !currentSessionId || !effectiveSessionDirectory) return;
        setActiveSession(effectiveSessionDirectory, currentSessionId);
    }, [active, currentSessionId, effectiveSessionDirectory]);
    const ensureSessionRenderable = useEvent(
        (sessionId: string) => sync.ensureSessionRenderable(sessionId, { directory: effectiveSessionDirectory }),
    );

    // UI store
    const isExpandedInput = useUIStore((state) => state.isExpandedInput);
    const stickyUserHeader = useUIStore((state) => state.stickyUserHeader);
    const promptNavigatorEnabled = useUIStore((state) => state.promptNavigatorEnabled);
    const allowPromptingSubagentSessions = useUIStore((state) => state.allowPromptingSubagentSessions);
    const isTimelineDialogOpen = useUIStore((s) => s.isTimelineDialogOpen);
    const setTimelineDialogOpen = useUIStore((s) => s.setTimelineDialogOpen);

    // Streaming state — ordinary selectors (never useCallback; store compares selected values).
    const streamingMessageId = useStreamingStore(
        (s) => (active && currentSessionId ? s.streamingMessageIds.get(currentSessionId) ?? null : null),
    );
    const activeStreamingPhase = useStreamingStore(
        (s) => {
            if (!streamingMessageId) return null;
            return s.messageStreamStates.get(streamingMessageId)?.phase ?? null;
        },
    );
    const sessionMessageCount = useSessionMessageCount(currentSessionId ?? '', effectiveSessionDirectory);
    const sessionViewEstimatedBytes = estimateSessionViewBytes(sessionMessageCount);
    React.useEffect(() => {
        if (!sessionViewKey || !onSessionViewEstimateChange) {
            return;
        }
        onSessionViewEstimateChange(sessionViewKey, sessionViewEstimatedBytes);
    }, [onSessionViewEstimateChange, sessionViewEstimatedBytes, sessionViewKey]);
    const hasRenderableSessionSnapshot = useSessionMaterializationStatus(
        currentSessionId ?? '',
        effectiveSessionDirectory,
    ).renderable;
    const directorySessionEntity = useSession(currentSessionId, effectiveSessionDirectory);
    // Global/live fallback covers sessions whose directory list row is lagging
    // or lives under another selected workspace while messages already load.
    const liveSessionEntity = useCurrentSessionEntity(currentSessionId);
    const currentSessionEntity = directorySessionEntity ?? liveSessionEntity;
    // Primary chat blocks send only while identity is still unproven. A missing
    // directory list row must not permanently disable the composer once the
    // session is materializable (or known via live/global entity). Hosted
    // secondary surfaces never use this gate.
    const sessionIdentityPending = resolveSessionIdentityPending({
        sessionId: currentSessionId,
        hasSessionEntity: Boolean(currentSessionEntity),
        hasRenderableSessionSnapshot,
        composerSurfaceKind: composerSurface?.kind,
    });
    const sessionIdentityEnsureKey = currentSessionId
        ? JSON.stringify([effectiveSessionDirectory, currentSessionId])
        : null;
    const [sessionIdentityEnsureRetry, setSessionIdentityEnsureRetry] = React.useState<{
        key: string | null;
        attempt: number;
    }>({ key: sessionIdentityEnsureKey, attempt: 0 });
    // Messages from sync system
    const sessionMessageRecords = useSessionMessageRecords(currentSessionId ?? '', effectiveSessionDirectory, {
        suspendPartUpdates: Boolean(streamingMessageId),
        suspendPartUpdatesForMessageId: streamingMessageId,
    });
    const sessionMessages = currentSessionId ? sessionMessageRecords : EMPTY_MESSAGES;
    const draftPendingMessage = newSessionDraft.pendingUserMessage;
    // Rows the send path retained for this session until their authoritative
    // records land. This is what keeps a just-sent message on screen across the
    // draft → real session handover without any confirmation request.
    const retainedPendingUserMessages = useSessionUIStore(
        (state) => (currentSessionId ? state.retainedPendingUserMessages.get(currentSessionId) : undefined),
    ) ?? EMPTY_PENDING_USER_MESSAGES;
    const clearRetainedPendingUserMessages = useSessionUIStore((state) => state.clearRetainedPendingUserMessages);
    const pendingUserMessages = React.useMemo(() => {
        if (retainedPendingUserMessages.length === 0) return hostPendingUserMessages;
        if (hostPendingUserMessages.length === 0) return retainedPendingUserMessages;
        const hosted = new Set(hostPendingUserMessages.map((message) => message.info.id));
        return [
            ...hostPendingUserMessages,
            ...retainedPendingUserMessages.filter((message) => !hosted.has(message.info.id)),
        ];
    }, [hostPendingUserMessages, retainedPendingUserMessages]);
    const sessionExecution = React.useMemo(
        () => resolveContextPanelSessionExecution(sessionMessages),
        [sessionMessages],
    );
    const sessionExecutionModelName = React.useMemo(() => {
        if (!sessionExecution.modelId) return t('common.unavailable');
        const provider = providers.find((entry) => entry.id === sessionExecution.providerId);
        // Always go through display helper so missing catalog entries humanize
        // (e.g. deepseek-v4-flash → "DeepSeek V4 Flash") instead of raw ids.
        return getProviderModelDisplayName(provider, sessionExecution.modelId) || sessionExecution.modelId;
    }, [providers, sessionExecution.modelId, sessionExecution.providerId, t]);
    // useMemo callback factories for useSyncExternalStore (stable identity; never useCallback).
    // Ticket 09: request lifecycle from repository (no session-prefetch).
    const sessionPrefetchInfo = useSessionMessageLoadState(
        currentSessionId ?? '',
        effectiveSessionDirectory,
    );
    const transcriptHydration = useSessionTranscriptHydration(
        currentSessionId ?? '',
        effectiveSessionDirectory,
    );
    const [retryingSessionHistoryId, setRetryingSessionHistoryId] = React.useState<string | null>(null);
    const isRetryingSessionHistory = Boolean(currentSessionId)
        && retryingSessionHistoryId === currentSessionId;
    const retrySessionHistory = useEvent(() => {
        if (!currentSessionId || isRetryingSessionHistory) return;
        const sessionId = currentSessionId;
        const directory = effectiveSessionDirectory;
        setRetryingSessionHistoryId(sessionId);
        const refreshDiffBefore = tryCaptureTranscriptCanonicalSnapshot(() => {
            const repository = getTranscriptRepository();
            if (!repository) throw new Error('unbound');
            return repository.getTranscript(transcriptScope(directory, sessionId));
        });
        recordTranscriptDiagnostics(snapshotTranscriptDiagnostics({
            kind: 'refresh',
            sessionID: sessionId,
            directory,
            purpose: 'retry',
            source: 'network',
            request: sessionPrefetchInfo
                ? {
                    sessionID: sessionId,
                    status: sessionPrefetchInfo.status === 'ready' ? 'ready' : sessionPrefetchInfo.status,
                    error: sessionPrefetchInfo.error,
                }
                : undefined,
            hydration: transcriptHydration,
            error: sessionPrefetchInfo?.error,
        }));
        void (async () => {
            try {
                await retryTranscriptInitial(directory, sessionId);
                await sync.ensureSessionRenderable(sessionId, { directory });
                try {
                    const refreshDiffAfter = tryCaptureTranscriptCanonicalSnapshot(() => {
                        const repository = getTranscriptRepository();
                        if (!repository) throw new Error('unbound');
                        return repository.getTranscript(transcriptScope(directory, sessionId));
                    });
                    if (refreshDiffBefore && refreshDiffAfter) {
                        recordTranscriptDiff({
                            trigger: 'user-refresh',
                            sessionID: sessionId,
                            directory,
                            purpose: 'retry',
                            before: refreshDiffBefore,
                            after: refreshDiffAfter,
                        });
                    }
                } catch {
                    // Diagnostics must never affect retry.
                }
            } catch (error) {
                recordTranscriptDiagnostics(snapshotTranscriptDiagnostics({
                    kind: 'request-error',
                    sessionID: sessionId,
                    directory,
                    purpose: 'retry',
                    source: 'network',
                    hydration: transcriptHydration,
                    error,
                }));
            } finally {
                setRetryingSessionHistoryId((current) => (current === sessionId ? null : current));
            }
        })();
    });
    // Ticket 02: pagination from TranscriptRepository.getPagination projection.
    // Boundary-only commits still re-render via repository subscribe.
    const transcriptPagination = useSessionTranscriptPagination(
        currentSessionId ?? '',
        effectiveSessionDirectory,
    );
    const historyBoundary = transcriptPagination.boundary;
    const loadMoreMessages = useEvent(async (sessionId: string) => {
        // Ticket 09: Query fetchPreviousPage is the sole history flight.
        if (historyBoundary.kind === 'has-more') {
            await fetchTranscriptPreviousPage(effectiveSessionDirectory, sessionId);
            return;
        }
        if (historyBoundary.kind === 'unknown') {
            // Ensure authoritative tail; background SWR also converges.
            await ensureTranscriptInitial(effectiveSessionDirectory, sessionId);
            return;
        }
        // Only page assistant-owned archives after live pagination is authoritative-complete.
        if (assistantHistory && !assistantHistory.complete) {
            await assistantHistory.fetchPrevious();
        }
    });

    // Session status from sync system
    const resolvedSessionStatus = useSessionStatus(currentSessionId ?? '', effectiveSessionDirectory);
    const sessionStatusObservedAt = useSessionStatusObservedAt(currentSessionId ?? '', effectiveSessionDirectory);
    const sessionStatusSnapshotAt = useSessionStatusSnapshotAt(effectiveSessionDirectory);
    const sessionStatusForCurrent = resolvedSessionStatus ?? IDLE_SESSION_STATUS;

    // Scoped blocking requests — only subscribe to permissions/questions for
    // the current session + descendant subagent sessions, not all sessions in
    // the directory.
    const sessionPermissions = useScopedBlockingPermissions(currentSessionId, effectiveSessionDirectory);
    const sessionQuestions = useScopedBlockingQuestions(currentSessionId, effectiveSessionDirectory);
    useRecoverPendingQuestions(
        currentSessionId,
        effectiveSessionDirectory,
        sessionMessages,
        sessionQuestions.length,
    );

    const sessionIsWorking = React.useMemo(() => {
        if (!currentSessionId || sessionPermissions.length > 0 || sessionQuestions.length > 0) {
            return false;
        }

        const statusType = sessionStatusForCurrent.type ?? 'idle';
        if (statusType === 'busy' || statusType === 'retry') {
            return true;
        }

        // Host + retained pending rows imply work only until status has clearly
        // finished this send (fresh idle at/after newest pending created). A
        // retained presentation may still paint after working clears.
        if (pendingUserMessagesImplyWorking(pendingUserMessages, {
            resolvedSessionStatus,
            sessionStatusObservedAt,
        })) {
            return true;
        }

        const lastMessage = sessionMessages[sessionMessages.length - 1]?.info as Message | undefined;
        const lastMessageStartedAt = (lastMessage as { time?: { created?: number } } | undefined)?.time?.created;
        if (
            resolvedSessionStatus
            && typeof sessionStatusObservedAt === 'number'
            && typeof lastMessageStartedAt === 'number'
            && lastMessageStartedAt <= sessionStatusObservedAt
        ) {
            return false;
        }

        if (
            typeof sessionStatusSnapshotAt === 'number'
            && typeof lastMessageStartedAt === 'number'
            && lastMessageStartedAt <= sessionStatusSnapshotAt
        ) {
            return false;
        }
        return Boolean(
            lastMessage
            && lastMessage.role === 'assistant'
            && typeof (lastMessage as { time?: { completed?: number } }).time?.completed !== 'number',
        );
    }, [currentSessionId, pendingUserMessages, resolvedSessionStatus, sessionMessages, sessionPermissions.length, sessionQuestions.length, sessionStatusForCurrent.type, sessionStatusObservedAt, sessionStatusSnapshotAt]);
    const activeRetryStatus = React.useMemo(() => {
        if (!currentSessionId || sessionStatusForCurrent.type !== 'retry') {
            return null;
        }

        const rawMessage = typeof (sessionStatusForCurrent as { message?: string }).message === 'string'
            ? (((sessionStatusForCurrent as { message?: string }).message) ?? '').trim()
            : '';

        return {
            sessionId: currentSessionId,
            message: rawMessage || DEFAULT_RETRY_MESSAGE,
            confirmedAt: (sessionStatusForCurrent as { confirmedAt?: number }).confirmedAt,
        };
    }, [currentSessionId, sessionStatusForCurrent]);
    const [retryFallbackTimestamp, setRetryFallbackTimestamp] = React.useState<number>(0);
    const retryFallbackSessionRef = React.useRef<string | null>(null);

    React.useEffect(() => {
        if (!activeRetryStatus || typeof activeRetryStatus.confirmedAt === 'number') {
            retryFallbackSessionRef.current = null;
            setRetryFallbackTimestamp(0);
            return;
        }

        if (retryFallbackSessionRef.current !== activeRetryStatus.sessionId) {
            retryFallbackSessionRef.current = activeRetryStatus.sessionId;
            setRetryFallbackTimestamp(Date.now());
        }
    }, [activeRetryStatus]);

    const retryOverlay = React.useMemo(() => {
        if (!activeRetryStatus) {
            return null;
        }

        return {
            ...activeRetryStatus,
            fallbackTimestamp: retryFallbackTimestamp,
        };
    }, [activeRetryStatus, retryFallbackTimestamp]);

    // History metadata — boundary facts from the directory child store; request
    // lifecycle (loading) stays on sync/assistant page flights but never feeds
    // canLoadEarlier/complete/limit. Prefetch status is cold-transcript only.
    // Read syncLoading during render (not only inside useMemo) so a loadingRef
    // flip that rebuilds `sync` always invalidates this memo — a cached
    // `loading: true` after the flight cleared blocked load-older for the full
    // wait window with nothing in the network panel.
    const syncHistoryLoading = Boolean(
        currentSessionId
        && sync.isLoading(currentSessionId, { directory: effectiveSessionDirectory }),
    );
    const historyMeta = React.useMemo(() => {
        if (!currentSessionId) return null;
        const loadState = resolveChatHistoryLoadState({
            boundary: historyBoundary,
            assistantComplete: assistantHistory?.complete ?? true,
        });
        return {
            // Product limit is cumulative authored-user turns (the boundary's
            // loadedTurns), not message count.
            limit: historyBoundary.loadedTurns,
            complete: loadState.complete,
            canLoadEarlier: loadState.canLoadEarlier,
            // Concurrent-page wait gate for the timeline only (sync.isLoading /
            // assistant archive). Never OR sessionPrefetch status — it can stick
            // at loading on Relay and blocked user loadMore for the historyLoading
            // wait window with toast and zero fetch. Button spinner stays
            // mutation-owned separately.
            loading: resolveChatHistoryPaginationLoading({
                syncLoading: syncHistoryLoading,
                assistantLoading: Boolean(assistantHistory?.loading),
            }),
        };
    }, [
        assistantHistory?.complete,
        assistantHistory?.loading,
        currentSessionId,
        historyBoundary,
        syncHistoryLoading,
    ]);

    const isMobile = useUIStore((state) => state.isMobile);
    const isDedicatedMobileApp = useMobileAppActions() !== null;
    const isVSCode = isVSCodeRuntime();
    const chatSurfaceMode = useChatSurfaceMode();
    const draftOpen = Boolean(newSessionDraft?.open);
    const initError = useGlobalSyncStore((s) => s.error);
    // Despite the historical name, this now covers mobile too: the mobile
    // composer enters the same fullscreen-input mode via its drag handle.
    const isDesktopExpandedInput = isExpandedInput;
    const useCompactDraftLayout = isDedicatedMobileApp || isMobile || isVSCode || chatSurfaceMode === 'mini-chat';
    const messageListRef = React.useRef<MessageListHandle | null>(null);
    const draftProjectLabel = React.useMemo(() => {
        const selectedProject = newSessionDraft?.selectedProjectId
            ? projects.find((project) => project.id === newSessionDraft.selectedProjectId) ?? null
            : null;
        const activeProject = activeProjectId
            ? projects.find((project) => project.id === activeProjectId) ?? null
            : null;
        const project = selectedProject ?? activeProject ?? projects[0] ?? null;
        return project ? getProjectDisplayLabel(project) : null;
    }, [activeProjectId, newSessionDraft?.selectedProjectId, projects]);

    const parentSessionTarget = useParentSessionTarget(currentSessionId, effectiveSessionDirectory);
    // Subagent rows leave the live directory list on session.updated; keep the
    // confirmed footer parent + agent/model through that gap (mobile nested
    // pages share this ChatContainer path).
    const subagentBannerViewKey = sessionViewKey ?? currentSessionId ?? '';
    const [subagentBannerLatch, setSubagentBannerLatch] = React.useState<SubagentReadOnlyBannerLatch<NonNullable<typeof parentSessionTarget>> | null>(null);
    const nextSubagentBannerLatch = resolveSubagentReadOnlyBannerLatch(
        subagentBannerLatch,
        subagentBannerViewKey,
        parentSessionTarget,
        sessionExecution,
    );
    useIsomorphicLayoutEffect(() => {
        setSubagentBannerLatch((previous) => resolveSubagentReadOnlyBannerLatch(
            previous,
            subagentBannerViewKey,
            parentSessionTarget,
            sessionExecution,
        ));
    }, [parentSessionTarget, sessionExecution, subagentBannerViewKey]);
    const resolvedParentSessionTarget = parentSessionTarget ?? nextSubagentBannerLatch?.parentTarget ?? null;
    const bannerExecution = nextSubagentBannerLatch?.execution ?? sessionExecution;

    // In the embedded session-chat iframe, hide "Return to parent" when
    // viewing the panel's anchor session (the one recorded in the URL). Going
    // up from the anchor would show the primary session that's already in the
    // main chat. Drilling into a deeper subtask (currentSessionId ≠ anchor)
    // re-enables the button to navigate back to the embedded session.
    const embeddedPanelAnchorSessionId = getEmbeddedSessionChatOriginSessionId();
    const hideReturnToParent =
        embeddedPanelAnchorSessionId !== null && currentSessionId === embeddedPanelAnchorSessionId;

    const handleReturnToParentSession = useEvent(() => {
        if (!resolvedParentSessionTarget) return;
        setCurrentSession(resolvedParentSessionTarget.id, resolvedParentSessionTarget.directory);
    });

    const parentSessionTitle = resolvedParentSessionTarget?.session?.title;
    const returnToParentButton = hostFeatures.returnToParent && resolvedParentSessionTarget && !hideReturnToParent ? (
        <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={handleReturnToParentSession}
            className="absolute left-3 top-3 z-20 !font-normal bg-[var(--surface-background)]/95"
            aria-label={t('chat.container.returnToParent.aria')}
            title={parentSessionTitle?.trim()
                ? t('chat.container.returnToParent.titleNamed', { title: parentSessionTitle })
                : t('chat.container.returnToParent.title')}
        >
            <Icon name="arrow-left" className="h-4 w-4" />
            {t('chat.container.returnToParent.label')}
        </Button>
    ) : null;
    const promptAvailability = resolveChatPromptAvailability({
        readOnly,
        sessionIdentityPending,
        isSubagentSession: Boolean(currentSessionEntity?.parentID) || Boolean(nextSubagentBannerLatch),
        allowPromptingSubagentSessions,
    });
    const bannerModelName = bannerExecution.modelId === sessionExecution.modelId
        ? sessionExecutionModelName
        : bannerExecution.modelId
            ? getProviderModelDisplayName(
                providers.find((entry) => entry.id === bannerExecution.providerId),
                bannerExecution.modelId,
            ) || bannerExecution.modelId
            : t('common.unavailable');
    const readOnlyPromptBanner = resolvedParentSessionTarget ? (
        <ReadOnlyPromptBanner
            agentName={bannerExecution.agentName}
            providerId={bannerExecution.providerId}
            modelId={bannerExecution.modelId}
            modelName={bannerModelName}
        />
    ) : <ReadOnlyPromptBanner />;
    const applyEmbeddedChatSettingsSync = useEvent((payload: { allowPromptingSubagentSessions: boolean }) => {
        useUIStore.getState().setAllowPromptingSubagentSessions(payload.allowPromptingSubagentSessions);
    });
    const handleEmbeddedChatSettingsMessage = useEvent((event: MessageEvent) => {
        if (typeof window === 'undefined' || event.source !== window.parent || event.origin !== window.location.origin) {
            return;
        }
        const data = event.data as { type?: unknown; payload?: { allowPromptingSubagentSessions?: unknown } };
        if (data?.type !== 'openchamber:chat-settings-sync'
            || typeof data.payload?.allowPromptingSubagentSessions !== 'boolean') {
            return;
        }
        applyEmbeddedChatSettingsSync({
            allowPromptingSubagentSessions: data.payload.allowPromptingSubagentSessions,
        });
    });
    // Embedded iframe only: parent posts settings, and the window bridge is for
    // same-origin callers that cannot rely on postMessage ordering.
    const isEmbeddedChatFrame = typeof window !== 'undefined' && window.parent !== window;
    useEventListener(
        'message',
        handleEmbeddedChatSettingsMessage,
        isEmbeddedChatFrame ? window : NO_EVENT_TARGET,
    );
    useMount(() => {
        if (!isEmbeddedChatFrame) return;
        const scopedWindow = window as typeof window & {
            __openchamberApplyChatSettingsSync?: (payload: { allowPromptingSubagentSessions: boolean }) => void;
        };
        scopedWindow.__openchamberApplyChatSettingsSync = applyEmbeddedChatSettingsSync;
        window.parent.postMessage({ type: 'openchamber:chat-settings-request' }, window.location.origin);
    });
    useUnmount(() => {
        if (typeof window === 'undefined') return;
        const scopedWindow = window as typeof window & {
            __openchamberApplyChatSettingsSync?: (payload: { allowPromptingSubagentSessions: boolean }) => void;
        };
        if (scopedWindow.__openchamberApplyChatSettingsSync === applyEmbeddedChatSettingsSync) {
            delete scopedWindow.__openchamberApplyChatSettingsSync;
        }
    });

    React.useEffect(() => {
        if (hostFeatures.newSessionDraft && autoOpenDraft && !currentSessionId && !draftOpen) {
            openNewSessionDraft();
        }
    }, [autoOpenDraft, currentSessionId, draftOpen, hostFeatures.newSessionDraft, openNewSessionDraft]);

    const activeTurnChangeRef = React.useRef<(turnId: string | null) => void>(() => {});
    const handleActiveTurnChange = useEvent((turnId: string | null) => {
        activeTurnChangeRef.current(turnId);
    });
    // Bridge auto-follow upward intent → timeline handler without creating a
    // hook order cycle (auto-follow is created before the timeline controller).
    const historyUpwardIntentRef = React.useRef<() => void>(() => {});
    const handleHistoryUpwardIntentBridge = useEvent(() => {
        historyUpwardIntentRef.current();
    });

    const legendTimelineEnabled = useFeatureFlagsStore((state) => state.legendTimelineEnabled);

    // The legend list owns the scroll position, so its at-end state — not
    // auto-follow's pin — is what load-older must read on that path. The
    // scroll-to-bottom control uses a wider travel latch so a 1px leave of
    // the at-end band does not flash it. Auto-follow is disabled there, and
    // a disabled auto-follow reports a permanent `following` pin, which
    // would silently block every scroll-triggered load of earlier history.
    const [legendIsAtEnd, setLegendIsAtEnd] = React.useState(true);
    const [legendShowScrollButton, setLegendShowScrollButton] = React.useState(false);
    // Sticky "the user scrolled away" — what the previous engine called
    // `released`. The list's own guard is a bare proximity test: it stops
    // maintaining the end only while the viewport sits more than a tenth of a
    // screen away, so a small upward nudge during streaming gets pulled back,
    // and follow can silently resume without the user ever scrolling down.
    // Gestures set this; only arriving at the true end or an explicit jump
    // clears it.
    const [legendFollowReleased, setLegendFollowReleased] = React.useState(false);
    // Bumped when a load of earlier history is requested. The timeline reads
    // the bump to capture the read position and stand end maintenance down
    // before the rows arrive; monotonic, so it survives session swaps.
    const [timelineHistoryAnchorToken, setTimelineHistoryAnchorToken] = React.useState(0);
    const armTimelineHistoryAnchor = useEvent(() => {
        setTimelineHistoryAnchorToken((token) => token + 1);
    });
    const handleTimelineIsAtEndChange = useEvent((atEnd: boolean, showScrollButton?: boolean) => {
        setLegendIsAtEnd(atEnd);
        if (atEnd) {
            setLegendFollowReleased(false);
        }
        if (showScrollButton !== undefined) {
            setLegendShowScrollButton(showScrollButton);
        }
    });
    // A fresh session opens at the live edge, so a release carried over from the
    // previous one would leave the new transcript unfollowed.
    React.useEffect(() => {
        setLegendIsAtEnd(true);
        setLegendShowScrollButton(false);
        setLegendFollowReleased(false);
    }, [currentSessionId]);

    const {
        scrollRef,
        notifyContentChange: handleMessageContentChange,
        getAnimationHandlers,
        goToBottom,
        scrollToBottomOnSend,
        releaseAutoFollow,
        beginHistoryViewportPreservation,
        endHistoryViewportPreservation,
        restoreSnapshot,
        isPinned,
        isFollowingProgrammatically,
        showScrollButton,
    } = useChatAutoFollow({
        // The legend timeline owns its scroll position. Leaving auto-follow on
        // would put two writers on one container: its pin/force-bottom writes
        // and the list's end maintenance would each correct the other.
        enabled: active && !legendTimelineEnabled,
        currentSessionId,
        viewportKey: sessionViewKey,
        sessionMessageCount,
        sessionIsWorking,
        isMobile,
        onActiveTurnChange: handleActiveTurnChange,
        onUpwardUserIntent: handleHistoryUpwardIntentBridge,
    });
    const composerSwapScopeRef = React.useRef<HTMLDivElement>(null);
    useMobileComposerSwap({
        enabled: isMobile,
        scrollRef,
        scopeRef: composerSwapScopeRef,
    });

    const historyPrefixCacheRef = React.useRef<ChatMessageEntry[]>([]);
    const historyPrefix = React.useMemo(() => {
        const next = stitchHostedSessionHistory(
            assistantHistory?.entries ?? [],
            currentSessionId,
            historyPrefixCacheRef.current,
        );
        historyPrefixCacheRef.current = next;
        return next;
    }, [assistantHistory?.entries, currentSessionId]);
    const currentAssistantHistoryCacheRef = React.useRef<ChatMessageEntry[]>([]);
    const currentSessionMessages = React.useMemo(() => {
        if (!assistantHistory) return sessionMessages;
        const next = mergeHostedCurrentSessionHistory(
            assistantHistory.entries,
            currentSessionId,
            sessionMessages,
            currentAssistantHistoryCacheRef.current,
        );
        currentAssistantHistoryCacheRef.current = next;
        return next;
    }, [assistantHistory, currentSessionId, sessionMessages]);
    const viewportMessages = React.useMemo(() => {
        const authoritativeMessages = historyPrefix.length === 0
            ? currentSessionMessages
            : !currentSessionId
                ? historyPrefix
                : [
                    ...historyPrefix,
                    createAssistantSessionDivider(currentSessionId),
                    ...currentSessionMessages,
                ];
        return mergePendingUserMessagePresentations(authoritativeMessages, pendingUserMessages);
    }, [currentSessionId, currentSessionMessages, historyPrefix, pendingUserMessages]);
    // Transcript rows come from the Query cache, which an idle session can lose
    // to eviction or a transport swap. Replaying the last painted rows through
    // that empty read keeps the viewport from being torn down and rebuilt.
    const paintedTranscriptRef = React.useRef<PaintedTranscript<SessionMessageRecord> | null>(null);
    const retainedTranscript = React.useMemo(
        () => resolveRetainedTranscript({
            sessionId: currentSessionId,
            messages: viewportMessages,
            retained: paintedTranscriptRef.current,
        }),
        [currentSessionId, viewportMessages],
    );
    paintedTranscriptRef.current = retainedTranscript.retained;
    const renderedViewportMessages = retainedTranscript.messages as SessionMessageRecord[];
    const paintedTranscriptSessionRef = React.useRef<string | null>(null);
    const hasPaintedTranscript = paintedTranscriptSessionRef.current === currentSessionId;
    // The status line and the body are independent subscriptions, so the body
    // can freeze while the session keeps reporting work. Repair that state
    // instead of leaving the user with a transcript that silently drops their
    // own message. See transcriptStallWatchdog for the firing conditions.
    const transcriptStallRef = React.useRef(INITIAL_TRANSCRIPT_STALL_STATE);
    const transcriptStallSessionKey = currentSessionId
        ? `${effectiveSessionDirectory}\n${currentSessionId}`
        : null;
    const readTranscriptTailFingerprint = useEvent(
        () => buildTranscriptTailFingerprint(renderedViewportMessages),
    );
    React.useEffect(() => {
        if (!currentSessionId || !transcriptStallSessionKey || !sessionIsWorking) {
            transcriptStallRef.current = { ...transcriptStallRef.current, lastMovementAt: null };
            return;
        }
        const sessionId = currentSessionId;
        const directory = effectiveSessionDirectory;
        const interval = setInterval(() => {
            const fingerprint = readTranscriptTailFingerprint();
            const result = advanceTranscriptStallState(transcriptStallRef.current, {
                sessionKey: transcriptStallSessionKey,
                working: true,
                streaming: Boolean(streamingMessageId),
                fingerprint,
                now: Date.now(),
                thresholdMs: TRANSCRIPT_STALL_THRESHOLD_MS,
                cooldownMs: TRANSCRIPT_STALL_COOLDOWN_MS,
                maxAttempts: TRANSCRIPT_STALL_MAX_ATTEMPTS,
            });
            transcriptStallRef.current = result.state;
            if (!result.shouldRefresh) return;
            reportTranscriptStall({
                sessionId,
                directory,
                stalledForMs: result.stalledForMs,
                attempt: result.state.attempts,
                fingerprint,
            });
            void refreshTranscriptFromAuthority(directory, sessionId).catch(() => {
                // Authority refresh keeps the prior transcript on failure; the
                // cooldown governs the next attempt.
            });
        }, TRANSCRIPT_STALL_POLL_MS);
        return () => clearInterval(interval);
    }, [
        currentSessionId,
        effectiveSessionDirectory,
        readTranscriptTailFingerprint,
        sessionIsWorking,
        streamingMessageId,
        transcriptStallSessionKey,
    ]);
    const materializedPendingMessageIDs = React.useMemo(() => {
        if (pendingUserMessages.length === 0) return [];
        // A row counts as materialized only once it can paint a user bubble —
        // part-less or synthetic-only shells still render as null.
        const authoritativeIDs = new Set(
            [...historyPrefix, ...currentSessionMessages]
                .filter((message) => hasUserDisplayableParts(message.parts))
                .map((message) => message.info.id),
        );
        return pendingUserMessages.map((message) => message.info.id).filter((id) => authoritativeIDs.has(id));
    }, [currentSessionMessages, historyPrefix, pendingUserMessages]);
    React.useEffect(() => {
        if (materializedPendingMessageIDs.length === 0) return;
        onPendingUserMessagesMaterialized?.(materializedPendingMessageIDs);
        if (currentSessionId) {
            clearRetainedPendingUserMessages(currentSessionId, materializedPendingMessageIDs);
        }
    }, [clearRetainedPendingUserMessages, currentSessionId, materializedPendingMessageIDs, onPendingUserMessagesMaterialized]);

    const timelineController = useChatTimelineController({
        sessionId: currentSessionId,
        directory: effectiveSessionDirectory,
        messages: renderedViewportMessages,
        historyMeta,
        scrollRef,
        messageListRef,
        loadMoreMessages,
        goToBottom,
        releaseAutoFollow,
        beginHistoryViewportPreservation,
        endHistoryViewportPreservation,
        isPinned: legendTimelineEnabled ? legendIsAtEnd : isPinned,
        showScrollButton: legendTimelineEnabled ? legendShowScrollButton : showScrollButton,
        // Only the active desktop transcript auto-fills short first paint;
        // expanded-input and mobile keep explicit load paths only.
        autoFillEnabled: active && !isDesktopExpandedInput,
        onWillLoadEarlier: armTimelineHistoryAnchor,
    });
    const resumeToLatestInstant = useEvent(() => {
        setLegendFollowReleased(false);
        // Auto-follow is disabled on the legend path, so goToBottom is a
        // no-op there. The list handle talks to LegendList.scrollToEnd.
        messageListRef.current?.scrollToBottom();
        goToBottom('instant');
    });
    // Send always re-engages follow so a just-sent turn can park near the top
    // even if the user was reading history. The list then owns the park via
    // `anchoredEndSpace`; auto-follow's on-send pin is a no-op on this path.
    const scrollViewportOnSend = useEvent(() => {
        setLegendFollowReleased(false);
        scrollToBottomOnSend();
    });
    // An explicit upward gesture releases follow on top of its history
    // pagination duty, so the list stops chasing the end while the user reads.
    // Gesture-only by construction: the hook ignores nested scrollables that
    // can still consume the scroll, and overlay-scrollbar drags.
    const handleTimelineUpwardIntent = useEvent(() => {
        setLegendFollowReleased(true);
        timelineController.handleHistoryUpwardIntent();
    });
    // Mobile loads older history via an explicit top button instead of a
    // scroll-position trigger (see handleHistoryScroll in the controller).
    // Busy state is mutation-owned (timeline loadEarlierMutation.isPending) —
    // never background historyLoading/prefetch, which can stick true on Relay.
    // The Capacitor mobile entrypoint sets isMobile before first render. Do not
    // use width/pointer surface inference here: native WebView viewport changes
    // can temporarily classify as desktop and hide this explicit mobile-only
    // affordance until an unrelated scroll causes another render.
    // Visibility is authoritative-only: canLoadEarlier from the child-store
    // boundary, or a real user-initiated loadEarlier mutation in flight (that
    // mutation keeps the button painted so its spinner has an anchor). An
    // unresolved boundary (unknown availability) renders nothing — never a
    // speculative placeholder.
    const showLoadOlderButton = resolveMobileLoadOlderVisibility({
        isMobile,
        canLoadEarlier: timelineController.historySignals.canLoadEarlier,
        isLoadingOlder: timelineController.isLoadingOlder,
    });
    const isLoadOlderBusy = timelineController.isLoadingOlder;
    const timelineLoadEarlier = timelineController.loadEarlier;
    const handleLoadOlderClick = useEvent(() => {
        // Loading older history is an explicit move into the past, so follow
        // is released unconditionally. This used to be conditional on being
        // away from the live edge, on the grounds that an end correction is a
        // no-op when already there — but that trusted the at-end signal, and
        // a signal reading stale-true (as it did across a session swap) skips
        // the release silently and lets the prepend throw the reader to the
        // newest message. Arriving back at the true end re-arms follow.
        setLegendFollowReleased(true);
        void timelineLoadEarlier({ userInitiated: true });
    });

    // Render-phase ref bridge: timeline is created after auto-follow, so handlers
    // publish into stable useEvent entry points without effect rebinding.
    activeTurnChangeRef.current = timelineController.handleActiveTurnChange;
    historyUpwardIntentRef.current = timelineController.handleHistoryUpwardIntent;

    React.useEffect(() => {
        if (sessionPermissions.length === 0 && sessionQuestions.length === 0) {
            return;
        }
        handleMessageContentChange('permission');
    }, [handleMessageContentChange, sessionPermissions, sessionQuestions]);

    const navigation = useChatTurnNavigation({
        sessionId: currentSessionId,
        turnIds: timelineController.turnIds,
        activeTurnId: timelineController.activeTurnId,
        scrollToTurn: timelineController.scrollToTurn,
        scrollToMessage: timelineController.scrollToMessage,
        resumeToBottom: resumeToLatestInstant,
    });
    // Expanded scroll-to-bottom stays a foot sibling (original bottom-full mb-2).
    // Compact scroll-to-bottom is mounted on the pill inside ChatInput.
    const promptSurface = promptAvailability.showReadOnlyBanner
        ? readOnlyPromptBanner
        : readOnly
            ? null
            : (
                <ChatInput
                    surface={composerSurface}
                    scrollToBottom={scrollViewportOnSend}
                    showScrollToBottom={isMobile && timelineController.showScrollToBottom}
                    onScrollToBottom={navigation.resumeToLatest}
                    submissionBlocked={promptAvailability.blockSubmission}
                />
            );
    const handlePromptNavigatorSelect = useEvent((turnId: string) => {
        void navigation.scrollToTurnId(turnId, { behavior: 'smooth' });
    });
    const canLoadEarlierPrompts = timelineController.historySignals.canLoadEarlier;
    const showPromptNavigator = hostFeatures.promptNavigator
        && !isMobile
        && !isVSCode
        && !isDesktopExpandedInput
        && promptNavigatorEnabled
        && timelineController.turnIds.length >= 2;

    React.useEffect(() => {
        if (!showPromptNavigator) {
            useUIStore.getState().setPromptNavigatorPanelOpen(false);
        }
    }, [showPromptNavigator]);

    const handleForceScrollBottom = useEvent((event: Event) => {
        if (!active || !currentSessionId) return;
        const customEvent = event as CustomEvent<{ sessionId?: string }>;
        if (customEvent.detail?.sessionId && customEvent.detail.sessionId !== currentSessionId) return;
        goToBottom('instant');
    });
    useEventListener(
        CHAT_FORCE_SCROLL_BOTTOM_EVENT,
        handleForceScrollBottom,
        active && currentSessionId && typeof window !== 'undefined' ? window : NO_EVENT_TARGET,
    );

    const handleChatTurnKeyDown = useEvent((event: KeyboardEvent) => {
        if (!active || !currentSessionId || isDesktopExpandedInput) return;
        if (event.defaultPrevented || event.isComposing) {
            return;
        }

        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') {
            return;
        }

        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
            return;
        }

        const { activeMainTab } = useUIStore.getState();
        if (activeMainTab !== 'chat' || hasBlockingChatOverlay()) {
            return;
        }

        const scrollContainer = scrollRef.current;
        if (shouldIgnoreChatNavigationForFocus(document.activeElement, scrollContainer)) {
            return;
        }

        if (shouldIgnoreChatNavigationTarget(event.target)) {
            return;
        }

        event.preventDefault();
        const offset = event.key === 'ArrowUp' ? -1 : 1;
        void navigation.scrollByTurnOffset(offset, { resumePastEnd: false });
    });
    useEventListener(
        'keydown',
        handleChatTurnKeyDown,
        active && currentSessionId && !isDesktopExpandedInput && typeof window !== 'undefined'
            ? window
            : NO_EVENT_TARGET,
    );

    // --chat-scroll-height tracks the scroller viewport for sticky headers.
    // useResizeObserver owns observe/disconnect; useEvent handlers stay latest.
    const chatScrollHeightRafRef = React.useRef(0);
    const updateChatScrollHeight = useEvent(() => {
        const container = scrollRef.current;
        if (!container) return;
        container.style.setProperty('--chat-scroll-height', `${container.clientHeight}px`);
    });
    const scheduleChatScrollHeightUpdate = useEvent(() => {
        if (chatScrollHeightRafRef.current) return;
        chatScrollHeightRafRef.current = requestAnimationFrame(() => {
            chatScrollHeightRafRef.current = 0;
            updateChatScrollHeight();
        });
    });
    useIsomorphicLayoutEffect(() => {
        if (!active) return;
        updateChatScrollHeight();
    }, [active, currentSessionId, isDesktopExpandedInput, updateChatScrollHeight]);
    const canObserveChatScrollResize = typeof ResizeObserver !== 'undefined';
    useResizeObserver(
        active && canObserveChatScrollResize ? scrollRef : null,
        scheduleChatScrollHeightUpdate,
    );
    useEventListener(
        'resize',
        scheduleChatScrollHeightUpdate,
        active && !canObserveChatScrollResize && typeof window !== 'undefined' ? window : NO_EVENT_TARGET,
    );
    useUnmount(() => {
        if (chatScrollHeightRafRef.current) {
            cancelAnimationFrame(chatScrollHeightRafRef.current);
            chatScrollHeightRafRef.current = 0;
        }
    });

    const lastScrolledSessionRef = React.useRef<string | null>(null);
    // Tracks message count at the last pin so a cold open that pinned while the
    // transcript was still empty can re-pin once records land (deep link /
    // session switch). Later growth (stream, load-older) must not re-pin.
    const lastPinnedMessageCountRef = React.useRef(0);

    // Cold transcript gate: prefer a stable skeleton over flashing the
    // "Unable to load this conversation" wall while imperative + reactive
    // pulls race on session switch (stale error or concurrent fail).
    const hasTranscriptShell = hasChatTranscriptShell({
            transcriptMessageCount: sessionMessages.length,
            pendingUserCount: pendingUserMessages.length,
            historyPrefixCount: historyPrefix.length,
        });
    const sessionTranscriptGate = resolveChatSessionTranscriptGate({
        hasTranscriptShell,
        p0Satisfied: transcriptHydration.p0Satisfied,
        hasBusyShell: sessionIsWorking && hasTranscriptShell,
        hasImmediateShell: pendingUserMessages.length > 0 || historyPrefix.length > 0,
        hasRenderableSessionSnapshot,
        prefetchStatus: sessionPrefetchInfo?.status,
        syncLoading: Boolean(currentSessionId && sync.isLoading(currentSessionId, { directory: effectiveSessionDirectory })),
        userRetrying: isRetryingSessionHistory,
        hasPaintedTranscript,
    });
    if (sessionTranscriptGate === 'pass' && renderedViewportMessages.length > 0) {
        paintedTranscriptSessionRef.current = currentSessionId;
    }
    const isSessionHydrating = Boolean(currentSessionId) && sessionTranscriptGate === 'hydrating';
    // Assistant-owned history is authoritative for prior bindings. Do not replace
    // a restorable transcript with the live-session load-failure wall.
    const hasSessionHistoryLoadError =
        Boolean(currentSessionId) && sessionTranscriptGate === 'load-error';

    React.useEffect(() => {
        if (!hasSessionHistoryLoadError || !currentSessionId) return;
        recordTranscriptDiagnostics(snapshotTranscriptDiagnostics({
            kind: 'request-error',
            sessionID: currentSessionId,
            directory: effectiveSessionDirectory,
            purpose: 'load-failed',
            source: 'network',
            request: sessionPrefetchInfo
                ? {
                    sessionID: currentSessionId,
                    status: sessionPrefetchInfo.status === 'ready' ? 'ready' : sessionPrefetchInfo.status,
                    error: sessionPrefetchInfo.error,
                }
                : undefined,
            hydration: transcriptHydration,
            error: sessionPrefetchInfo?.error,
        }));
    }, [
        currentSessionId,
        effectiveSessionDirectory,
        hasSessionHistoryLoadError,
        sessionPrefetchInfo,
        transcriptHydration,
    ]);

    React.useEffect(() => {
        if (!active || !currentSessionId) return;
        // Skeleton has no ChatViewport/scrollRef. Pinning here only records
        // lastScrolled and fires restore against a null container — then the
        // real transcript commits later without a session-level re-pin
        // (trace: one programmatic ScrollLayer before ChatMessage paint → blank).
        if (isSessionHydrating) return;

        const messageCount = renderedViewportMessages.length;
        const sessionChanged = lastScrolledSessionRef.current !== currentSessionId;
        const firstContentLanded = !sessionChanged
            && lastPinnedMessageCountRef.current === 0
            && messageCount > 0;
        if (!sessionChanged && !firstContentLanded) {
            if (lastScrolledSessionRef.current === currentSessionId) {
                lastPinnedMessageCountRef.current = messageCount;
            }
            return;
        }

        const hasHashTarget = typeof window !== 'undefined' && window.location.hash.length > 0;
        lastScrolledSessionRef.current = currentSessionId;
        lastPinnedMessageCountRef.current = messageCount;
        if (hasHashTarget) {
            // Hash navigation handler will scroll to target; we just release auto-follow.
            releaseAutoFollow();
            return;
        }

        const run = () => {
            void restoreSnapshot();
        };
        if (typeof window === 'undefined') {
            run();
        } else {
            window.requestAnimationFrame(run);
        }
    }, [
        active,
        currentSessionId,
        isSessionHydrating,
        releaseAutoFollow,
        restoreSnapshot,
        renderedViewportMessages.length,
    ]);

    React.useEffect(() => {
        setSessionIdentityEnsureRetry((current) => (
            current.key === sessionIdentityEnsureKey
                ? current
                : { key: sessionIdentityEnsureKey, attempt: 0 }
        ));
    }, [sessionIdentityEnsureKey]);

    React.useEffect(() => {
        if (!active || !currentSessionId || sessionIdentityEnsureRetry.key !== sessionIdentityEnsureKey || !shouldEnsureChatSessionRenderable({
            sessionId: currentSessionId,
            hasRenderableSessionSnapshot,
            hasCurrentSessionEntity: Boolean(currentSessionEntity),
        })) return;
        void ensureSessionRenderable(currentSessionId);
        if (currentSessionEntity || sessionIdentityEnsureRetry.attempt >= 2) return;

        const nextAttempt = sessionIdentityEnsureRetry.attempt + 1;
        const timer = window.setTimeout(() => {
            setSessionIdentityEnsureRetry((current) => (
                current.key === sessionIdentityEnsureKey
                    && current.attempt === sessionIdentityEnsureRetry.attempt
                    ? { key: sessionIdentityEnsureKey, attempt: nextAttempt }
                    : current
            ));
        }, nextAttempt * 1000);

        return () => window.clearTimeout(timer);
    }, [
        active,
        currentSessionEntity,
        currentSessionId,
        effectiveSessionDirectory,
        ensureSessionRenderable,
        hasRenderableSessionSnapshot,
        sessionIdentityEnsureKey,
        sessionIdentityEnsureRetry,
    ]);

	// Fork loading is session-scoped: other chats stay interactive while this runs.
	// Before the forked id exists, pin to the source; afterwards follow the target
	// only so navigating back to the source conversation stays fully operable.
	const forkTransitionForSession =
		forkTransition &&
		currentSessionId &&
		(forkTransition.targetSessionId
			? currentSessionId === forkTransition.targetSessionId
			: currentSessionId === forkTransition.sourceSessionId)
			? forkTransition
			: null;

	if (forkTransitionForSession) {
		const stageKey =
			forkTransitionForSession.stage === 'preparing'
				? 'chat.forkTransition.preparing'
				: forkTransitionForSession.stage === 'copying'
					? 'chat.forkTransition.copying'
					: forkTransitionForSession.stage === 'opening'
						? 'chat.forkTransition.opening'
						: 'chat.forkTransition.loading';
		const stageOrder = ['preparing', 'copying', 'opening', 'loading'] as const;
		const stageIndex = Math.max(1, stageOrder.indexOf(forkTransitionForSession.stage) + 1);
		const progressLabel = t('chat.forkTransition.progress', {
			current: stageIndex,
			total: stageOrder.length,
		});
		return (
			<div className="flex h-full flex-col items-center justify-center bg-background px-6 text-center">
				<div
					className="flex flex-col items-center gap-2"
					role="status"
					aria-live="polite"
					aria-label={`${t(stageKey)}. ${progressLabel}`}
				>
					<span className="typography-ui-header text-muted-foreground">
						<span className="animate-text-shimmer">{t(stageKey)}</span>
						<BusyDots />
					</span>
					<span className="text-xs text-muted-foreground/70 tabular-nums">{progressLabel}</span>
				</div>
			</div>
		);
	}

	if (!currentSessionId && !draftOpen) {
		// With auto-open, the draft welcome opens on the next tick (effect below),
		// so the empty state is only ever transient here — render a neutral
		// background instead of flashing the logo / "start a new chat" on refresh.
		// Keep the empty state when there's nothing to auto-open or an init error to show.
		if (autoOpenDraft && !initError) {
			return <div className="flex h-full flex-col bg-background" />;
		}
		return (
			<div className="flex flex-col h-full bg-background">
				<ChatEmptyState />
			</div>
		);
	}

	if (!currentSessionId && draftOpen) {
		// Match fork: leave the draft composer and show a full-screen
		// establishing page until a real session ID arrives. ChatInput sets
		// draftEstablishing before response-style/snippet prep; claim then
		// promotes to draftSubmitting. Combined create+prompt can take a while;
		// partial draft banners were easy to miss (especially desktop /
		// expanded-input layouts).
		if ((draftSubmitting || draftEstablishing) && draftPendingMessage) {
			return (
				<div className="relative flex h-full flex-col bg-background">
					<div className="relative min-h-0 flex-1">
						<ScrollShadow
							className="absolute inset-0 overflow-y-auto overflow-x-hidden chat-scroll"
							style={CHAT_SCROLL_STYLE}
						>
							<MessageList
								sessionKey={`draft:${newSessionDraft.draftID ?? 'pending'}`}
								messages={[draftPendingMessage]}
								sessionIsWorking
								isLoadingOlder={false}
								onMessageContentChange={handleMessageContentChange}
								getAnimationHandlers={getAnimationHandlers}
								scrollToBottom={resumeToLatestInstant}
							/>
							<div
								className="chat-message-column px-4 pb-10 pt-2 typography-meta text-muted-foreground"
								role="status"
								aria-live="polite"
							>
								<span className="animate-text-shimmer">{t('chat.emptyState.establishingConversation')}</span>
								<BusyDots />
							</div>
						</ScrollShadow>
					</div>
				</div>
			);
		}

		if (draftSubmitting || draftEstablishing) {
			return (
				<div className="flex h-full flex-col items-center justify-center bg-background px-6 text-center">
					<div
						className="flex flex-col items-center gap-3"
						role="status"
						aria-live="polite"
						aria-label={t('chat.emptyState.establishingConversation')}
					>
						<span className="typography-ui-header text-muted-foreground">
							<span className="animate-text-shimmer">{t('chat.emptyState.establishingConversation')}</span>
							<BusyDots />
						</span>
					</div>
				</div>
			);
		}

		return (
			<div className="relative flex h-full flex-col bg-background">
				{useCompactDraftLayout && !isDesktopExpandedInput ? (
					<div className="oc-draft-center flex min-h-0 flex-1 flex-col items-center justify-center px-6 text-center">
						<h1 className="text-balance text-3xl font-normal tracking-tight text-foreground">
							{renderDraftTitle(
								draftProjectLabel
									? t('chat.emptyState.draftTitleWithProject', { project: draftProjectLabel })
									: t('chat.emptyState.draftTitle'),
								draftProjectLabel,
							)}
						</h1>
						<DraftPresetChips
							onSubmit={(text) => useInputStore.getState().requestPresetSubmit(text)}
							className="oc-draft-starters mt-8 max-w-md"
						/>
					</div>
				) : null}
				<div
					className={cn(
						'relative z-10 flex min-h-0',
						isMobile && 'oc-mobile-composer-foot',
						isDesktopExpandedInput
							? 'flex-1 bg-background'
							: useCompactDraftLayout
								? cn('bg-background', 'px-0')
								: 'flex-1 items-center justify-center bg-background px-0 pb-[6vh]'
					)}
				>
                        {promptSurface}
				</div>
			</div>
        );
    }

    if (!currentSessionId) {
        return null;
    }

	if (hasSessionHistoryLoadError) {
		return (
			<div className="relative flex h-full flex-col bg-background">
				{returnToParentButton}
				<div
					className={cn(
						'relative min-h-0',
						isDesktopExpandedInput
							? 'absolute inset-0 opacity-0 pointer-events-none'
							: 'flex-1',
					)}
					aria-hidden={isDesktopExpandedInput}
				>
					{!isDesktopExpandedInput ? (
						<div className="absolute inset-0 flex items-center justify-center px-6">
							<div
								className="flex max-w-sm flex-col items-center text-center"
								role="alert"
								aria-live="polite"
							>
								<div className="mb-4 flex size-10 items-center justify-center rounded-full bg-[var(--status-error-background)] text-[var(--status-error-foreground)]">
									<Icon name="error-warning" className="size-5" aria-hidden="true" />
								</div>
								<h2 className="typography-ui-header text-foreground">
									{t('chat.history.loadFailedTitle')}
								</h2>
								<p className="mt-2 text-sm text-muted-foreground">
									{t('chat.history.loadFailedDescription')}
								</p>
								<Button
									type="button"
									className="mt-5"
									onClick={retrySessionHistory}
								>
									<Icon name="refresh" className="size-4" aria-hidden="true" />
									{t('chat.history.retry')}
								</Button>
							</div>
						</div>
					) : null}
				</div>
				<div
					className={cn(
						'relative z-10',
						isMobile && 'oc-mobile-composer-foot',
						isDesktopExpandedInput
							? 'flex-1 min-h-0 bg-background'
							: 'bg-background',
					)}
				>
					{promptSurface}
				</div>
			</div>
		);
	}

	if (isSessionHydrating) {
		return (
			<div ref={composerSwapScopeRef} className={cn('relative flex flex-col h-full bg-background', isMobile && 'oc-chat-composer-swap-scope')}>
				{returnToParentButton}
				<div
					className={cn(
						'relative min-h-0',
                        isDesktopExpandedInput
                            ? 'absolute inset-0 opacity-0 pointer-events-none'
                            : 'flex-1'
                    )}
                    aria-hidden={isDesktopExpandedInput}
                >
                    <div ref={scrollRef} className="absolute inset-0 overflow-y-auto overflow-x-hidden bg-background pt-6 chat-scroll" style={CHAT_SCROLL_STYLE}>
                        <div className="space-y-4 chat-scroll-foot-inset">
                            {HYDRATING_SKELETON_ITEMS.map((item) => (
                                <div key={item.id} className="group w-full">
                                    <div className="chat-message-column">
                                        <div className="space-y-2.5 px-4 py-3">
                                            <div className="space-y-1.5">
                                                {item.toolRows.map((row) => {
                                                    return (
                                                        <div key={`${item.id}-${row.id}`} className="flex items-center gap-2">
                                                            <Skeleton className="h-3.5 w-3.5 rounded-full flex-shrink-0" />
                                                            <Skeleton className={cn('h-4 rounded-md', row.titleWidth)} />
                                                            <Skeleton className={cn('h-4 rounded-md', row.detailWidth)} />
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                            <div className="space-y-1.5 pt-1">
                                                <Skeleton className={cn('h-4 rounded-md', item.textWidths[0])} />
                                                <Skeleton className={cn('h-4 rounded-md', item.textWidths[1])} />
                                                <Skeleton className={cn('h-4 rounded-md', item.textWidths[2])} />
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
                <div
                    className={cn(
                        'relative z-10',
                        isMobile && 'oc-mobile-composer-foot oc-mobile-composer-foot--overlay',
						isDesktopExpandedInput
							? 'flex-1 min-h-0 bg-background'
							: 'bg-background'
					)}
				>
                    {!isMobile && !isDesktopExpandedInput ? <DesktopComposerEdgeFade /> : null}
                    {promptSurface}
				</div>
            </div>
        );
    }

	if (renderedViewportMessages.length === 0 && !sessionIsWorking) {
		return (
			// No transform here either — same fixed-positioning constraint as the
			// draft branch above.
			<div className="relative flex flex-col h-full bg-background">
				{returnToParentButton}
				<div
					className={cn(
                        'relative min-h-0',
                        isDesktopExpandedInput
                            ? 'absolute inset-0 opacity-0 pointer-events-none'
                            : 'flex-1'
                    )}
                    aria-hidden={isDesktopExpandedInput}
                >
                    {!isDesktopExpandedInput ? (
                        <div className="absolute inset-0 flex items-center justify-center">
                            <ChatEmptyState />
                        </div>
                    ) : null}
                </div>
                <div
                    className={cn(
                        'relative z-10',
                        isMobile && 'oc-mobile-composer-foot',
					isDesktopExpandedInput
						? 'flex-1 min-h-0 bg-background'
						: 'bg-background'
					)}
				>
                    {promptSurface}
				</div>
                <ImageSaveActionsHost />
            </div>
        );
    }

	return (
		<div ref={composerSwapScopeRef} className={cn('relative flex flex-col h-full bg-background', isMobile && 'oc-chat-composer-swap-scope')}>
			{warning ? (
				<div className="shrink-0 border-b border-border bg-[var(--status-warning-background)] px-4 py-2.5 typography-meta text-[var(--status-warning-foreground)]">
					{warning}
				</div>
			) : null}
			{returnToParentButton}
			<ChatViewport
				key={currentSessionId}
				currentSessionId={currentSessionId}
                virtualizerKey={sessionViewKey ?? currentSessionId}
                isDesktopExpandedInput={isDesktopExpandedInput}
                isMobile={isMobile}
                stickyUserHeader={stickyUserHeader}
                directory={effectiveSessionDirectory}
                scrollRef={scrollRef}
                messageListRef={messageListRef}
                pendingRevealWork={timelineController.pendingRevealWork}
                renderedMessages={timelineController.renderedMessages}
                isLoadingOlder={isLoadOlderBusy}
                sessionIsWorking={sessionIsWorking}
                streamingMessageId={streamingMessageId}
                activeStreamingPhase={activeStreamingPhase}
                retryOverlay={retryOverlay}
                handleMessageContentChange={handleMessageContentChange}
                getAnimationHandlers={getAnimationHandlers}
                handleHistoryScroll={timelineController.handleHistoryScroll}
                handleHistoryUpwardIntent={handleTimelineUpwardIntent}
                onTimelineIsAtEndChange={handleTimelineIsAtEndChange}
                timelineFollowSuspended={legendFollowReleased}
                timelineHistoryAnchorToken={timelineHistoryAnchorToken}
                scrollToBottom={resumeToLatestInstant}
                sessionQuestions={sessionQuestions}
                sessionPermissions={sessionPermissions}
                isProgrammaticFollowActive={isFollowingProgrammatically}
                showLoadOlderButton={showLoadOlderButton}
                onLoadOlder={handleLoadOlderClick}
                turnIds={timelineController.turnIds}
                activeTurnId={timelineController.activeTurnId}
                onSelectTurn={handlePromptNavigatorSelect}
                showPromptNavigator={showPromptNavigator}
                canLoadEarlierPrompts={canLoadEarlierPrompts}
                isLoadingOlderPrompts={isLoadOlderBusy}
                onLoadEarlierPrompts={handleLoadOlderClick}
            />

            <div
                className={cn(
                    'relative z-10',
                    isMobile && 'oc-mobile-composer-foot oc-mobile-composer-foot--overlay',
                    isDesktopExpandedInput
                        ? 'flex-1 min-h-0 bg-background'
                        : 'bg-background'
                )}
            >
                {!isMobile && !isDesktopExpandedInput ? <DesktopComposerEdgeFade /> : null}
                {!isDesktopExpandedInput && renderedViewportMessages.length > 0 && (
                    isMobile ? (
                        <ScrollToBottomButton
                            placement="expanded"
                            visible={timelineController.showScrollToBottom}
                            onClick={navigation.resumeToLatest}
                        />
                    ) : (
                        <ScrollToBottomButton
                            visible={timelineController.showScrollToBottom}
                            onClick={navigation.resumeToLatest}
                        />
                    )
                )}
                {promptSurface}
            </div>

            <ImageSaveActionsHost />

            <TimelineDialog
                open={isTimelineDialogOpen}
                onOpenChange={setTimelineDialogOpen}
                sessionID={currentSessionId ?? undefined}
                directory={effectiveSessionDirectory}
                onRevertMessage={onRevertMessage}
                onScrollToMessage={timelineController.scrollToMessage}
                onScrollByTurnOffset={navigation.scrollByTurnOffset}
                onResumeToLatest={resumeToLatestInstant}
                canLoadEarlier={timelineController.historySignals.canLoadEarlier}
                isLoadingEarlier={isLoadOlderBusy}
                onLoadEarlier={handleLoadOlderClick}
            />
        </div>
	);
};

const MemoizedChatContainerContent = React.memo(ChatContainerContent);
MemoizedChatContainerContent.displayName = 'MemoizedChatContainerContent';

const SessionViewLoadingPlaceholder: React.FC = () => (
    <div
        className="flex h-full flex-col bg-background"
        data-session-view-loading="true"
        aria-hidden="true"
    >
        <div className="mt-auto w-full pb-5 motion-safe:animate-pulse">
            <div className="chat-message-column space-y-6 px-4">
                <div className="space-y-2">
                    <Skeleton className="h-4 w-4/5 animate-none rounded-md" />
                    <Skeleton className="h-4 w-2/3 animate-none rounded-md" />
                    <Skeleton className="h-4 w-1/2 animate-none rounded-md" />
                </div>
                <div className="space-y-2">
                    <Skeleton className="h-4 w-5/6 animate-none rounded-md" />
                    <Skeleton className="h-4 w-3/5 animate-none rounded-md" />
                </div>
                <Skeleton className="h-24 w-full animate-none rounded-xl" />
            </div>
        </div>
    </div>
);

const RuntimeScopedChatContainer: React.FC<ChatContainerProps & { runtimeKey: string }> = ({ runtimeKey, ...props }) => {
    const chatSurfaceMode = useChatSurfaceMode();
    const syncDirectory = useSyncDirectory();
    const selectedSession = useSessionUIStore(
        useShallow((state) => ({
            sessionId: state.currentSessionId,
            directory: state.currentSessionDirectory,
        })),
    );
    const selectedSessionView = React.useMemo<SessionViewSelection | null>(() => {
        if (!selectedSession.sessionId) {
            return null;
        }
        return {
            runtimeKey,
            sessionId: selectedSession.sessionId,
            directory: selectedSession.directory ?? syncDirectory,
        };
    }, [runtimeKey, selectedSession.directory, selectedSession.sessionId, syncDirectory]);
    const selectionIntent = React.useMemo(
        () => createSessionViewRenderIntent(selectedSessionView),
        [selectedSessionView],
    );
    const selectionKey = selectionIntent.key;
    const cacheLimits = isMobileSurfaceRuntime() || isVSCodeRuntime() || chatSurfaceMode === 'mini-chat'
        ? CONSTRAINED_SESSION_VIEW_CACHE_LIMITS
        : DESKTOP_SESSION_VIEW_CACHE_LIMITS;
    const [sessionViewRenderState, setSessionViewRenderState] = React.useState<SessionViewRenderState>(() => ({
        activeIntent: selectionIntent,
        cacheNeedsTrim: false,
        cachedSessionViews: selectedSessionView
            ? reconcileSessionViewCache(
                [],
                selectedSessionView,
                cacheLimits,
                DEFAULT_SESSION_VIEW_ESTIMATED_BYTES,
            )
            : [],
        pendingSessionView: null,
    }));
    const committedSelectionIntentRef = React.useRef(selectionIntent);
    const committedSelectionKeyRef = React.useRef(selectionKey);
    const { cacheNeedsTrim, cachedSessionViews, pendingSessionView } = sessionViewRenderState;
    const pendingRenderEntry = pendingSessionView?.intent === selectionIntent
        ? pendingSessionView.entry
        : null;
    const renderedSessionViews = React.useMemo(
        () => {
            const next = [...cachedSessionViews];
            if (
                pendingRenderEntry
                && !next.some((entry) => entry.key === pendingRenderEntry.key)
            ) {
                next.push(pendingRenderEntry);
            }
            return next.sort((left, right) => left.key.localeCompare(right.key));
        },
        [cachedSessionViews, pendingRenderEntry],
    );
    const activeSessionViewKey = resolveActiveSessionViewKey(renderedSessionViews, selectionKey);
    const isMaterializingSessionView = Boolean(selectionKey && !activeSessionViewKey);

    useIsomorphicLayoutEffect(() => {
        committedSelectionIntentRef.current = selectionIntent;
        committedSelectionKeyRef.current = selectionKey;
        setSessionViewRenderState((current) => applySessionViewSelectionIntent(
            current,
            selectionIntent,
            cacheLimits,
        ));
    }, [cacheLimits, cacheNeedsTrim, selectionIntent, selectionKey]);

    const pendingSessionViewIntent = pendingSessionView?.intent ?? null;
    useIsomorphicLayoutEffect(() => {
        if (!pendingSessionViewIntent) {
            return;
        }
        setSessionViewRenderState((current) => commitMaterializedSessionView(
            current,
            pendingSessionViewIntent,
            cacheLimits,
        ));
    }, [cacheLimits, pendingSessionViewIntent]);

    React.useEffect(() => {
        if (!selectionIntent.selection || activeSessionViewKey) {
            return;
        }
        const scheduledIntent = selectionIntent;
        const scheduledSelectionKey = selectionKey;
        return scheduleAfterPaintTask(() => {
            if (
                committedSelectionIntentRef.current !== scheduledIntent
                || committedSelectionKeyRef.current !== scheduledSelectionKey
            ) {
                return;
            }
            setSessionViewRenderState((current) => {
                if (committedSelectionKeyRef.current !== scheduledSelectionKey) {
                    return current;
                }
                return materializeSessionViewRenderIntent(
                    current,
                    scheduledIntent,
                    committedSelectionIntentRef.current,
                    DEFAULT_SESSION_VIEW_ESTIMATED_BYTES,
                );
            });
        }, { priority: 'user-blocking' });
    }, [activeSessionViewKey, cacheLimits, selectionIntent, selectionKey]);

    const handleSessionViewEstimateChange = useEvent((key: string, estimatedBytes: number) => {
        const scheduledIntent = committedSelectionIntentRef.current;
        const scheduledSelectionKey = committedSelectionKeyRef.current;
        setSessionViewRenderState((current) => {
            if (
                committedSelectionIntentRef.current !== scheduledIntent
                || committedSelectionKeyRef.current !== scheduledSelectionKey
                || current.activeIntent !== scheduledIntent
                || key !== scheduledSelectionKey
            ) {
                return current;
            }
            const cachedViews = recordSessionViewEstimate(
                current.cachedSessionViews,
                key,
                estimatedBytes,
            );
            return cachedViews === current.cachedSessionViews
                ? current
                : { ...current, cacheNeedsTrim: true, cachedSessionViews: cachedViews };
        });
    });

    return (
        <div className="h-full bg-background" aria-busy={isMaterializingSessionView || undefined}>
            {isMaterializingSessionView ? <SessionViewLoadingPlaceholder key={selectionKey} /> : null}
            {renderedSessionViews.map((view) => (
                <React.Activity
                    key={view.key}
                    name={`chat-session-${view.sessionId}`}
                    mode={activeSessionViewKey === view.key ? 'visible' : 'hidden'}
                >
                    <MemoizedChatContainerContent
                        {...props}
                        sessionId={view.sessionId}
                        sessionDirectory={view.directory}
                        sessionViewKey={view.key}
                        onSessionViewEstimateChange={handleSessionViewEstimateChange}
                    />
                </React.Activity>
            ))}
            {!selectionKey ? (
                <MemoizedChatContainerContent
                    {...props}
                    sessionId={null}
                    sessionDirectory={selectedSession.directory}
                />
            ) : null}
        </div>
    );
};

const HostedChatContainer: React.FC<ChatContainerProps & { host: ChatContainerHost; runtimeKey: string }> = ({
    host,
    runtimeKey,
    readOnly = false,
}) => {
    const hostedFeatures = React.useMemo(() => resolveChatContainerHostFeatures(host), [host]);
    const sessionSurface = React.useMemo(() => ({
        ...host.sessionSurface,
        sessionId: host.sessionId,
        directory: host.directory,
        ...(host.onRevertMessage ? { onRevertMessage: host.onRevertMessage } : {}),
    }), [host]);
    const sessionViewKey = `host:${runtimeKey}:${sessionSurface.surfaceId}:${host.sessionId}`;
    return (
        <SessionSurfaceContext.Provider value={sessionSurface}>
            <div className="h-full bg-background">
                <MemoizedChatContainerContent
                    autoOpenDraft={false}
                    readOnly={readOnly}
                    sessionId={host.sessionId}
                    sessionDirectory={host.directory}
                    sessionViewKey={sessionViewKey}
                    composerSurface={host.composerSurface}
                    hostedFeatures={hostedFeatures}
                    assistantHistory={host.assistantHistory}
                    pendingUserMessages={host.pendingUserMessages}
                    onPendingUserMessagesMaterialized={host.onPendingUserMessagesMaterialized}
                    onRevertMessage={host.onRevertMessage}
                    warning={host.warning}
                />
            </div>
        </SessionSurfaceContext.Provider>
    );
};

const ExplicitChatContainer: React.FC<Omit<ChatContainerProps, 'host'> & {
    explicitSession: NonNullable<ChatContainerProps['explicitSession']>;
    runtimeKey: string;
}> = ({ explicitSession, runtimeKey, ...props }) => {
    const syncDirectory = useSyncDirectory();
    const directory = explicitSession.directory ?? syncDirectory;
    const sessionSurface = React.useMemo(() => createExplicitSessionSurface({
        ...explicitSession,
        directory,
    }), [directory, explicitSession]);
    return (
        <SessionSurfaceContext.Provider value={sessionSurface}>
            <div className="h-full bg-background">
                <MemoizedChatContainerContent
                    {...props}
                    active={explicitSession.active}
                    sessionId={explicitSession.sessionId}
                    sessionDirectory={directory}
                    sessionViewKey={`explicit:${runtimeKey}:${explicitSession.viewKey}`}
                />
            </div>
        </SessionSurfaceContext.Provider>
    );
};

export const ChatContainer: React.FC<ChatContainerProps> = (props) => {
    const runtimeKey = React.useSyncExternalStore(
        subscribeRuntimeKey,
        getRuntimeKey,
        getRuntimeKey,
    );

    if (props.host) {
        return <HostedChatContainer key={`${runtimeKey}:${props.host.sessionSurface.surfaceId}`} {...props} host={props.host} runtimeKey={runtimeKey} />;
    }

    if (props.explicitSession) {
        return (
            <ExplicitChatContainer
                key={`${runtimeKey}:${props.explicitSession.viewKey}`}
                autoOpenDraft={props.autoOpenDraft}
                readOnly={props.readOnly}
                active={props.active}
                explicitSession={props.explicitSession}
                runtimeKey={runtimeKey}
            />
        );
    }

    return <RuntimeScopedChatContainer key={runtimeKey} {...props} runtimeKey={runtimeKey} />;
};
