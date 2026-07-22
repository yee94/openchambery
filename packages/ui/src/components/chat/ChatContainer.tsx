import React from 'react';
import type { Message, Part } from '@opencode-ai/sdk/v2';
import type { PermissionRequest } from '@/types/permission';
import type { QuestionRequest } from '@/types/question';

import { ChatInput } from './ChatInput';
import type { ChatInputSurface } from './chatInputSurface';
import {
    resolveChatContainerHostFeatures,
    type ChatContainerHost,
    type ChatContainerHostFeatures,
} from './chatContainerHost';
import { SessionSurfaceContext } from './SessionSurfaceContext';
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
import { SessionRecapNote } from '@/components/chat/SessionRecapSpacer';
import ScrollToBottomButton from './components/ScrollToBottomButton';
import { PromptNavigatorRail } from './components/PromptNavigatorRail';
import { ScrollShadow } from '@/components/ui/ScrollShadow';
import { useChatAutoFollow, type AnimationHandlers, type ContentChangeReason } from '@/hooks/useChatAutoFollow';
import { useChatTimelineController } from './hooks/useChatTimelineController';
import { createAssistantSessionDivider, useHostedSessionHistoryPrefix } from './hostedSessionHistory';
import { TimelineDialog } from './TimelineDialog';
import { useChatTurnNavigation } from './hooks/useChatTurnNavigation';
import { useChatSurfaceMode } from './useChatSurfaceMode';
import { useDeviceInfo } from '@/lib/device';
import { Button } from '@/components/ui/button';
import { OverlayScrollbar } from '@/components/ui/OverlayScrollbar';
import { Icon } from "@/components/icon/Icon";
import { cn, formatDirectoryName } from '@/lib/utils';
import { getProviderModelDisplayName } from '@/lib/modelDisplay';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useConfigStore } from '@/stores/useConfigStore';

// New sync system imports
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useStreamingStore } from '@/sync/streaming';
import {
    useSessionMessageCount,
    useSessionMessageRecords,
    useSyncDirectory,
    useDirectorySync,
    useSessionStatus,
    useSessionStatusObservedAt,
    useSessionStatusSnapshotAt,
    useScopedBlockingPermissions,
    useScopedBlockingQuestions,
    useParentSessionTarget,
    useSession,
} from '@/sync/sync-context';
import { useSync } from '@/sync/use-sync';
import { getSessionPrefetch, subscribeSessionPrefetch } from '@/sync/session-prefetch-cache';
import { getSessionMaterializationStatus } from '@/sync/materialization';
import { usePlanDetection } from '@/hooks/usePlanDetection';
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
import { resolveChatPromptAvailability } from './chatPromptAvailability';
import { shouldEnsureChatSessionRenderable } from './chatSessionMaterialization';

