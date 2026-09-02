import React from 'react';
import { useMutation } from '@tanstack/react-query';
import { useEvent } from '@reactuses/core';

import MessageList, { type MessageListHandle } from '@/components/chat/MessageList';
import { ReadOnlyPromptBanner } from '@/components/chat/ReadOnlyPromptBanner';
import ScrollToBottomButton from '@/components/chat/components/ScrollToBottomButton';
import { CHAT_TAIL_SPACER_DESKTOP_HEIGHT } from '@/components/chat/lib/scroll/chatTailSpacer';
import { SessionSurfaceContext, STRICT_READ_ONLY_SESSION_SURFACE_CAPABILITIES } from '@/components/chat/SessionSurfaceContext';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { OverlayScrollbar } from '@/components/ui/OverlayScrollbar';
import { ScrollShadow } from '@/components/ui/ScrollShadow';
import { toast } from '@/components/ui';
import { useHistoryUpwardIntent } from '@/hooks/lib/chatUpwardIntent';
import { useChatAutoFollow } from '@/hooks/useChatAutoFollow';
import { useI18n } from '@/lib/i18n';
import { getProviderModelDisplayName } from '@/lib/modelDisplay';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useConfigStore } from '@/stores/useConfigStore';
import { useFeatureFlagsStore } from '@/stores/useFeatureFlagsStore';
import { useStreamingStore } from '@/sync/streaming';
import {
    useDirectorySync,
    useSessionMessageCount,
    useSessionMessageLoadState,
    useSessionMessageRecords,
    useSessionMaterializationStatus,
    useSessionStatus,
    useSessionTranscriptPagination,
    useSyncDirectory,
} from '@/sync/sync-context';
import { useSync } from '@/sync/use-sync';
import {
    ensureTranscriptInitial,
    fetchTranscriptPreviousPage,
} from '@/sync/transcript-repository-runtime';
import {
    createContextPanelViewportRestoreIdentity,
    createContextPanelSessionViewKey,
    estimateContextPanelSessionBytes,
    normalizeContextPanelDirectory,
    resolveContextPanelEnsureForce,
    resolveContextPanelConfirmedParentViewKey,
    resolveContextPanelHasMore,
    resolveContextPanelPartialErrorRetry,
    resolveContextPanelPrependAnchor,
    resolveContextPanelPrependScrollTop,
    resolveContextPanelTranscriptState,
    shouldApplyContextPanelManualPrependCompensation,
    shouldConsumeContextPanelPrepend,
    shouldForceContextPanelEnsureOnFocus,
    shouldRequestContextPanelLoadOlder,
    shouldShowContextPanelLoadOlder,
    shouldRestoreContextPanelViewport,
    type ContextPanelTranscriptState,
    type ContextPanelPendingPrepend,
} from './contextPanelSessionSurface';
import { resolveContextPanelSessionExecution } from './contextPanelSessionExecution';

const CHAT_SCROLL_STYLE = {
    overflowAnchor: 'none',
    overscrollBehavior: 'contain',
    overscrollBehaviorY: 'contain',
} as const;
const LEGEND_SCROLL_DATASET = { scrollbar: 'chat', scrollShadow: 'true', orientation: 'vertical' } as const;

export type ContextPanelSessionTranscriptProps = {
    surfaceId: string;
    sessionId: string;
    directory: string;
    active: boolean;
    canNavigateBack: boolean;
    onNavigateSession: (sessionId: string, directory: string) => boolean | void;
    onNavigateBack: () => void;
    onEstimateBytes?: (viewportKey: string, estimatedBytes: number) => void;
};

const TranscriptState: React.FC<{ state: ContextPanelTranscriptState; error?: string; onRetry: () => void }> = ({ state, error, onRetry }) => {
    const { t } = useI18n();
    if (state === 'cold-loading' || state === 'working-empty') {
        return <div className="flex h-full items-center justify-center text-sm text-muted-foreground"><Icon name="loader-4" className="size-4 animate-spin" /></div>;
    }
    if (state === 'fatal-error' || state === 'directory-mismatch') {
        return (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-sm text-muted-foreground">
                <div className="text-center">{error || t('chat.emptyState.opencodeUnreachable')}</div>
                {state === 'fatal-error' ? <Button type="button" variant="secondary" size="sm" onClick={onRetry}>{t('chat.history.retry')}</Button> : null}
            </div>
        );
    }
    return <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">{t('chat.timeline.empty.session')}</div>;
};

const ContextPanelSessionTranscriptContent: React.FC<ContextPanelSessionTranscriptProps & { syncDirectory: string }> = (props) => {
    const { surfaceId, sessionId, directory, active, canNavigateBack, onNavigateSession, onNavigateBack, onEstimateBytes, syncDirectory } = props;
    const { t } = useI18n();
    const sync = useSync();
    const runtimeKey = getRuntimeKey();
    const normalizedDirectory = normalizeContextPanelDirectory(directory);
    const viewportKey = createContextPanelSessionViewKey(runtimeKey, surfaceId, normalizedDirectory, sessionId);
    const messageListRef = React.useRef<MessageListHandle | null>(null);
    const prependAnchorRef = React.useRef<ContextPanelPendingPrepend | null>(null);
    const prependRequestRef = React.useRef(0);
    const [completedPrependToken, setCompletedPrependToken] = React.useState<number | null>(null);
    const restoredViewportsRef = React.useRef(new Set<string>());
    const sessionMessageCount = useSessionMessageCount(sessionId, syncDirectory);
    const sessionMessages = useSessionMessageRecords(sessionId, syncDirectory);
    const providers = useConfigStore((state) => state.providers);
    const execution = React.useMemo(
        () => resolveContextPanelSessionExecution(sessionMessages),
        [sessionMessages],
    );
    const executionModelName = React.useMemo(() => {
        if (!execution.modelId) return t('common.unavailable');
        const provider = providers.find((entry) => entry.id === execution.providerId);
        const modelExists = provider?.models.some((model) => model.id === execution.modelId);
        return modelExists
            ? getProviderModelDisplayName(provider, execution.modelId) || execution.modelId
            : execution.modelId;
    }, [execution.modelId, execution.providerId, providers, t]);
    const sessionStatus = useSessionStatus(sessionId, syncDirectory);
    // Ticket 09 batch 1A: materialization from TranscriptRepository projection.
    const isRenderable = useSessionMaterializationStatus(sessionId, syncDirectory).renderable;
    const hasConfirmedParent = useDirectorySync(
        (state) => Boolean(state.session.find((session) => session.id === sessionId)?.parentID),
        syncDirectory,
    );
    const [confirmedParentViewKey, setConfirmedParentViewKey] = React.useState<string | null>(null);
    React.useLayoutEffect(() => {
        setConfirmedParentViewKey((previousViewKey) => (
            resolveContextPanelConfirmedParentViewKey(previousViewKey, viewportKey, hasConfirmedParent)
        ));
    }, [hasConfirmedParent, viewportKey]);
    const showReadOnlyPromptBanner = hasConfirmedParent || confirmedParentViewKey === viewportKey;
    // Ticket 09: request lifecycle from repository (no session-prefetch).
    const prefetch = useSessionMessageLoadState(sessionId, syncDirectory);
    const streamingMessageId = useStreamingStore(
        (state) => state.streamingMessageIds.get(sessionId) ?? null,
    );
    const activeStreamingPhase = useStreamingStore(
        (state) => streamingMessageId ? state.messageStreamStates.get(streamingMessageId)?.phase ?? null : null,
    );
    const sessionIsWorking = sessionStatus?.type === 'busy' || sessionStatus?.type === 'retry';
    const legendTimelineEnabled = useFeatureFlagsStore((state) => state.legendTimelineEnabled);
    const [legendShowScrollButton, setLegendShowScrollButton] = React.useState(false);
    const [legendFollowReleased, setLegendFollowReleased] = React.useState(false);
    const [timelineHistoryAnchorToken, setTimelineHistoryAnchorToken] = React.useState(0);
    const { scrollRef, notifyContentChange, getAnimationHandlers, goToBottom, restoreSnapshot, showScrollButton } = useChatAutoFollow({
        // The legend timeline owns its scroll position. Leaving auto-follow on
        // would put two writers on one container.
        enabled: active && !legendTimelineEnabled,
        currentSessionId: sessionId,
        viewportKey,
        sessionMessageCount,
        sessionIsWorking,
        isMobile: false,
    });
    React.useEffect(() => {
        setLegendShowScrollButton(false);
        setLegendFollowReleased(false);
    }, [sessionId]);
    const handleTimelineIsAtEndChange = useEvent((atEnd: boolean, nextShowScrollButton?: boolean) => {
        if (atEnd) setLegendFollowReleased(false);
        if (nextShowScrollButton !== undefined) setLegendShowScrollButton(nextShowScrollButton);
    });
    const resumeToLatest = useEvent((mode: 'instant' | 'smooth' = 'instant') => {
        setLegendFollowReleased(false);
        messageListRef.current?.scrollToBottom();
        goToBottom(mode);
    });
    const handleLegendUpwardIntent = useEvent(() => {
        setLegendFollowReleased(true);
    });
    useHistoryUpwardIntent({
        scrollRef,
        enabled: legendTimelineEnabled,
        onUpwardIntent: handleLegendUpwardIntent,
    });
    const ensureSession = useEvent((reason: 'active' | 'retry') => {
        void sync.ensureSessionRenderable(sessionId, resolveContextPanelEnsureForce(reason));
    });

    React.useEffect(() => {
        if (active) ensureSession('active');
    }, [active, ensureSession]);
    React.useEffect(() => {
        if (typeof window === 'undefined') return;
        const recoverIfEmpty = () => {
            const visible = document.visibilityState !== 'hidden' && document.hasFocus();
            if (!shouldForceContextPanelEnsureOnFocus({
                active,
                visible,
                messageCount: sessionMessageCount,
            })) return;
            ensureSession('retry');
        };
        window.addEventListener('focus', recoverIfEmpty);
        document.addEventListener('visibilitychange', recoverIfEmpty);
        return () => {
            window.removeEventListener('focus', recoverIfEmpty);
            document.removeEventListener('visibilitychange', recoverIfEmpty);
        };
    }, [active, ensureSession, sessionMessageCount]);
    React.useEffect(() => {
        onEstimateBytes?.(viewportKey, estimateContextPanelSessionBytes(sessionMessageCount));
    }, [onEstimateBytes, sessionMessageCount, viewportKey]);
    React.useEffect(() => {
        if (!shouldRestoreContextPanelViewport(restoredViewportsRef.current, sessionId, viewportKey, isRenderable)) return;
        const identity = createContextPanelViewportRestoreIdentity(sessionId, viewportKey);
        restoredViewportsRef.current.add(identity);
        void restoreSnapshot();
    }, [isRenderable, restoreSnapshot, sessionId, viewportKey]);
    React.useLayoutEffect(() => {
        prependAnchorRef.current = null;
        setCompletedPrependToken(null);
    }, [viewportKey]);
    React.useLayoutEffect(() => {
        const pending = prependAnchorRef.current;
        const element = scrollRef.current;
        if (!shouldConsumeContextPanelPrepend(pending, completedPrependToken, viewportKey)) return;
        if (!element || !shouldApplyContextPanelManualPrependCompensation(Boolean(messageListRef.current?.isHistoryVirtualized()))) {
            prependAnchorRef.current = null;
            return;
        }
        element.scrollTop = resolveContextPanelPrependScrollTop(pending.anchor, element.scrollHeight);
        prependAnchorRef.current = null;
    }, [completedPrependToken, scrollRef, sessionMessages, viewportKey]);

    const sessionDir = React.useMemo(() => ({ directory: normalizedDirectory }), [normalizedDirectory]);
    // Ticket 02: pagination from TranscriptRepository projection.
    const transcriptPagination = useSessionTranscriptPagination(sessionId, syncDirectory);
    const historyBoundary = transcriptPagination.boundary;
    const hasMore = resolveContextPanelHasMore(historyBoundary);
    // Background materialize/prefetch loading — gate concurrent load-more only.
    // Button spinner tracks the mutation below, never stuck prefetch status.
    const backgroundLoading = prefetch?.status === 'loading' || sync.isLoading(sessionId, sessionDir);
    const loadOlderMutation = useMutation({
        mutationKey: ['context-panel-load-older', runtimeKey, normalizedDirectory, sessionId],
        mutationFn: async () => {
            // Ticket 09: Query previous-page (shared flight with Chat).
            if (historyBoundary.kind === 'unknown') {
                await ensureTranscriptInitial(syncDirectory, sessionId);
            }
            await fetchTranscriptPreviousPage(syncDirectory, sessionId);
        },
    });
    const isLoadingOlder = loadOlderMutation.isPending;
    // Event-time click handler — shared UI never uses React.useCallback; useEvent
    // keeps stable identity and always reads latest hasMore/sessionDir.
    const loadOlder = useEvent(() => {
        if (!shouldRequestContextPanelLoadOlder(hasMore, isLoadingOlder || backgroundLoading)) return;
        if (loadOlderMutation.isPending) return;
        if (legendTimelineEnabled) {
            setTimelineHistoryAnchorToken((current) => current + 1);
        }
        const token = prependRequestRef.current + 1;
        prependRequestRef.current = token;
        const element = scrollRef.current;
        const anchor = element ? resolveContextPanelPrependAnchor({
            hasMore,
            isLoading: isLoadingOlder,
            historyVirtualized: Boolean(messageListRef.current?.isHistoryVirtualized()),
            scrollHeight: element.scrollHeight,
            scrollTop: element.scrollTop,
        }) : null;
        prependAnchorRef.current = anchor ? { token, viewportKey, anchor } : null;
        void loadOlderMutation.mutateAsync().then(
            () => {
                setCompletedPrependToken(token);
            },
            () => {
                setCompletedPrependToken(token);
                toast.error(t('chat.history.loadOlderFailed'));
            },
        );
    });
    const transcriptState = resolveContextPanelTranscriptState({
        directoryMatches: true,
        requested: active,
        renderable: isRenderable,
        messageCount: sessionMessages.length,
        working: sessionIsWorking,
        error: prefetch?.status === 'error' ? prefetch.error : undefined,
    });
    const surface = React.useMemo(() => ({
        kind: 'panel' as const,
        surfaceId,
        sessionId,
        directory: normalizedDirectory,
        active,
        capabilities: STRICT_READ_ONLY_SESSION_SURFACE_CAPABILITIES,
        navigateSession: onNavigateSession,
    }), [active, normalizedDirectory, onNavigateSession, sessionId, surfaceId]);
    const retryPartialError = useEvent(() => {
        if (resolveContextPanelPartialErrorRetry(hasMore) === 'load-more') {
            loadOlder();
            return;
        }
        ensureSession('retry');
    });
    const partialErrorRow = transcriptState === 'partial-error' ? (
        <div className="flex items-center justify-center gap-2 px-3 py-2 text-sm text-[var(--status-error-foreground)]">
            <span className="truncate">{prefetch?.error}</span>
            <Button type="button" variant="secondary" size="xs" onClick={retryPartialError}>{t('chat.history.retry')}</Button>
        </div>
    ) : null;
    const loadOlderRow = shouldShowContextPanelLoadOlder(hasMore) ? (
        <div className="flex justify-center pt-3 pb-1">
            <Button type="button" variant="secondary" size="sm" onClick={loadOlder} disabled={isLoadingOlder}>
                {isLoadingOlder ? <Icon name="loader-4" className="size-4 animate-spin" /> : null}
                {t('chat.history.loadOlder')}
            </Button>
        </div>
    ) : null;
    const tailSpacer = (
        <div
            className="flex-shrink-0"
            style={{ height: CHAT_TAIL_SPACER_DESKTOP_HEIGHT }}
            aria-hidden="true"
        />
    );
    const transcriptList = (
        <MessageList
            ref={messageListRef}
            sessionKey={sessionId}
            virtualizerKey={viewportKey}
            messages={sessionMessages}
            sessionIsWorking={sessionIsWorking}
            activeStreamingMessageId={streamingMessageId}
            activeStreamingPhase={activeStreamingPhase}
            onMessageContentChange={notifyContentChange}
            getAnimationHandlers={getAnimationHandlers}
            isLoadingOlder={isLoadingOlder}
            scrollToBottom={() => resumeToLatest('instant')}
            scrollRef={scrollRef}
            directory={syncDirectory}
            enableSendPark={false}
            timelineScrollClassName="absolute inset-0 z-0 chat-scroll overlay-scrollbar-target"
            timelineScrollStyle={CHAT_SCROLL_STYLE}
            timelineScrollDataset={LEGEND_SCROLL_DATASET}
            timelineFollowEnabled={!legendFollowReleased}
            timelineHistoryAnchorToken={timelineHistoryAnchorToken}
            timelineOnIsAtEndChange={handleTimelineIsAtEndChange}
            headerSlot={legendTimelineEnabled ? <>{partialErrorRow}{loadOlderRow}</> : undefined}
            footerSlot={legendTimelineEnabled ? tailSpacer : undefined}
        />
    );
    const scrollToBottomButton = (
        <ScrollToBottomButton
            visible={legendTimelineEnabled ? legendShowScrollButton : showScrollButton}
            onClick={() => resumeToLatest('smooth')}
        />
    );

    return (
        <SessionSurfaceContext.Provider value={surface}>
            <div className="relative flex h-full min-h-0 flex-col bg-background" data-context-session-surface="true" data-session-id={sessionId} data-surface-id={surfaceId}>
                {canNavigateBack ? <Button type="button" variant="outline" size="xs" onClick={onNavigateBack} className="absolute left-3 top-3 z-20 !font-normal bg-[var(--surface-background)]/95" aria-label={t('chat.container.returnToParent.aria')} title={t('chat.container.returnToParent.title')}><Icon name="arrow-left" className="h-4 w-4" />{t('chat.container.returnToParent.label')}</Button> : null}
                <div className="relative min-h-0 flex-1">
                    {transcriptState === 'cold-loading' || transcriptState === 'working-empty' || transcriptState === 'authoritative-empty' || transcriptState === 'fatal-error' ? <TranscriptState state={transcriptState} error={prefetch?.error} onRetry={() => ensureSession('retry')} /> : legendTimelineEnabled ? (
                        <>
                            <div className="absolute inset-0">
                                {transcriptList}
                                <OverlayScrollbar containerRef={scrollRef} userIntentOnly observeMutations={false} />
                            </div>
                            {scrollToBottomButton}
                        </>
                    ) : (
                        <>
                            <ScrollShadow ref={scrollRef} className="absolute inset-0 overflow-y-auto overflow-x-hidden chat-scroll overlay-scrollbar-target" observeMutations={false} data-scroll-shadow="true" data-scrollbar="chat">
                                <div className="relative min-h-full">
                                    {partialErrorRow}
                                    {loadOlderRow}
                                    {transcriptList}
                                    {tailSpacer}
                                </div>
                            </ScrollShadow>
                            {scrollToBottomButton}
                        </>
                    )}
                </div>
                {showReadOnlyPromptBanner ? <ReadOnlyPromptBanner agentName={execution.agentName} providerId={execution.providerId} modelId={execution.modelId} modelName={executionModelName} /> : null}
            </div>
        </SessionSurfaceContext.Provider>
    );
};