const EMPTY_MESSAGES: Array<{ info: Message; parts: Part[] }> = [];
const IDLE_SESSION_STATUS = { type: 'idle' as const };
const CHAT_FORCE_SCROLL_BOTTOM_EVENT = 'openchamber:chat-force-scroll-bottom';
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
    const focusScrollContainer = React.useCallback((event: React.MouseEvent<HTMLElement>) => {
        if (event.defaultPrevented || shouldIgnoreChatNavigationTarget(event.target)) {
            return;
        }

        if (typeof window !== 'undefined' && window.getSelection()?.type === 'Range') {
            return;
        }

        scrollRef.current?.focus({ preventScroll: true });
    }, [scrollRef]);

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
                    className="absolute inset-0 overflow-y-auto overflow-x-hidden z-0 chat-scroll overlay-scrollbar-target"
                    ref={scrollRef}
                    style={CHAT_SCROLL_STYLE}
                    observeMutations={false}
                    hideTopShadow={isMobile && stickyUserHeader}
                    tabIndex={0}
                    onClick={focusScrollContainer}
                    onScroll={handleHistoryScroll}
                    data-scroll-shadow="true"
                    data-scrollbar="chat"
                >
                    <div className="relative z-0 min-h-full">
                        {showLoadOlderButton && (
                            <div className="flex justify-center pt-3 pb-1">
                                <Button
                                    variant="secondary"
                                    size="sm"
                                    onClick={onLoadOlder}
                                    disabled={isLoadingOlder}
                                >
                                    {isLoadingOlder && (
                                        <Icon name="loader-4" className="size-4 animate-spin" />
                                    )}
                                    {t('chat.history.loadOlder')}
                                </Button>
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

                        <SessionRecapNote sessionId={currentSessionId} directory={directory} isMobile={isMobile} />

                        <div className="mb-1">
                            <StatusRowContainer />
                        </div>

                        <div className="flex-shrink-0" style={{ height: isMobile ? '40px' : '10vh' }} aria-hidden="true" />
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
    host?: ChatContainerHost;
};

type ChatContainerContentProps = Omit<ChatContainerProps, 'host'> & {
    sessionId: string | null;
    sessionDirectory: string | null;
    sessionViewKey?: string;
    onSessionViewEstimateChange?: (key: string, estimatedBytes: number) => void;
    composerSurface?: ChatInputSurface;
    hostedFeatures?: Required<ChatContainerHostFeatures>;
    historySessionIDs?: readonly string[];
    onRevertMessage?: (messageId: string) => Promise<void>;
    warning?: string | null;
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
    sessionId: currentSessionId,
    sessionDirectory: currentSessionDirectory,
    sessionViewKey,
    onSessionViewEstimateChange,
    composerSurface,
    hostedFeatures,
    historySessionIDs,
    onRevertMessage,
    warning = null,
}) => {
    const hostFeatures = hostedFeatures ?? resolveChatContainerHostFeatures(undefined);
    const { t } = useI18n();
    React.useLayoutEffect(() => {
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
    const ensureSessionRenderable = React.useCallback(
        (sessionId: string) => sync.ensureSessionRenderable(sessionId, { directory: effectiveSessionDirectory }),
        [effectiveSessionDirectory, sync],
    );
    const loadMoreMessages = React.useCallback(
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        (sessionId: string, _direction: 'up' | 'down') => sync.loadMore(sessionId),
        [sync],
    );

    // UI store
    const isExpandedInput = useUIStore((state) => state.isExpandedInput);
    const stickyUserHeader = useUIStore((state) => state.stickyUserHeader);
    const promptNavigatorEnabled = useUIStore((state) => state.promptNavigatorEnabled);
    const allowPromptingSubagentSessions = useUIStore((state) => state.allowPromptingSubagentSessions);
    const isTimelineDialogOpen = useUIStore((s) => s.isTimelineDialogOpen);
    const setTimelineDialogOpen = useUIStore((s) => s.setTimelineDialogOpen);

    // Streaming state
    const streamingMessageId = useStreamingStore(
        React.useCallback(
            (s) => (currentSessionId ? s.streamingMessageIds.get(currentSessionId) ?? null : null),
            [currentSessionId],
        ),
    );
    const activeStreamingPhase = useStreamingStore(
        React.useCallback(
            (s) => {
                if (!streamingMessageId) return null;
                return s.messageStreamStates.get(streamingMessageId)?.phase ?? null;
            },
            [streamingMessageId],
        ),
    );
    const sessionMessageCount = useSessionMessageCount(currentSessionId ?? '', effectiveSessionDirectory);
    const sessionViewEstimatedBytes = estimateSessionViewBytes(sessionMessageCount);
    React.useEffect(() => {
        if (!sessionViewKey || !onSessionViewEstimateChange) {
            return;
        }
        onSessionViewEstimateChange(sessionViewKey, sessionViewEstimatedBytes);
    }, [onSessionViewEstimateChange, sessionViewEstimatedBytes, sessionViewKey]);
    const hasRenderableSessionSnapshot = useDirectorySync(
        React.useCallback(
            (state) => (currentSessionId ? getSessionMaterializationStatus(state, currentSessionId).renderable : false),
            [currentSessionId],
        ),
        effectiveSessionDirectory,
    );
    const currentSessionEntity = useSession(currentSessionId, effectiveSessionDirectory);
    const sessionIdentityPending = Boolean(currentSessionId && !currentSessionEntity);
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
    const sessionExecution = React.useMemo(
        () => resolveContextPanelSessionExecution(sessionMessages),
        [sessionMessages],
    );
    const sessionExecutionModelName = React.useMemo(() => {
        if (!sessionExecution.modelId) return t('common.unavailable');
        const provider = providers.find((entry) => entry.id === sessionExecution.providerId);
        const modelExists = provider?.models.some((model) => model.id === sessionExecution.modelId);
        return modelExists
            ? getProviderModelDisplayName(provider, sessionExecution.modelId) || sessionExecution.modelId
            : sessionExecution.modelId;
    }, [providers, sessionExecution.modelId, sessionExecution.providerId, t]);
    const hasUserBoundary = React.useMemo(
        () => sessionMessages.some(({ info }) => (
            info.role === 'user'
            || (info as Message & { clientRole?: string }).clientRole === 'user'
        )),
        [sessionMessages],
    );
    const sessionPrefetchInfo = React.useSyncExternalStore(
        React.useCallback(
            (notify) => currentSessionId
                ? subscribeSessionPrefetch(effectiveSessionDirectory, currentSessionId, notify)
                : () => undefined,
            [currentSessionId, effectiveSessionDirectory],
        ),
        React.useCallback(
            () => currentSessionId ? getSessionPrefetch(effectiveSessionDirectory, currentSessionId) : undefined,
            [currentSessionId, effectiveSessionDirectory],
        ),
        React.useCallback(() => undefined, []),
    );

    // Plan detection - watches messages for plan creation and signals store
    usePlanDetection(currentSessionId ?? '', sessionMessages);

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

    const sessionIsWorking = React.useMemo(() => {
        if (!currentSessionId || sessionPermissions.length > 0 || sessionQuestions.length > 0) {
            return false;
        }

        const statusType = sessionStatusForCurrent.type ?? 'idle';
        if (statusType === 'busy' || statusType === 'retry') {
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
    }, [currentSessionId, resolvedSessionStatus, sessionMessages, sessionPermissions.length, sessionQuestions.length, sessionStatusForCurrent.type, sessionStatusObservedAt, sessionStatusSnapshotAt]);
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

    // History metadata — use sync's hasMore/isLoading
    const historyMeta = React.useMemo(() => {
        if (!currentSessionId) return null;
        // Sync's meta is authoritative once a fetch has confirmed the history
        // is fully loaded — a stale prefetch-cache entry (cursor recorded at
        // the initial page) must not keep the "load older" affordance alive
        // after the user has already reached the top.
        const syncComplete = sync.isComplete(currentSessionId);
        const prefetchHasMore = !syncComplete
            && Boolean(sessionPrefetchInfo?.cursor)
            && sessionPrefetchInfo?.complete !== true;
        return {
            limit: sessionMessages.length,
            complete: syncComplete || !(sync.hasMore(currentSessionId) || prefetchHasMore),
            loading: sync.isLoading(currentSessionId),
        };
    }, [currentSessionId, sessionMessages.length, sessionPrefetchInfo, sync]);

    const { isMobile } = useDeviceInfo();
    const isVSCode = isVSCodeRuntime();
    const chatSurfaceMode = useChatSurfaceMode();
    const draftOpen = Boolean(newSessionDraft?.open);
    const initError = useGlobalSyncStore((s) => s.error);
    // Despite the historical name, this now covers mobile too: the mobile
    // composer enters the same fullscreen-input mode via its drag handle.
    const isDesktopExpandedInput = isExpandedInput;
    const useCompactDraftLayout = isMobile || isVSCode || chatSurfaceMode === 'mini-chat';
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

    // In the embedded session-chat iframe, hide "Return to parent" when
    // viewing the panel's anchor session (the one recorded in the URL). Going
    // up from the anchor would show the primary session that's already in the
    // main chat. Drilling into a deeper subtask (currentSessionId ≠ anchor)
    // re-enables the button to navigate back to the embedded session.
    const embeddedPanelAnchorSessionId = getEmbeddedSessionChatOriginSessionId();
    const hideReturnToParent =
        embeddedPanelAnchorSessionId !== null && currentSessionId === embeddedPanelAnchorSessionId;

    const handleReturnToParentSession = React.useCallback(() => {
        if (!parentSessionTarget) return;
        setCurrentSession(parentSessionTarget.id, parentSessionTarget.directory);
    }, [parentSessionTarget, setCurrentSession]);

    const parentSessionTitle = parentSessionTarget?.session?.title;
    const returnToParentButton = hostFeatures.returnToParent && parentSessionTarget && !hideReturnToParent ? (
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
        isSubagentSession: Boolean(currentSessionEntity?.parentID),
        allowPromptingSubagentSessions,
    });
    const readOnlyPromptBanner = parentSessionTarget ? (
        <ReadOnlyPromptBanner
            agentName={sessionExecution.agentName}
            providerId={sessionExecution.providerId}
            modelId={sessionExecution.modelId}
            modelName={sessionExecutionModelName}
        />
    ) : <ReadOnlyPromptBanner />;
    React.useEffect(() => {
        if (typeof window === 'undefined' || window.parent === window) {
            return;
        }

        const applySetting = (value: boolean) => {
            useUIStore.getState().setAllowPromptingSubagentSessions(value);
        };
        const scopedWindow = window as typeof window & {
            __openchamberApplyChatSettingsSync?: (payload: { allowPromptingSubagentSessions: boolean }) => void;
        };
        const applySync = (payload: { allowPromptingSubagentSessions: boolean }) => {
            applySetting(payload.allowPromptingSubagentSessions);
        };
        const handleMessage = (event: MessageEvent) => {
            if (event.source !== window.parent || event.origin !== window.location.origin) return;
            const data = event.data as { type?: unknown; payload?: { allowPromptingSubagentSessions?: unknown } };
            if (data?.type !== 'openchamber:chat-settings-sync'
                || typeof data.payload?.allowPromptingSubagentSessions !== 'boolean') return;
            applySetting(data.payload.allowPromptingSubagentSessions);
        };

        scopedWindow.__openchamberApplyChatSettingsSync = applySync;
        window.addEventListener('message', handleMessage);
        window.parent.postMessage({ type: 'openchamber:chat-settings-request' }, window.location.origin);
        return () => {
            window.removeEventListener('message', handleMessage);
            if (scopedWindow.__openchamberApplyChatSettingsSync === applySync) {
                delete scopedWindow.__openchamberApplyChatSettingsSync;
            }
        };
    }, []);

    React.useEffect(() => {
        if (hostFeatures.newSessionDraft && autoOpenDraft && !currentSessionId && !draftOpen) {
            openNewSessionDraft();
        }
    }, [autoOpenDraft, currentSessionId, draftOpen, hostFeatures.newSessionDraft, openNewSessionDraft]);

    const activeTurnChangeRef = React.useRef<(turnId: string | null) => void>(() => {});
    const handleActiveTurnChange = React.useCallback((turnId: string | null) => {
        activeTurnChangeRef.current(turnId);
    }, []);

    const {
        scrollRef,
        notifyContentChange: handleMessageContentChange,
        getAnimationHandlers,
        goToBottom,
        scrollToBottomOnSend,
        releaseAutoFollow,
        restoreSnapshot,
        isPinned,
        isFollowingProgrammatically,
        showScrollButton,
    } = useChatAutoFollow({
        currentSessionId,
        viewportKey: sessionViewKey,
        sessionMessageCount,
        sessionIsWorking,
        isMobile,
        onActiveTurnChange: handleActiveTurnChange,
    });
    const promptSurface = promptAvailability.showReadOnlyBanner
        ? readOnlyPromptBanner
        : readOnly
            ? null
            : <ChatInput surface={composerSurface} scrollToBottom={scrollToBottomOnSend} submissionBlocked={promptAvailability.blockSubmission} />;

    const historyPrefix = useHostedSessionHistoryPrefix(historySessionIDs, currentSessionId, effectiveSessionDirectory);
    const viewportMessages = React.useMemo(() => {
        if (historyPrefix.length === 0) return sessionMessages;
        if (!currentSessionId) return historyPrefix;
        return [
            ...historyPrefix,
            createAssistantSessionDivider(currentSessionId),
            ...sessionMessages,
        ];
    }, [currentSessionId, historyPrefix, sessionMessages]);

    const timelineController = useChatTimelineController({
        sessionId: currentSessionId,
        messages: viewportMessages,
        historyMeta,
        scrollRef,
        messageListRef,
        loadMoreMessages,
        goToBottom,
        releaseAutoFollow,
        isPinned,
        showScrollButton,
    });
    const resumeToLatestInstant = React.useCallback(() => {
        goToBottom('instant');
    }, [goToBottom]);
    // Mobile loads older history via an explicit top button instead of a
    // scroll-position trigger (see handleHistoryScroll in the controller).
    const showLoadOlderButton = isMobileSurfaceRuntime()
        && timelineController.historySignals.canLoadEarlier;
    const timelineLoadEarlier = timelineController.loadEarlier;
    const handleLoadOlderClick = React.useCallback(() => {
        void timelineLoadEarlier({ userInitiated: true });
    }, [timelineLoadEarlier]);

    React.useEffect(() => {
        activeTurnChangeRef.current = timelineController.handleActiveTurnChange;
    }, [timelineController.handleActiveTurnChange]);

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
        resumeToBottom: timelineController.resumeToBottomInstant,
    });
    const handlePromptNavigatorSelect = React.useCallback((turnId: string) => {
        void navigation.scrollToTurnId(turnId, { behavior: 'smooth' });
    }, [navigation]);
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

    React.useEffect(() => {
        if (typeof window === 'undefined' || !currentSessionId) return;

        const handleForceScrollBottom = (event: Event) => {
            const customEvent = event as CustomEvent<{ sessionId?: string }>;
            if (customEvent.detail?.sessionId && customEvent.detail.sessionId !== currentSessionId) return;
            goToBottom('instant');
        };

        window.addEventListener(CHAT_FORCE_SCROLL_BOTTOM_EVENT, handleForceScrollBottom as EventListener);
        return () => {
            window.removeEventListener(CHAT_FORCE_SCROLL_BOTTOM_EVENT, handleForceScrollBottom as EventListener);
        };
    }, [currentSessionId, goToBottom]);

    React.useEffect(() => {
        if (typeof window === 'undefined' || !currentSessionId || isDesktopExpandedInput) {
            return;
        }

        const handleChatTurnKeyDown = (event: KeyboardEvent) => {
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
        };

        window.addEventListener('keydown', handleChatTurnKeyDown);
        return () => {
            window.removeEventListener('keydown', handleChatTurnKeyDown);
        };
    }, [currentSessionId, isDesktopExpandedInput, navigation, scrollRef]);

    React.useLayoutEffect(() => {
        const container = scrollRef.current;
        if (!container) return;

        const updateChatScrollHeight = () => {
            container.style.setProperty('--chat-scroll-height', `${container.clientHeight}px`);
        };

        updateChatScrollHeight();

        let rafId = 0;
        const scheduleUpdate = () => {
            if (rafId) return;
            rafId = requestAnimationFrame(() => {
                rafId = 0;
                updateChatScrollHeight();
            });
        };

        if (typeof ResizeObserver === 'undefined') {
            window.addEventListener('resize', scheduleUpdate);
            return () => {
                if (rafId) cancelAnimationFrame(rafId);
                window.removeEventListener('resize', scheduleUpdate);
            };
        }

        const resizeObserver = new ResizeObserver(scheduleUpdate);
        resizeObserver.observe(container);

        return () => {
            if (rafId) cancelAnimationFrame(rafId);
            resizeObserver.disconnect();
        };
    }, [currentSessionId, isDesktopExpandedInput, scrollRef]);

    const lastScrolledSessionRef = React.useRef<string | null>(null);

    const isSessionHydrating =
        Boolean(currentSessionId)
        && !hasUserBoundary
        && historyPrefix.length === 0
        && (
            !hasRenderableSessionSnapshot
            || sessionPrefetchInfo?.status === 'loading'
        );
    const hasSessionHistoryLoadError =
        sessionPrefetchInfo?.status === 'error'
        && !hasUserBoundary;

    React.useEffect(() => {
        if (!currentSessionId) return;
        if (lastScrolledSessionRef.current === currentSessionId) return;

        const hasHashTarget = typeof window !== 'undefined' && window.location.hash.length > 0;
        lastScrolledSessionRef.current = currentSessionId;
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
    }, [currentSessionId, releaseAutoFollow, restoreSnapshot]);

    React.useEffect(() => {
        setSessionIdentityEnsureRetry((current) => (
            current.key === sessionIdentityEnsureKey
                ? current
                : { key: sessionIdentityEnsureKey, attempt: 0 }
        ));
    }, [sessionIdentityEnsureKey]);

    React.useEffect(() => {
        if (!currentSessionId || sessionIdentityEnsureRetry.key !== sessionIdentityEnsureKey || !shouldEnsureChatSessionRenderable({
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
        currentSessionEntity,
        currentSessionId,
        effectiveSessionDirectory,
        ensureSessionRenderable,
        hasRenderableSessionSnapshot,
        sessionIdentityEnsureKey,
        sessionIdentityEnsureRetry,
    ]);

	if (forkTransition) {
		const stageKey =
			forkTransition.stage === 'preparing'
				? 'chat.forkTransition.preparing'
				: forkTransition.stage === 'copying'
					? 'chat.forkTransition.copying'
					: forkTransition.stage === 'opening'
						? 'chat.forkTransition.opening'
						: 'chat.forkTransition.loading';
		const stageOrder = ['preparing', 'copying', 'opening', 'loading'] as const;
		const stageIndex = Math.max(1, stageOrder.indexOf(forkTransition.stage) + 1);
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
			// No transform on this root: it would become the containing block for
			// the fullscreen composer's position:fixed visual-viewport pinning in
			// mobile browsers (see ChatInput's composerFormRef effect).
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
						isDesktopExpandedInput
							? 'flex-1 bg-background'
							: useCompactDraftLayout
								? 'bg-background px-0'
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
									onClick={() => void sync.syncSession(currentSessionId, true)}
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
                    <div className="absolute inset-0 overflow-y-auto overflow-x-hidden bg-background pt-6" style={CHAT_SCROLL_STYLE}>
                        <div className="space-y-4">
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
						isDesktopExpandedInput
							? 'flex-1 min-h-0 bg-background'
							: 'bg-background'
					)}
				>
                    {promptSurface}
				</div>
            </div>
        );
    }

	if (sessionMessages.length === 0 && historyPrefix.length === 0 && !sessionIsWorking) {
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
						isDesktopExpandedInput
							? 'flex-1 min-h-0 bg-background'
							: 'bg-background'
					)}
				>
                    {promptSurface}
				</div>
            </div>
        );
    }

	return (
		<div className="relative flex flex-col h-full bg-background">
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
                isLoadingOlder={timelineController.isLoadingOlder}
                sessionIsWorking={sessionIsWorking}
                streamingMessageId={streamingMessageId}
                activeStreamingPhase={activeStreamingPhase}
                retryOverlay={retryOverlay}
                handleMessageContentChange={handleMessageContentChange}
                getAnimationHandlers={getAnimationHandlers}
                handleHistoryScroll={timelineController.handleHistoryScroll}
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
                isLoadingOlderPrompts={timelineController.isLoadingOlder}
                onLoadEarlierPrompts={handleLoadOlderClick}
            />

            <div
                className={cn(
                    'relative z-10',
                    isDesktopExpandedInput
                        ? 'flex-1 min-h-0 bg-background'
                        : 'bg-background'
                )}
            >
                {!isDesktopExpandedInput && viewportMessages.length > 0 && (
                    <ScrollToBottomButton
                        visible={timelineController.showScrollToBottom}
                        onClick={navigation.resumeToLatest}
                    />
                )}
                {promptSurface}
            </div>

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
                isLoadingEarlier={timelineController.isLoadingOlder}
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

const RuntimeScopedChatContainer: React.FC<ChatContainerProps & { runtimeKey: string }> = ({ runtimeKey, host: _host, ...props }) => {
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

    React.useLayoutEffect(() => {
        committedSelectionIntentRef.current = selectionIntent;
        committedSelectionKeyRef.current = selectionKey;
        setSessionViewRenderState((current) => applySessionViewSelectionIntent(
            current,
            selectionIntent,
            cacheLimits,
        ));
    }, [cacheLimits, cacheNeedsTrim, selectionIntent, selectionKey]);

    const pendingSessionViewIntent = pendingSessionView?.intent ?? null;
    React.useLayoutEffect(() => {
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

    const handleSessionViewEstimateChange = React.useCallback((key: string, estimatedBytes: number) => {
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
    }, []);

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
                    historySessionIDs={host.historySessionIDs}
                    onRevertMessage={host.onRevertMessage}
                    warning={host.warning}
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

    return <RuntimeScopedChatContainer key={runtimeKey} {...props} runtimeKey={runtimeKey} />;
};