export const ContextPanelSessionTranscript: React.FC<ContextPanelSessionTranscriptProps> = (props) => {
    const syncDirectory = useSyncDirectory();
    const { t } = useI18n();
    const normalizedDirectory = normalizeContextPanelDirectory(props.directory);
    const directoryMatches = normalizedDirectory === normalizeContextPanelDirectory(syncDirectory);
    const surface = React.useMemo(() => ({
        kind: 'panel' as const,
        surfaceId: props.surfaceId,
        sessionId: props.sessionId,
        directory: normalizedDirectory,
        active: props.active,
        capabilities: STRICT_READ_ONLY_SESSION_SURFACE_CAPABILITIES,
        navigateSession: props.onNavigateSession,
    }), [normalizedDirectory, props.active, props.onNavigateSession, props.sessionId, props.surfaceId]);
    if (!directoryMatches) {
        return <SessionSurfaceContext.Provider value={surface}><div className="h-full" data-context-session-surface="true" data-session-id={props.sessionId} data-surface-id={props.surfaceId}><TranscriptState state="directory-mismatch" onRetry={() => undefined} error={t('chat.emptyState.opencodeUnreachable')} /></div></SessionSurfaceContext.Provider>;
    }
    return <ContextPanelSessionTranscriptContent {...props} syncDirectory={syncDirectory} />;
};
