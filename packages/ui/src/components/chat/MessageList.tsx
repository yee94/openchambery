import React from 'react';
import { useEvent, useEventListener, useInterval, useIsomorphicLayoutEffect, useResizeObserver, useUnmount } from '@reactuses/core';
import type { Part } from '@/lib/opencode/v2-types';
import { elementScroll, useVirtualizer as useTanstackVirtualizer, type ReactVirtualizer, type VirtualItem } from '@tanstack/react-virtual';
import { isAssistantSessionDivider } from './hostedSessionHistory';
import { useI18n } from '@/lib/i18n';
import { CompactionDisclosureContext, createCompactionDisclosureStore } from './message/compactionDisclosureState';

import ChatMessage from './ChatMessage';
import { computeAssistantTps } from './message/assistantTps';
import { StatusRowContainer } from './StatusRowContainer';
import { areOptionalRenderRelevantMessagesEqual, areRelevantTurnGroupingContextsEqual, areRenderRelevantMessagesEqual } from './message/renderCompare';
import TurnItem from './components/TurnItem';
import type { AnimationHandlers, ContentChangeReason } from '@/hooks/useChatAutoFollow';
import type { ChatMessageEntry, TurnRecord, TurnGroupingContext } from './lib/turns/types';
import { useTurnRecords } from './hooks/useTurnRecords';
import { applyRetryOverlay } from './lib/turns/applyRetryOverlay';
import { buildLiveStreamingEntry } from './lib/turns/streamingTailEntry';
import { splitTimelineRenderEntries } from './lib/turns/timelineRenderEntries';
import { getNormalizedMessageForDisplay, isCompactionCommandMessage } from './lib/messageDisplayNormalization';
import { useUIStore } from '@/stores/useUIStore';
import { FadeInDisabledProvider } from './message/FadeInOnReveal';
import {
    clearConsumedUserSendAnimation,
    resolveConsumedSendMessageId,
} from '@/lib/userSendAnimation';
import { streamPerfCount, streamPerfMeasure } from '@/stores/utils/streamDebug';
import type { StreamPhase } from './message/types';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useSessionParts } from '@/sync/sync-context';
import { isMobileSurfaceRuntime } from '@/lib/runtimeSurface';
import type { ReviewTransferDirection } from '@/lib/reviewFlow';
import { scheduleAfterPaintTask } from '@/lib/afterPaintTaskQueue';
import { useRenderPhaseCallback } from '@/hooks/useRenderPhaseCallback';
import { getInitialHistoryOverscan, getNextHistoryOverscan } from './lib/historyOverscan';
import { DeferredToolHydrationProvider } from './message/parts/DeferredToolHydrationProvider';
import {
    applyAuthoritativeTaskSessionIdToSubtaskParts,
    readTaskSessionIdFromOutput,
    readTaskSessionIdFromRecord,
} from './message/parts/taskToolModel';
import { MarkdownHydrationProvider } from './markdown/MarkdownHydrationProvider';
import { SessionSurfaceContext, useSessionSurface } from './SessionSurfaceContext';
import {
    createInitialMarkdownHydratedKeys,
    ensureNewestMarkdownKeyHydrated,
    getMarkdownHydrationBatch,
    pruneMarkdownHydratedKeys,
    readMarkdownHydrationRestore,
    writeMarkdownHydrationRestore,
    type MarkdownHydrationScrollDirection,
} from './lib/markdownHydrationWindow';
import { mergeMarkdownPinRevealStyle, resolveMarkdownPinRevealKeys } from './lib/markdownPinReveal';
import { installBatchedResizeItem } from './lib/batchResizeUpdates';
import { shouldAdjustHistoryScrollOnItemSizeChange } from './lib/scroll/historyItemSizeAdjustment';
import { useMarkdownPinReveal } from './hooks/useMarkdownPinReveal';
import {
    USER_SHELL_MARKER,
    isUserShellMarkerMessage,
    getShellBridgeAssistantDetails,
    type ShellBridgeDetails,
} from './lib/shellBridge';
import { isAssistantMessageCompleted, resolveVisibleSortedAssistants } from './lib/visibleSortedAssistants';
import { isRestartNotice } from './message/assistantErrorPresentation';
import { extractTextContent, filterVisibleParts } from './message/partUtils';
import {
    readUserMessageHeaderIdentity,
    resolvePendingAssistantHeader,
    shouldShowPendingAssistantHeader,
} from './lib/pendingAssistantHeader';
import {
    resolveActivityExpansionDisposition,
    resolveDefaultActivityExpanded,
    resolveToggledActivityExpanded,
    resolveTurnActivityPresentation,
    resolveTurnSettledForPresentation,
    shouldTightenWorkingBottomGap,
} from './lib/activityExpansion';

// Re-export pure expansion helpers for existing MessageList.* tests.
/* eslint-disable react-refresh/only-export-components -- pure helpers re-exported for MessageList.* tests */
export {
    resolveActivityExpansionDisposition,
    resolveDefaultActivityExpanded,
    resolveToggledActivityExpanded,
    resolveTurnActivityPresentation,
    resolveTurnSettledForPresentation,
    shouldTightenWorkingBottomGap,
};
/* eslint-enable react-refresh/only-export-components */

// eslint-disable-next-line react-refresh/only-export-components
export const resolveTurnActivityExpandedByDefault = (input: {
    expansionDisposition: TurnRecord['completionDisposition'] | undefined;
    activityRenderMode: 'collapsed' | 'summary';
    isLastTurn: boolean;
    isActivelyProcessing: boolean;
    hasConfirmedFinalBody: boolean;
}): boolean => {
    // Live processing / last-turn active always starts expanded so the user can
    // watch in-progress work. Settled turns follow activityRenderMode.
    if (input.isActivelyProcessing || input.expansionDisposition === 'active') {
        return true;
    }
    return resolveDefaultActivityExpanded(
        input.expansionDisposition,
        input.activityRenderMode,
        {
            isLastTurn: input.isLastTurn,
            hasConfirmedFinalBody: input.hasConfirmedFinalBody,
        },
    );
};

const resolveHistoryVirtualizationThreshold = (): number => isMobileSurfaceRuntime() ? 5 : 12;
const TIMELINE_CACHE_LIMIT = 16;

const sameKeys = (a: readonly string[] | undefined, b: readonly string[] | undefined): boolean => {
    if (a === b) return true;
    if (!a || !b) return false;
    if (a.length !== b.length) return false;
    return a.every((key, index) => key === b[index]);
};

// --- History virtualization (@tanstack/react-virtual) ----------------------
// The history list virtualizes with @tanstack/react-virtual on all surfaces.
// Chat contract lives in the core (virtual-core ≥ 3.16 / react-virtual ≥ 3.14):
//   - anchorTo: 'end' — key-stable prepend preservation + end-pin on last-item growth
//   - followOnAppend — follow new rows only when already within scrollEndThreshold
//   - scrollToEnd / isAtEnd / getDistanceFromEnd — jump-to-latest + pin helpers
//   - shouldAdjustHistoryScrollOnItemSizeChange — core's default (3.17.6+) first
//     measure / fully-above remeasure rule, but also while scrolling backward;
//     wasAtEnd path pins total-size growth without app-level compensation
// iOS touch/momentum deferral for scroll adjustments also lives in core.
type TanstackVirtualizerInstance = ReactVirtualizer<HTMLDivElement, HTMLDivElement>;
type HistoryEngine = 'none' | 'tanstack';

// Summary mode keeps activity rows open — turns are tall. Collapsed mode shows
// only the disclosure chrome (+ user prompt / final text), so the cold estimate
// must start much lower: an overestimate on every newly mounted row triggers
// first-measurement scroll corrections that re-enter the scroll handler and
// read as upward-scroll flicker (Chrome traces: Virtualizer.resizeItem →
// applyScrollAdjustment → scroll EventDispatch).
const TANSTACK_ESTIMATED_ENTRY_SIZE_SUMMARY = 320;
const TANSTACK_ESTIMATED_ENTRY_SIZE_COLLAPSED = 168;
const TANSTACK_OVERSCAN = 8;
// Touch flings cover more distance between paints than desktop wheels; a
// larger window keeps fast mobile scrolling over mounted rows.
const TANSTACK_MOBILE_OVERSCAN = 16;
// Preload reaches past the fold on both sides so a row is normally hydrated
// before it is ever painted. Releases are metered per commit: a settled list
// can afford a wider burst, while a scrolling list stays near one row per
// commit so no single frame swaps a screenful of placeholders at once.
const MARKDOWN_PRELOAD_ENTRIES = 6;
// Collapsed packs more turns into the viewport; a fixed 6-row preload window
// trails the fold during fast upward travel and paints Markdown skeletons.
const MARKDOWN_PRELOAD_ENTRIES_COLLAPSED = 12;
const MARKDOWN_PRELOAD_RELEASE_IDLE = 4;
const MARKDOWN_PRELOAD_RELEASE_SCROLLING = 1;
// Collapsed upward travel needs a thicker off-screen pipeline so scroll-end
// has less deferred work left in the viewport.
const MARKDOWN_PRELOAD_RELEASE_SCROLLING_COLLAPSED = 2;
// Visible settle budget per idle commit. Summary viewports are usually ≤ this;
// collapsed denser ranges meter across frames (trace2: unmetered settle was
// a ~480ms React commit of ChatMessage trees right after GestureScrollEnd).
const MARKDOWN_VISIBLE_RELEASE_IDLE = 6;
const MARKDOWN_VISIBLE_RELEASE_IDLE_COLLAPSED = 4;
const resolveTanstackOverscan = (): number => (
    isMobileSurfaceRuntime() ? TANSTACK_MOBILE_OVERSCAN : TANSTACK_OVERSCAN
);
// Post-prepend anchor hold: measurements of freshly
// prepended rows settle over multiple frames, so a single restore can be
// invalidated by the next measurement pass. Re-assert the anchor until it
// holds still for STABLE_FRAMES consecutive frames, giving up at MAX_FRAMES.
const ANCHOR_HOLD_STABLE_FRAMES = 30;
const ANCHOR_HOLD_MAX_FRAMES = 180;
// Adaptive estimate bounds: only trust the session average once a few rows
// are measured, and keep it inside sane turn-height bounds. Collapsed mode
// converges with fewer samples so the first upward fling does not keep
// correcting against the cold default.
// "At bottom" tolerance for resize-adjustment decisions.
const TANSTACK_AT_END_THRESHOLD_PX = 80;

// Quiet-window prepend on mobile: while a touch drag or momentum scroll is
// active, iOS owns the scroll position and ANY geometry change above the
// viewport races against the native animation — a race that compensation
// logic can only lose sometimes. So freshly loaded older history is held
// (data already fetched, store already updated) and inserted into the
// rendered list only once the gesture goes quiet, including near the top.
// A timeout must not force a geometry change underneath a held finger.
const HISTORY_PREPEND_QUIET_MS = 160;
const HISTORY_PREPEND_MONITOR_INTERVAL_MS = 90;

// A commit is a deferable prepend when older entries were inserted strictly
// above the known content: the previous first key still exists deeper in the
// list and the tail is unchanged. Anything else renders immediately.
const isPrependAboveCommit = (previous: RenderEntry[], next: RenderEntry[]): boolean => {
    if (previous.length === 0 || next.length <= previous.length) return false;
    if (previous[previous.length - 1]?.key !== next[next.length - 1]?.key) return false;
    const previousFirstKey = previous[0]?.key;
    const insertedIndex = next.findIndex((entry) => entry.key === previousFirstKey);
    return insertedIndex > 0;
};

// eslint-disable-next-line react-refresh/only-export-components
export const createTanstackTimelineSnapshotCache = <T,>(limit: number) => {
    const cache = new Map<string, { keys: readonly string[]; items: T[] }>();

    return {
        read: (virtualizerKey: string, keys: readonly string[]): T[] | undefined => {
            const entry = cache.get(virtualizerKey);
            if (!entry) return undefined;
            if (sameKeys(entry.keys, keys)) return entry.items;
            cache.delete(virtualizerKey);
            return undefined;
        },
        write: (virtualizerKey: string, keys: readonly string[], items: T[]): void => {
            if (keys.length === 0) return;
            cache.delete(virtualizerKey);
            cache.set(virtualizerKey, { keys: keys.slice(), items });
            while (cache.size > limit) {
                const oldest = cache.keys().next().value;
                if (typeof oldest !== 'string') break;
                cache.delete(oldest);
            }
        },
    };
};

const tanstackTimelineCache = createTanstackTimelineSnapshotCache<VirtualItem>(TIMELINE_CACHE_LIMIT);

// eslint-disable-next-line react-refresh/only-export-components
export const buildMeasurementSeedFromSizes = (
    keys: readonly string[],
    sizes: ReadonlyMap<string, number>,
    estimate: number,
): VirtualItem[] => {
    if (sizes.size === 0) return [];
    let start = 0;
    return keys.map((key, index) => {
        const size = sizes.get(key) ?? estimate;
        const item: VirtualItem = { index, key, start, size, end: start + size, lane: 0 };
        start += size;
        return item;
    });
};

// eslint-disable-next-line react-refresh/only-export-components
export const resolveMessageListKeys = (sessionKey: string, virtualizerKey?: string) => ({
    sessionKey,
    virtualizerKey: virtualizerKey ?? sessionKey,
});

/** Cold row-height estimate for unmeasured virtualizer entries. */
// eslint-disable-next-line react-refresh/only-export-components
export const resolveTanstackEstimatedEntrySize = (
    activityRenderMode: 'collapsed' | 'summary',
): number => (
    activityRenderMode === 'collapsed'
        ? TANSTACK_ESTIMATED_ENTRY_SIZE_COLLAPSED
        : TANSTACK_ESTIMATED_ENTRY_SIZE_SUMMARY
);

/**
 * Timeline measurement snapshots are geometry for one activity density. Sharing
 * a summary-mode cache with collapsed mounts seeds every row ~2× too tall and
 * causes a cascade of first-measurement scroll corrections on the next open.
 */
// eslint-disable-next-line react-refresh/only-export-components
export const resolveTimelineVirtualizerCacheKey = (
    virtualizerKey: string,
    activityRenderMode: 'collapsed' | 'summary',
): string => `${virtualizerKey}::activity:${activityRenderMode}`;

/**
 * Context-panel / sidebar open shrinks the transcript column and reflows every
 * wrap. Row ResizeObservers are supposed to push the new heights into
 * virtual-core, but Electron 41 often skips those callbacks (compositor /
 * contain:layout), so itemSizeCache keeps the wide-column sizes and later
 * turns paint on top of earlier ones. A column-width change is the signal to
 * drop that cache; the next measureElement pass reads live offsetHeight.
 */
// eslint-disable-next-line react-refresh/only-export-components
export const shouldInvalidateVirtualizerMeasurementsOnColumnResize = (
    previousWidth: number | null,
    nextWidth: number,
): boolean => {
    if (!Number.isFinite(nextWidth) || nextWidth <= 0) return false;
    if (previousWidth === null) return false;
    return Math.round(previousWidth) !== Math.round(nextWidth);
};

/**
 * History rows are in normal flow (padding, not transform) so sticky user
 * headers still stick to the chat scroller. The live tail is a sibling after
 * this frame. A fixed `height: totalSize` box clips the reserved range: when a
 * visible row is taller than its cached size, the extra pixels overflow onto
 * the tail and later turns paint on top of earlier ones. `minHeight` plus
 * padding for the unrendered range lets an underestimated window grow and
 * push the tail down instead.
 */
export type TanstackHistoryFrameStyle = {
    marginTop: number;
    paddingTop: number;
    paddingBottom: number;
    minHeight: number;
};

// eslint-disable-next-line react-refresh/only-export-components
export const resolveTanstackHistoryFrameStyle = (
    startOffset: number,
    lastEnd: number,
    totalSize: number,
): TanstackHistoryFrameStyle => {
    const top = Number.isFinite(startOffset) ? Math.max(0, startOffset) : 0;
    const end = Number.isFinite(lastEnd) ? Math.max(top, lastEnd) : top;
    const total = Number.isFinite(totalSize) ? Math.max(0, totalSize) : 0;
    return {
        marginTop: Number.isFinite(startOffset) ? Math.min(0, startOffset) : 0,
        paddingTop: top,
        paddingBottom: Math.max(0, total - end),
        minHeight: total,
    };
};

// eslint-disable-next-line react-refresh/only-export-components
export const applyTanstackHistoryFrameMinHeight = (
    element: HTMLElement | null,
    totalSize: number,
): void => {
    if (!element) return;
    const next = `${Math.max(0, Number.isFinite(totalSize) ? totalSize : 0)}px`;
    if (element.style.height !== '') {
        element.style.height = '';
    }
    if (element.style.minHeight !== next) {
        element.style.minHeight = next;
    }
};

/** How many rows past each fold edge may start Markdown hydration. */
// eslint-disable-next-line react-refresh/only-export-components
export const resolveMarkdownPreloadEntries = (
    activityRenderMode: 'collapsed' | 'summary',
    visibleCount: number = 0,
): number => {
    const base = activityRenderMode === 'collapsed'
        ? MARKDOWN_PRELOAD_ENTRIES_COLLAPSED
        : MARKDOWN_PRELOAD_ENTRIES;
    // Never let the preload window trail a denser visible range (collapsed).
    return Math.max(base, Math.max(0, Math.floor(visibleCount)));
};

/** Off-screen preload releases allowed while the list is actively scrolling. */
// eslint-disable-next-line react-refresh/only-export-components
export const resolveMarkdownPreloadReleaseWhileScrolling = (
    activityRenderMode: 'collapsed' | 'summary',
): number => (
    activityRenderMode === 'collapsed'
        ? MARKDOWN_PRELOAD_RELEASE_SCROLLING_COLLAPSED
        : MARKDOWN_PRELOAD_RELEASE_SCROLLING
);

/** Visible-row hydration budget once scrolling has settled. */
// eslint-disable-next-line react-refresh/only-export-components
export const resolveMarkdownVisibleReleaseLimit = (
    activityRenderMode: 'collapsed' | 'summary',
): number => (
    activityRenderMode === 'collapsed'
        ? MARKDOWN_VISIBLE_RELEASE_IDLE_COLLAPSED
        : MARKDOWN_VISIBLE_RELEASE_IDLE
);

// eslint-disable-next-line react-refresh/only-export-components
export const syncCurrentHistoryVirtualization = (
    state: { current: boolean },
    historyVirtualized: boolean,
): void => {
    state.current = historyVirtualized;
};

const readTanstackTimelineCache = (cacheKey: string, keys: readonly string[]): VirtualItem[] | undefined => {
    return tanstackTimelineCache.read(cacheKey, keys);
};

const writeTanstackTimelineCache = (
    cacheKey: string,
    keys: readonly string[],
    virtualizer: TanstackVirtualizerInstance | null | undefined,
): void => {
    if (!virtualizer || keys.length === 0) return;
    tanstackTimelineCache.write(cacheKey, keys, virtualizer.takeSnapshot());
};

const resolveMessageRole = (message: ChatMessageEntry): string | null => {
    const info = message.info as unknown as { clientRole?: string | null | undefined; role?: string | null | undefined };
    return (typeof info.clientRole === 'string' ? info.clientRole : null)
        ?? (typeof info.role === 'string' ? info.role : null)
        ?? null;
};

const normalizeCompactionSummaryMessage = (
    message: ChatMessageEntry,
    compactionCommandIds: Set<string>,
): ChatMessageEntry => {
    const role = resolveMessageRole(message);
    if (role !== 'system') {
        return message;
    }

    const parentID = getMessageParentId(message);
    if (!parentID || !compactionCommandIds.has(parentID)) {
        return message;
    }

    const info = message.info as unknown as { clientRole?: string | null | undefined };
    if (info.clientRole === 'assistant') {
        return message;
    }

    return {
        ...message,
        info: ({
            ...(message.info as unknown as Record<string, unknown>),
            clientRole: 'assistant',
        } as unknown as typeof message.info),
    };
};

const isUserSubtaskMessage = (message: ChatMessageEntry | undefined): boolean => {
    if (!message) return false;
    if (resolveMessageRole(message) !== 'user') return false;
    return message.parts.some((part) => part?.type === 'subtask');
};

const getMessageId = (message: ChatMessageEntry | undefined): string | null => {
    if (!message) return null;
    const id = (message.info as unknown as { id?: unknown }).id;
    return typeof id === 'string' && id.trim().length > 0 ? id : null;
};

const getMessageParentId = (message: ChatMessageEntry): string | null => {
    const parentID = (message.info as unknown as { parentID?: unknown }).parentID;
    return typeof parentID === 'string' && parentID.trim().length > 0 ? parentID : null;
};

const isInsideStuckSticky = (node: HTMLElement, container: HTMLElement, containerTop: number): boolean => {
    if (typeof window === 'undefined') return false;

    let current: HTMLElement | null = node;
    while (current && current !== container) {
        const computed = window.getComputedStyle(current);
        if (computed.position === 'sticky' && current.getBoundingClientRect().top <= containerTop + 1) {
            return true;
        }
        current = current.parentElement;
    }

    return false;
};

type ViewportMessageAnchor = {
    messageId: string;
    offsetTop: number;
};

type VirtualizationTransitionAnchor = ViewportMessageAnchor & {
    entryKey: string;
    entryStart: number;
    attempts: number;
};

const findMessageElement = (scope: ParentNode, messageId: string): HTMLElement | null => {
    return Array.from(scope.querySelectorAll<HTMLElement>('[data-message-id]')).find(
        (node) => node.dataset.messageId === messageId,
    ) ?? null;
};

const captureViewportMessageAnchor = (
    container: HTMLElement,
    scope: ParentNode = container,
): ViewportMessageAnchor | null => {
    const containerRect = container.getBoundingClientRect();
    const nodes = Array.from(scope.querySelectorAll<HTMLElement>('[data-message-id]'));
    const firstVisible = nodes.find((node) => {
        const rect = node.getBoundingClientRect();
        return rect.bottom > containerRect.top + 1
            && !isInsideStuckSticky(node, container, containerRect.top);
    }) ?? nodes.find((node) => node.getBoundingClientRect().bottom > containerRect.top + 1);
    const messageId = firstVisible?.dataset.messageId;
    if (!firstVisible || !messageId) {
        return null;
    }

    return {
        messageId,
        offsetTop: firstVisible.getBoundingClientRect().top - containerRect.top,
    };
};

const captureLastMessageAnchor = (
    container: HTMLElement,
    scope: ParentNode,
): ViewportMessageAnchor | null => {
    const nodes = scope.querySelectorAll<HTMLElement>('[data-message-id]');
    const last = nodes[nodes.length - 1];
    const messageId = last?.dataset.messageId;
    if (!last || !messageId) return null;
    return {
        messageId,
        offsetTop: last.getBoundingClientRect().top - container.getBoundingClientRect().top,
    };
};

const captureVirtualizationTransitionAnchor = (
    content: HTMLElement,
    container: HTMLElement,
): VirtualizationTransitionAnchor | null => {
    // A reader in the live tail sees no history message; the last history
    // message still pins the frame's geometry across the threshold commit.
    const messageAnchor = captureViewportMessageAnchor(container, content)
        ?? captureLastMessageAnchor(container, content);
    if (!messageAnchor) {
        return null;
    }

    const message = findMessageElement(content, messageAnchor.messageId);
    const entry = message?.closest<HTMLElement>('[data-turn-entry]');
    const entryKey = entry?.dataset.turnEntry;
    if (!entryKey || !entry) {
        return null;
    }

    return {
        ...messageAnchor,
        entryKey,
        entryStart: entry.getBoundingClientRect().top - content.getBoundingClientRect().top,
        attempts: 0,
    };
};


const readTaskSessionId = (toolPart: Part): string | null => {
    const partRecord = toolPart as unknown as {
        state?: {
            metadata?: {
                sessionId?: unknown;
                sessionID?: unknown;
            };
            output?: unknown;
        };
    };
    const metadata = partRecord.state?.metadata;
    const fromMetadata = readTaskSessionIdFromRecord(metadata) ?? null;
    if (fromMetadata) return fromMetadata;

    const output = partRecord.state?.output;
    return typeof output === 'string' ? readTaskSessionIdFromOutput(output) ?? null : null;
};

const isSyntheticSubtaskBridgeAssistant = (message: ChatMessageEntry): { hide: boolean; taskSessionId: string | null } => {
    if (resolveMessageRole(message) !== 'assistant') {
        return { hide: false, taskSessionId: null };
    }

    if (message.parts.length !== 1) {
        return { hide: false, taskSessionId: null };
    }

    const onlyPart = message.parts[0] as unknown as {
        type?: unknown;
        tool?: unknown;
    } | null | undefined;

    if (onlyPart?.type !== 'tool') {
        return { hide: false, taskSessionId: null };
    }

    const toolName = typeof onlyPart.tool === 'string' ? onlyPart.tool.toLowerCase() : '';
    // Plugin task + native subagent both own the synthetic subtask prompt bubble.
    if (toolName !== 'task' && toolName !== 'subagent') {
        return { hide: false, taskSessionId: null };
    }

    return {
        hide: true,
        taskSessionId: readTaskSessionId(message.parts[0]),
    };
};

const withSubtaskSessionId = (message: ChatMessageEntry, taskSessionId: string | null): ChatMessageEntry => {
    if (!taskSessionId) return message;
    const nextParts = applyAuthoritativeTaskSessionIdToSubtaskParts(message.parts, taskSessionId);
    if (nextParts === message.parts) return message;

    return {
        ...message,
        parts: nextParts,
    };
};

const withShellBridgeDetails = (message: ChatMessageEntry, details: ShellBridgeDetails | null): ChatMessageEntry => {
    const command = typeof details?.command === 'string' ? details.command.trim() : '';
    const output = typeof details?.output === 'string' ? details.output : '';
    const status = typeof details?.status === 'string' ? details.status.trim() : '';

    const nextParts: Part[] = [];
    let injected = false;

    for (const part of message.parts) {
        if (!injected && part?.type === 'text') {
            const text = (part as unknown as { text?: unknown }).text;
            const synthetic = (part as unknown as { synthetic?: unknown }).synthetic;
            if (synthetic === true && typeof text === 'string' && text.trim().startsWith(USER_SHELL_MARKER)) {
                nextParts.push({
                    type: 'text',
                    text: '/shell',
                    shellAction: {
                        ...(command ? { command } : {}),
                        ...(output ? { output } : {}),
                        ...(status ? { status } : {}),
                    },
                } as unknown as Part);
                injected = true;
                continue;
            }
        }
        nextParts.push(part);
    }

    if (!injected) {
        nextParts.push({
            type: 'text',
            text: '/shell',
            shellAction: {
                ...(command ? { command } : {}),
                ...(output ? { output } : {}),
                ...(status ? { status } : {}),
            },
        } as unknown as Part);
    }

    return {
        ...message,
        parts: nextParts,
    };
};

interface MessageListProps {
    sessionKey: string;
    virtualizerKey?: string;
    disableStaging?: boolean;
    /** The current pending seed already painted in the draft transcript shell. */
    initialPinRevealComplete?: boolean;
    messages: ChatMessageEntry[];
    sessionIsWorking?: boolean;
    activeStreamingMessageId?: string | null;
    activeStreamingPhase?: StreamPhase | null;
    retryOverlay?: {
        sessionId: string;
        message: string;
        confirmedAt?: number;
        fallbackTimestamp?: number;
    } | null;
    onMessageContentChange: (reason?: ContentChangeReason) => void;
    getAnimationHandlers: (messageId: string) => AnimationHandlers;
    isLoadingOlder: boolean;
    scrollToBottom?: () => void;
    scrollRef?: React.RefObject<HTMLDivElement | null>;
    directory?: string;
    /**
     * Classic (TanStack) path only. Rendered after the streaming tail **inside**
     * the markdown pin-reveal root so cold-open / jump-to-latest cannot leave a
     * visible WorkingPlaceholder while the transcript is still `visibility: hidden`.
     */
    liveStatusSlot?: React.ReactNode;
    /** Captures the history reading position before an explicit prepend. */
    timelineHistoryAnchorToken?: number;
    /**
     * Primary chat owns the send-to-park latch. Secondary transcripts
     * (context panel) must not consume or clear it.
     */
    enableSendPark?: boolean;
}

export interface MessageListHandle {
    scrollToTurnId: (turnId: string, options?: { behavior?: ScrollBehavior }) => boolean;
    scrollToMessageId: (messageId: string, options?: { behavior?: ScrollBehavior }) => boolean;
    captureViewportAnchor: () => { messageId: string; offsetTop: number } | null;
    restoreViewportAnchor: (anchor: { messageId: string; offsetTop: number }) => boolean;
    holdViewportAnchor: (anchor: { messageId: string; offsetTop: number }) => void;
    cancelViewportAnchorHold: () => void;
    isHistoryVirtualized: () => boolean;
    scrollToBottom: (options?: { behavior?: ScrollBehavior; reveal?: boolean }) => boolean;
    cancelScroll: () => void;
}

type RenderEntry =
    | {
        kind: 'ungrouped';
        key: string;
        message: ChatMessageEntry;
        previousMessage?: ChatMessageEntry;
        nextMessage?: ChatMessageEntry;
    }
    | { kind: 'turn'; key: string; turn: TurnRecord; isLastTurn: boolean };

type TurnUiState = { isExpanded: boolean; automatic?: boolean };

/**
 * Pre-assistant compaction disclosure when sorted, compaction-kind, and no
 * visible activity segments yet. Once assistant messages exist, the
 * MessageBody Activity disclosure owns the header and foldable body.
 * Settled (`normal`/`abnormal`) without assistants still qualifies.
 * `active` requires the last turn and an authoritative live working signal so
 * history pagination / partial loads cannot paint stale "compacting".
 */
// eslint-disable-next-line react-refresh/only-export-components
export const shouldShowCompactionStatus = (input: {
    chatRenderMode: 'sorted' | 'live';
    activityPresentationKind: TurnRecord['activityPresentationKind'];
    hasVisibleActivitySegments: boolean;
    hasAssistantMessages: boolean;
    completionDisposition: TurnRecord['completionDisposition'];
    isLastTurn: boolean;
    sessionIsWorking: boolean;
}): boolean => {
    if (input.chatRenderMode !== 'sorted') {
        return false;
    }
    if (input.activityPresentationKind !== 'compaction') {
        return false;
    }
    if (input.hasVisibleActivitySegments) {
        return false;
    }
    // Assistant rows own the disclosure header + foldable summary body.
    if (input.hasAssistantMessages) {
        return false;
    }
    if (input.completionDisposition === 'normal' || input.completionDisposition === 'abnormal') {
        return true;
    }
    if (input.completionDisposition === 'active') {
        return input.isLastTurn && input.sessionIsWorking;
    }
    return false;
};

interface MessageRowProps {
    message: ChatMessageEntry;
    previousMessage?: ChatMessageEntry;
    nextMessage?: ChatMessageEntry;
    turnGroupingContext?: TurnGroupingContext;
    assistantHeaderMessageId?: string;
    turnOwnsAssistantHeader?: boolean;
    isInActiveTurn?: boolean;
    activeStreamingPhase?: StreamPhase | null;
    animateUserOnMount?: boolean;
    onUserAnimationConsumed?: (messageId: string) => void;
    onContentChange: (reason?: ContentChangeReason) => void;
    animationHandlers: AnimationHandlers;
    scrollToBottom?: () => void;
    reviewTransferDirection?: ReviewTransferDirection | null;
}

const MessageRow = React.memo<MessageRowProps>(({ 
    message,
    previousMessage,
    nextMessage,
    turnGroupingContext,
    assistantHeaderMessageId,
    turnOwnsAssistantHeader,
    isInActiveTurn,
    activeStreamingPhase,
    animateUserOnMount,
    onUserAnimationConsumed,
    onContentChange,
    animationHandlers,
    scrollToBottom,
    reviewTransferDirection,
}) => {
    const sessionSurface = useSessionSurface();
    const messageSurface = message.sourceSessionID
        ? {
            ...sessionSurface,
            sessionId: message.sourceSessionID,
            directory: message.sourceDirectory ?? null,
            // Archived assistant history is read-only; only copy/selection and
            // nested-subagent navigation stay on. Drop hosted mutation callbacks
            // so edit/revert cannot target a prior binding.
            onRevertMessage: undefined,
            onEditMessage: undefined,
            capabilities: {
                ...sessionSurface.capabilities,
                compose: false,
                mutateSession: false,
                answerRequests: false,
                openTimeline: false,
                forkSession: false,
            },
        }
        : sessionSurface;
    const chatMessage = (
        <ChatMessage
            message={message}
            previousMessage={previousMessage}
            nextMessage={nextMessage}
            animateUserOnMount={animateUserOnMount}
            onUserAnimationConsumed={onUserAnimationConsumed}
            onContentChange={onContentChange}
            animationHandlers={animationHandlers}
            scrollToBottom={scrollToBottom}
            turnGroupingContext={turnGroupingContext}
            assistantHeaderMessageId={assistantHeaderMessageId}
            turnOwnsAssistantHeader={turnOwnsAssistantHeader}
            isInActiveTurn={isInActiveTurn}
            activeStreamingPhase={activeStreamingPhase}
            reviewTransferDirection={reviewTransferDirection}
        />
    );
    return (
        messageSurface === sessionSurface ? chatMessage : <SessionSurfaceContext.Provider value={messageSurface}>{chatMessage}</SessionSurfaceContext.Provider>
    );
}, (prev, next) => {
    const prevTurn = prev.turnGroupingContext;
    const nextTurn = next.turnGroupingContext;

    return areRenderRelevantMessagesEqual(prev.message, next.message)
        && prev.message.sourceSessionID === next.message.sourceSessionID
        && prev.message.sourceDirectory === next.message.sourceDirectory
        && areOptionalRenderRelevantMessagesEqual(prev.previousMessage, next.previousMessage)
        && areOptionalRenderRelevantMessagesEqual(prev.nextMessage, next.nextMessage)
        && prev.animateUserOnMount === next.animateUserOnMount
        && prev.onUserAnimationConsumed === next.onUserAnimationConsumed
        && prev.onContentChange === next.onContentChange
        && prev.scrollToBottom === next.scrollToBottom
        && areRelevantTurnGroupingContextsEqual(prevTurn, nextTurn, prev.message.info.id, resolveMessageRole(prev.message) === 'user')
        && prev.assistantHeaderMessageId === next.assistantHeaderMessageId
        && prev.turnOwnsAssistantHeader === next.turnOwnsAssistantHeader
        && prev.isInActiveTurn === next.isInActiveTurn
        && prev.activeStreamingPhase === next.activeStreamingPhase
        && prev.reviewTransferDirection === next.reviewTransferDirection
        && prev.animationHandlers?.onChunk === next.animationHandlers?.onChunk
        && prev.animationHandlers?.onComplete === next.animationHandlers?.onComplete
        && prev.animationHandlers?.onStreamingCandidate === next.animationHandlers?.onStreamingCandidate
        && prev.animationHandlers?.onAnimationStart === next.animationHandlers?.onAnimationStart
        && prev.animationHandlers?.onReservationCancelled === next.animationHandlers?.onReservationCancelled
        && prev.animationHandlers?.onReasoningBlock === next.animationHandlers?.onReasoningBlock
        && prev.animationHandlers?.onAnimatedHeightChange === next.animationHandlers?.onAnimatedHeightChange;
});

MessageRow.displayName = 'MessageRow';

interface TurnBlockProps {
    turn: TurnRecord;
    isLastTurn: boolean;
    sessionIsWorking: boolean;
    activityRenderMode: 'collapsed' | 'summary';
    turnUiStates: Map<string, TurnUiState>;
    onToggleTurnGroup: (turnId: string, defaultExpanded: boolean) => void;
    chatRenderMode: 'sorted' | 'live';
    onMessageContentChange: (reason?: ContentChangeReason) => void;
    getAnimationHandlers: (messageId: string) => AnimationHandlers;
    scrollToBottom?: () => void;
    stickyUserHeader?: boolean;
    shouldAnimateUserMessage: (message: ChatMessageEntry) => boolean;
    onUserAnimationConsumed: (messageId: string) => void;
    activeStreamingMessageId?: string | null;
    activeStreamingPhase?: StreamPhase | null;
    reviewTransferDirection?: ReviewTransferDirection | null;
}

const TurnBlock = React.memo(({
    turn,
    isLastTurn,
    sessionIsWorking,
    activityRenderMode,
    turnUiStates,
    onToggleTurnGroup,
    chatRenderMode,
    onMessageContentChange,
    getAnimationHandlers,
    scrollToBottom,
    stickyUserHeader = true,
    shouldAnimateUserMessage,
    onUserAnimationConsumed,
    activeStreamingMessageId,
    activeStreamingPhase,
    reviewTransferDirection,
}: TurnBlockProps) => {
    const showReasoningTraces = useUIStore((state) => state.showReasoningTraces);
    const hasLeadingContent = React.useMemo(() => Boolean(turn.userMessage) || turn.assistantMessages.some((message) => (
        Boolean(message.info.error) || filterVisibleParts(message.parts, { includeReasoning: showReasoningTraces }).some((part) => (
            part.type === 'tool' || part.type === 'file'
            || ((part.type === 'text' || part.type === 'reasoning') && extractTextContent(part).trim().length > 0)
        ))
    )), [turn.userMessage, turn.assistantMessages, showReasoningTraces]);
    const liveTurnLifecycleRef = React.useRef<string | null>(null);
    if (
        liveTurnLifecycleRef.current === turn.turnId
        && !isLastTurn
        && turn.completionDisposition !== 'active'
    ) {
        liveTurnLifecycleRef.current = null;
    } else if (
        isLastTurn
        && sessionIsWorking
    ) {
        liveTurnLifecycleRef.current = turn.turnId;
    }
    const preserveActiveTurnGap = liveTurnLifecycleRef.current === turn.turnId;
    const pendingHeaderStateRef = React.useRef({ turnId: turn.turnId, shown: false });
    if (pendingHeaderStateRef.current.turnId !== turn.turnId) {
        pendingHeaderStateRef.current = { turnId: turn.turnId, shown: false };
    }
    const storedTurnUiState = turnUiStates.get(turn.turnId);
    // Gate raw message-active through presentation so only the live last turn
    // while the session is working defaults open; idle/historical actives settle.
    // Header chrome (Working vs Processed) uses this demotion.
    const activityPresentationForDefault = resolveTurnActivityPresentation({
        completionDisposition: turn.completionDisposition,
        isLastTurn,
        sessionIsWorking,
        durationMs: turn.durationMs,
    });
    // Expansion must NOT follow sessionIsWorking demotion. Between tool steps
    // session_status often flaps busy→idle while the last assistant is still
    // open (completionDisposition active); demoting to abnormal collapses the
    // disclosure and blanks tool rows mid-turn (user-visible flicker). Keep
    // expanded while the turn itself is still open — on any turn position: a
    // queued/steered message makes the running turn non-last while its tools
    // still execute, and folding then hid the in-progress steps.
    const expansionDisposition = resolveActivityExpansionDisposition({
        isLastTurn,
        turnCompletionDisposition: turn.completionDisposition,
        headerPresentationDisposition: activityPresentationForDefault.completionDisposition,
        hasAssistantMessages: turn.assistantMessages.length > 0,
    });
    const defaultExpandedForTurn = resolveTurnActivityExpandedByDefault({
        expansionDisposition,
        activityRenderMode,
        isLastTurn,
        isActivelyProcessing: isLastTurn && sessionIsWorking,
        hasConfirmedFinalBody: turn.hasConfirmedFinalBody,
    });
    // Explicit per-turn toggle wins; otherwise live-active forces open and
    // settled turns follow activityRenderMode (auto-collapses when processing ends).
    const releaseAutomaticExpansion = storedTurnUiState?.automatic
        && turn.completionDisposition === 'normal'
        && turn.hasConfirmedFinalBody
        && !(isLastTurn && sessionIsWorking);
    const isGroupExpandedByDefault = storedTurnUiState && !releaseAutomaticExpansion
        ? storedTurnUiState.isExpanded
        : defaultExpandedForTurn;
    const handleToggleTurnGroup = useEvent(() => {
        onToggleTurnGroup(turn.turnId, isGroupExpandedByDefault);
    });

    const messageOrder = React.useMemo(() => {
        const ordered = turn.userMessage ? [turn.userMessage, ...turn.assistantMessages] : turn.assistantMessages;
        const lookup = new Map<string, number>();
        ordered.forEach((message, index) => {
            lookup.set(message.info.id, index);
        });
        return { ordered, lookup };
    }, [turn.assistantMessages, turn.userMessage]);

    const streamingAssistantMessageId = React.useMemo(() => {
        if (activeStreamingMessageId && turn.assistantMessages.some((assistant) => assistant.info.id === activeStreamingMessageId)) {
            return activeStreamingMessageId;
        }

        for (let index = turn.assistantMessages.length - 1; index >= 0; index -= 1) {
            const assistant = turn.assistantMessages[index];
            if (!isAssistantMessageCompleted(assistant)) {
                return assistant.info.id;
            }
        }

        return null;
    }, [activeStreamingMessageId, turn.assistantMessages]);

    const visibleAssistantMessages = React.useMemo(() => {
        if (chatRenderMode === 'live') {
            return turn.assistantMessages;
        }
        return resolveVisibleSortedAssistants(turn.assistantMessages, streamingAssistantMessageId);
    }, [chatRenderMode, streamingAssistantMessageId, turn.assistantMessages]);

    const visibleAssistantIds = React.useMemo(() => {
        const ids = new Map<string, number>();
        visibleAssistantMessages.forEach((assistant, index) => {
            ids.set(assistant.info.id, index);
        });
        return ids;
    }, [visibleAssistantMessages]);

    // Activity rows follow the same assistant set as the turn viewport so
    // earlier incomplete steps keep their tools while a later sibling streams.
    const visibleActivityMessageIdSet = React.useMemo(() => {
        return new Set(visibleAssistantMessages.map((assistant) => assistant.info.id));
    }, [visibleAssistantMessages]);

    // Stable Activity mount point: retain the first-painted assistant on prepend.
    // Jumping the owner to the streaming tail remounts the disclosure across
    // messages when the turn settles (last → first), which blanks tool rows for
    // a frame and can double-mount Activity while multi-step turns stream
    // (anchor on first + owner on last). Keep one durable host for the turn.
    const activityOwnerMessageId = React.useMemo(() => {
        return turn.headerMessageId && visibleAssistantIds.has(turn.headerMessageId)
            ? turn.headerMessageId
            : visibleAssistantMessages[0]?.info.id;
    }, [turn.headerMessageId, visibleAssistantIds, visibleAssistantMessages]);

    const visibleActivityParts = React.useMemo(() => {
        if (chatRenderMode !== 'sorted') {
            return turn.activityParts;
        }
        return visibleActivityMessageIdSet.size === turn.assistantMessages.length
            ? turn.activityParts
            : turn.activityParts.filter((activity) => visibleActivityMessageIdSet.has(activity.messageId));
    }, [chatRenderMode, visibleActivityMessageIdSet, turn.activityParts, turn.assistantMessages.length]);

    const visibleActivitySegments = React.useMemo(() => {
        if (chatRenderMode !== 'sorted') {
            return turn.activitySegments;
        }
        if (visibleActivityMessageIdSet.size === turn.assistantMessages.length) {
            return turn.activitySegments;
        }
        return turn.activitySegments
            .map((segment) => {
                const parts = segment.parts.filter((activity) => visibleActivityMessageIdSet.has(activity.messageId));
                if (parts.length === 0) {
                    return null;
                }
                const anchorMessageId = visibleActivityMessageIdSet.has(segment.anchorMessageId)
                    ? segment.anchorMessageId
                    : parts[0]?.messageId;
                if (!anchorMessageId) {
                    return null;
                }
                return {
                    ...segment,
                    anchorMessageId,
                    parts,
                };
            })
            .filter((segment): segment is NonNullable<typeof segment> => segment !== null);
    }, [chatRenderMode, visibleActivityMessageIdSet, turn.activitySegments, turn.assistantMessages.length]);

    const turnGroupingContextBase = React.useMemo(() => {
        const userCreatedAt = (turn.userMessage?.info.time as { created?: number } | undefined)?.created;
        // OpenCode 1.4.0 moved variant from top-level to model.variant on UserMessage.
        // Prefer the new location, fall back to the legacy one for older servers.
        const info = turn.userMessage?.info as { variant?: unknown; model?: { variant?: unknown } } | undefined;
        const rawVariant = info?.model?.variant ?? info?.variant;
        const userMessageVariant = typeof rawVariant === 'string' && rawVariant.trim().length > 0
            ? rawVariant
            : undefined;
        return {
            turnId: turn.turnId,
            assistantTps: computeAssistantTps(turn.assistantMessages.map((assistant) => ({
                createdAt: assistant.info.time.created,
                streamedAt: assistant.info.time.streamed,
                outputTokens: assistant.info.tokens?.output,
                reasoningTokens: assistant.info.tokens?.reasoning,
            }))),
            summaryBody: turn.summaryText,
            activityParts: visibleActivityParts,
            activityGroupSegments: visibleActivitySegments,
            headerMessageId: turn.headerMessageId,
            hasTools: turn.hasTools,
            hasReasoning: turn.hasReasoning,
            activityPresentationKind: turn.activityPresentationKind,
            diffStats: turn.diffStats,
            changedFiles: turn.changedFiles,
            userMessageCreatedAt: typeof userCreatedAt === 'number' ? userCreatedAt : undefined,
            userMessageVariant,
        };
    }, [turn.activityPresentationKind, turn.assistantMessages, turn.changedFiles, turn.diffStats, turn.hasReasoning, turn.hasTools, turn.headerMessageId, turn.summaryText, turn.turnId, turn.userMessage?.info, visibleActivityParts, visibleActivitySegments]);

    // Called by `TurnAssistantBlock` during its render, so it must see this
    // render's values. Through `useEvent` it saw the previous render's, and a
    // turn that just grew resolved its new message against the old assistant
    // index: `assistantIndex` missed, `turnGroupingContext` came out undefined,
    // and the message rendered as a standalone assistant — its own model header,
    // no turn grouping, and the between-turns `pb-8` gap. `TurnItem` is memoized
    // on the turn, so once that render committed nothing brought it back.
    // `activityExpanded` is an explicit render-prop argument (not only a wrapper
    // data attribute). React Compiler can reuse `assistantMessages.map(...)`
    // when `renderMessage` identity is stable and the only changed input is a
    // sibling prop; passing expansion here makes it a cache dependency so
    // `isGroupExpanded` inside the produced MessageRow updates on toggle.
    const renderMessage = useRenderPhaseCallback((message: ChatMessageEntry, activityExpanded: boolean) => {
        const messageRole = resolveMessageRole(message);
        const isUserMessage = messageRole === 'user';
        const messageIndex = messageOrder.lookup.get(message.info.id);
        const assistantIndex = visibleAssistantIds.get(message.info.id) ?? -1;
        const isAssistantMessage = assistantIndex >= 0;
        const isFirstAssistant = assistantIndex === 0;
        const isLastAssistant = assistantIndex === visibleAssistantMessages.length - 1;
        const isActivityOwner = Boolean(activityOwnerMessageId) && message.info.id === activityOwnerMessageId;
        const hasAnchoredActivitySegment = visibleActivitySegments.some((segment) => segment.anchorMessageId === message.info.id);
        const shouldAttachFullTurnContext = chatRenderMode === 'sorted'
            ? isAssistantMessage
            : (isActivityOwner || isFirstAssistant || isLastAssistant);
        const assistantHeaderMessageId = visibleAssistantMessages[0]?.info.id ?? turn.headerMessageId;

        const previousMessage = isUserMessage
            ? undefined
            : (isAssistantMessage
                ? (isFirstAssistant
                    ? turn.userMessage
                    : undefined)
                : (typeof messageIndex === 'number' && messageIndex > 0
                    ? messageOrder.ordered[messageIndex - 1]
                    : undefined));
        const nextMessage = undefined;

        const activityPresentation = resolveTurnActivityPresentation({
            completionDisposition: turn.completionDisposition,
            isLastTurn,
            sessionIsWorking,
            durationMs: turn.durationMs,
        });
        const turnGroupingContext = isAssistantMessage
            ? {
                turnId: turn.turnId,
                activityOwnerMessageId,
                isFirstAssistantInTurn: isFirstAssistant,
                isLastAssistantInTurn: isLastAssistant,
                isLatestTurn: isLastTurn,
                isWorking: (isLastTurn || turn.completionDisposition === 'active') && sessionIsWorking && (
                    chatRenderMode === 'sorted'
                        ? hasAnchoredActivitySegment
                        : message.info.id === streamingAssistantMessageId
                ),
                // Turn-completion chrome asks the turn, not the row.
                // hasConfirmedFinalBody beats a lagging sessionIsWorking so live
                // SSE settle can show TPS/duration before pending/status gates flip.
                isTurnSettled: resolveTurnSettledForPresentation({
                    completionDisposition: turn.completionDisposition,
                    isLastTurn,
                    sessionIsWorking,
                    hasConfirmedSettledAssistant: turn.hasConfirmedFinalBody,
                }),
                hasTools: turn.hasTools,
                hasReasoning: turn.hasReasoning,
                completionDisposition: activityPresentation.completionDisposition,
                activityPresentationKind: turn.activityPresentationKind,
                durationMs: activityPresentation.durationMs,
                assistantTps: turnGroupingContextBase.assistantTps,
                ...(shouldAttachFullTurnContext ? {
                    summaryBody: turnGroupingContextBase.summaryBody,
                    activityParts: turnGroupingContextBase.activityParts,
                    activityGroupSegments: turnGroupingContextBase.activityGroupSegments,
                    headerMessageId: turnGroupingContextBase.headerMessageId,
                    diffStats: turnGroupingContextBase.diffStats,
                    changedFiles: turnGroupingContextBase.changedFiles,
                    userMessageCreatedAt: turnGroupingContextBase.userMessageCreatedAt,
                    userMessageVariant: turnGroupingContextBase.userMessageVariant,
                    isGroupExpanded: activityExpanded,
                    toggleGroup: handleToggleTurnGroup,
                } : {}),
            } satisfies TurnGroupingContext
            : undefined;
        return (
            <MessageRow
                key={message.info.id}
                message={message}
                previousMessage={previousMessage}
                nextMessage={nextMessage}
                turnGroupingContext={turnGroupingContext}
                assistantHeaderMessageId={assistantHeaderMessageId}
                turnOwnsAssistantHeader={isAssistantMessage}
                isInActiveTurn={Boolean(streamingAssistantMessageId) && message.info.id === streamingAssistantMessageId}
                activeStreamingPhase={message.info.id === streamingAssistantMessageId ? activeStreamingPhase : null}
                reviewTransferDirection={reviewTransferDirection}
                animateUserOnMount={shouldAnimateUserMessage(message)}
                onUserAnimationConsumed={onUserAnimationConsumed}
                onContentChange={onMessageContentChange}
                animationHandlers={getAnimationHandlers(message.info.id)}
                scrollToBottom={scrollToBottom}
            />
        );
    });

    const renderableTurn = React.useMemo(() => {
        if (visibleAssistantMessages === turn.assistantMessages) {
            return turn;
        }
        return {
            ...turn,
            assistantMessages: visibleAssistantMessages,
        };
    }, [turn, visibleAssistantMessages]);

    const pendingAssistantHeader = React.useMemo(() => {
        const shouldStartPendingHeader = shouldShowPendingAssistantHeader({
            isLastTurn,
            sessionIsWorking,
            hasAssistantMessages: turn.assistantMessages.length > 0,
            activityPresentationKind: turn.activityPresentationKind,
            hasActiveStreamingMessage: Boolean(activeStreamingMessageId),
        });
        if (shouldStartPendingHeader || turn.assistantMessages.length > 0) {
            pendingHeaderStateRef.current.shown = true;
        }
        if (!pendingHeaderStateRef.current.shown || turn.activityPresentationKind === 'compaction') {
            return null;
        }
        return turn.userMessage ? resolvePendingAssistantHeader(readUserMessageHeaderIdentity(turn.userMessage.info)) : null;
    }, [
        activeStreamingMessageId,
        isLastTurn,
        sessionIsWorking,
        turn.activityPresentationKind,
        turn.assistantMessages.length,
        turn.userMessage,
    ]);

    if (!hasLeadingContent) {
        const active = turn.assistantMessages.find((message) => message.info.id === activeStreamingMessageId);
        return active ? <UngroupedMessageRow message={active}
            onMessageContentChange={onMessageContentChange} getAnimationHandlers={getAnimationHandlers}
            scrollToBottom={scrollToBottom} shouldAnimateUserMessage={shouldAnimateUserMessage}
            onUserAnimationConsumed={onUserAnimationConsumed} activeStreamingMessageId={activeStreamingMessageId}
            activeStreamingPhase={activeStreamingPhase} reviewTransferDirection={reviewTransferDirection} /> : null;
    }

    return (
        <TurnItem
            turn={renderableTurn}
            showSessionError={isLastTurn}
            activityExpanded={isGroupExpandedByDefault}
            onToggleActivity={handleToggleTurnGroup}
            showCompactionStatus={shouldShowCompactionStatus({
                chatRenderMode,
                activityPresentationKind: turn.activityPresentationKind,
                hasVisibleActivitySegments: visibleActivitySegments.length > 0,
                hasAssistantMessages: turn.assistantMessages.length > 0,
                completionDisposition: turn.completionDisposition,
                isLastTurn,
                sessionIsWorking,
            })}
            pendingAssistantHeader={pendingAssistantHeader}
            assistantHeaderMessage={visibleAssistantMessages[0]}
            assistantHeaderIsInActiveTurn={visibleAssistantMessages[0]?.info.id === streamingAssistantMessageId}
            preserveActiveTurnGap={preserveActiveTurnGap}
            stickyUserHeader={stickyUserHeader}
            renderMessage={renderMessage}
        />
    );
});

TurnBlock.displayName = 'TurnBlock';

interface UngroupedMessageRowProps {
    message: ChatMessageEntry;
    previousMessage?: ChatMessageEntry;
    nextMessage?: ChatMessageEntry;
    onMessageContentChange: (reason?: ContentChangeReason) => void;
    getAnimationHandlers: (messageId: string) => AnimationHandlers;
    scrollToBottom?: () => void;
    shouldAnimateUserMessage: (message: ChatMessageEntry) => boolean;
    onUserAnimationConsumed: (messageId: string) => void;
    activeStreamingMessageId?: string | null;
    activeStreamingPhase?: StreamPhase | null;
    reviewTransferDirection?: ReviewTransferDirection | null;
}

const UngroupedMessageRow = React.memo(({
    message,
    previousMessage,
    nextMessage,
    onMessageContentChange,
    getAnimationHandlers,
    scrollToBottom,
    shouldAnimateUserMessage,
    onUserAnimationConsumed,
    activeStreamingMessageId,
    activeStreamingPhase,
    reviewTransferDirection,
}: UngroupedMessageRowProps) => {
    const { t } = useI18n();
    if (isAssistantSessionDivider(message)) {
        return (
            <div className="chat-message-column px-4 py-5" role="separator" aria-label={t('assistants.conversation.newSessionDivider')}>
                <div className="flex items-center gap-3">
                    <div className="min-w-0 flex-1 border-t" />
                    <span className="shrink-0 typography-meta text-muted-foreground">
                        {t('assistants.conversation.newSessionDivider')}
                    </span>
                    <div className="min-w-0 flex-1 border-t" />
                </div>
            </div>
        );
    }
    return (
        <MessageRow
            message={message}
            previousMessage={previousMessage}
            nextMessage={nextMessage}
            animateUserOnMount={shouldAnimateUserMessage(message)}
            onUserAnimationConsumed={onUserAnimationConsumed}
            onContentChange={onMessageContentChange}
            animationHandlers={getAnimationHandlers(message.info.id)}
            scrollToBottom={scrollToBottom}
            isInActiveTurn={Boolean(activeStreamingMessageId) && message.info.id === activeStreamingMessageId}
            activeStreamingPhase={message.info.id === activeStreamingMessageId ? activeStreamingPhase : null}
            reviewTransferDirection={reviewTransferDirection}
        />
    );
});

UngroupedMessageRow.displayName = 'UngroupedMessageRow';

interface MessageListEntryProps {
    entry: RenderEntry;
    hydrateMarkdown?: boolean;
    onMessageContentChange: (reason?: ContentChangeReason) => void;
    getAnimationHandlers: (messageId: string) => AnimationHandlers;
    scrollToBottom?: () => void;
    stickyUserHeader?: boolean;
    sessionIsWorking: boolean;
    activityRenderMode: 'collapsed' | 'summary';
    turnUiStates: Map<string, TurnUiState>;
    onToggleTurnGroup: (turnId: string, defaultExpanded: boolean) => void;
    chatRenderMode: 'sorted' | 'live';
    shouldAnimateUserMessage: (message: ChatMessageEntry) => boolean;
    onUserAnimationConsumed: (messageId: string) => void;
    activeStreamingMessageId?: string | null;
    activeStreamingPhase?: StreamPhase | null;
    reviewTransferDirection?: ReviewTransferDirection | null;
    showLiveStatusRow?: boolean;
}

const MessageListEntry = React.memo(({
    entry,
    hydrateMarkdown = true,
    onMessageContentChange,
    getAnimationHandlers,
    scrollToBottom,
    stickyUserHeader,
    sessionIsWorking,
    activityRenderMode,
    turnUiStates,
    onToggleTurnGroup,
    chatRenderMode,
    shouldAnimateUserMessage,
    onUserAnimationConsumed,
    activeStreamingMessageId,
    activeStreamingPhase,
    reviewTransferDirection,
    showLiveStatusRow = false,
}: MessageListEntryProps) => {
    const body = entry.kind === 'ungrouped' ? (
        <UngroupedMessageRow
            message={entry.message}
            previousMessage={entry.previousMessage}
            nextMessage={entry.nextMessage}
            onMessageContentChange={onMessageContentChange}
            getAnimationHandlers={getAnimationHandlers}
            scrollToBottom={scrollToBottom}
            shouldAnimateUserMessage={shouldAnimateUserMessage}
            onUserAnimationConsumed={onUserAnimationConsumed}
            activeStreamingMessageId={activeStreamingMessageId}
            activeStreamingPhase={activeStreamingPhase}
            reviewTransferDirection={reviewTransferDirection}
        />
    ) : (
        <TurnBlock
            turn={entry.turn}
            isLastTurn={entry.isLastTurn}
            sessionIsWorking={sessionIsWorking}
            activityRenderMode={activityRenderMode}
            turnUiStates={turnUiStates}
            onToggleTurnGroup={onToggleTurnGroup}
            chatRenderMode={chatRenderMode}
            shouldAnimateUserMessage={shouldAnimateUserMessage}
            onUserAnimationConsumed={onUserAnimationConsumed}
            activeStreamingMessageId={activeStreamingMessageId}
            activeStreamingPhase={activeStreamingPhase}
            reviewTransferDirection={reviewTransferDirection}
            onMessageContentChange={onMessageContentChange}
            getAnimationHandlers={getAnimationHandlers}
            scrollToBottom={scrollToBottom}
            stickyUserHeader={stickyUserHeader}
        />
    );
    return (
        <MarkdownHydrationProvider enabled={hydrateMarkdown}>
            {body}
            {showLiveStatusRow ? <div className="mb-1">
                <StatusRowContainer />
            </div> : null}
        </MarkdownHydrationProvider>
    );
});

MessageListEntry.displayName = 'MessageListEntry';

// Inner component that renders staged turn entries.
type StaticHistoryListProps = {
    entries: RenderEntry[];
    historyAnchorToken?: number;
    engine: HistoryEngine;
    contentRef: React.RefObject<HTMLDivElement | null>;
    scrollRef?: React.RefObject<HTMLDivElement | null>;
    registerTanstackVirtualizer?: (virtualizer: TanstackVirtualizerInstance | null) => void;
    virtualizerKey: string;
    onMessageContentChange: (reason?: ContentChangeReason) => void;
    getAnimationHandlers: (messageId: string) => AnimationHandlers;
    scrollToBottom?: () => void;
    stickyUserHeader: boolean;
    activityRenderMode: 'collapsed' | 'summary';
    turnUiStates: Map<string, TurnUiState>;
    onToggleTurnGroup: (turnId: string, defaultExpanded: boolean) => void;
    chatRenderMode: 'sorted' | 'live';
    shouldAnimateUserMessage: (message: ChatMessageEntry) => boolean;
    onUserAnimationConsumed: (messageId: string) => void;
    reviewTransferDirection?: ReviewTransferDirection | null;
};

const StaticHistoryList = React.memo(({ entries, historyAnchorToken, engine, contentRef, scrollRef, registerTanstackVirtualizer, virtualizerKey, onMessageContentChange, getAnimationHandlers, scrollToBottom, stickyUserHeader, activityRenderMode, turnUiStates, onToggleTurnGroup, chatRenderMode, shouldAnimateUserMessage, onUserAnimationConsumed, reviewTransferDirection }: StaticHistoryListProps) => {
    const [displayEntries, setDisplayEntries] = React.useState(entries);
    const isTanstack = engine === 'tanstack' && displayEntries.length >= resolveHistoryVirtualizationThreshold();
    // A prepend can move this list across the tiny-history virtualization
    // threshold. Capture from the old normal-flow DOM during render, then seed
    // the virtual range at that keyed entry without replacing its mounted DOM.
    // The layout effect compensates the remaining measured offset.
    const committedEngineRef = React.useRef<HistoryEngine>(engine);
    const virtualizationTransitionAnchorRef = React.useRef<VirtualizationTransitionAnchor | null>(null);
    const [virtualizationTransitionTick, retryVirtualizationTransitionAnchor] = React.useReducer(
        (value: number) => value + 1,
        0,
    );
    if (!isTanstack) {
        virtualizationTransitionAnchorRef.current = null;
    } else if (
        committedEngineRef.current === 'none' && isTanstack
        && virtualizationTransitionAnchorRef.current === null
    ) {
        const content = contentRef.current;
        const container = scrollRef?.current;
        if (content && container) {
            virtualizationTransitionAnchorRef.current = captureVirtualizationTransitionAnchor(content, container);
        }
    }

    // --- Quiet-window prepend (mobile) --------------------------------------
    // Gesture tracking for the deferred-prepend decision. Refs only: reading
    // them never re-renders, and the render-phase reconcile below needs them.
    const touchActiveRef = React.useRef(false);
    const lastScrollAtRef = React.useRef(0);
    const holdSinceRef = React.useRef<number | null>(null);
    const deferPrepends = isMobileSurfaceRuntime();

    // Gesture listeners: register only while quiet-window prepend is active.
    // Handlers close over refs, so identity is irrelevant to effect lifecycle.
    React.useEffect(() => {
        if (!deferPrepends) return;
        const element = scrollRef?.current;
        if (!element) return;
        const onTouchStart = () => { touchActiveRef.current = true; };
        const onTouchEnd = () => { touchActiveRef.current = false; };
        const onScroll = () => { lastScrollAtRef.current = performance.now(); };
        element.addEventListener('touchstart', onTouchStart, { passive: true });
        element.addEventListener('touchend', onTouchEnd, { passive: true });
        element.addEventListener('touchcancel', onTouchEnd, { passive: true });
        element.addEventListener('scroll', onScroll, { passive: true });
        return () => {
            element.removeEventListener('touchstart', onTouchStart);
            element.removeEventListener('touchend', onTouchEnd);
            element.removeEventListener('touchcancel', onTouchEnd);
            element.removeEventListener('scroll', onScroll);
        };
    }, [deferPrepends, scrollRef]);

    const isGestureActive = () => (
        touchActiveRef.current
        || performance.now() - lastScrollAtRef.current < HISTORY_PREPEND_QUIET_MS
    );

    // Render-phase reconcile (official derived-state pattern): adopt the new
    // entries immediately unless this commit is a pure prepend-above landing
    // in the middle of an active touch gesture — those wait for quiet.
    let renderEntries = displayEntries;
    if (entries !== displayEntries) {
        const shouldHold = deferPrepends
            && isPrependAboveCommit(displayEntries, entries)
            && isGestureActive();
        if (shouldHold) {
            if (holdSinceRef.current === null) holdSinceRef.current = performance.now();
        } else {
            holdSinceRef.current = null;
            setDisplayEntries(entries);
            renderEntries = entries;
        }
    } else if (holdSinceRef.current !== null) {
        holdSinceRef.current = null;
    }

    // While a prepend is held, poll for the quiet window (touch/momentum have
    // no completion event we can await) and flush by re-rendering.
    const [, forceFlushTick] = React.useReducer((tick: number) => tick + 1, 0);
    useInterval(() => {
        if (holdSinceRef.current === null) return;
        if (!isGestureActive()) {
            forceFlushTick();
        }
    }, deferPrepends && holdSinceRef.current !== null ? HISTORY_PREPEND_MONITOR_INTERVAL_MS : null);

    const entriesRef = React.useRef(renderEntries);
    entriesRef.current = renderEntries;
    const entryKeys = React.useMemo(
        () => renderEntries.map((entry) => entry.key),
        [renderEntries],
    );
    const targetOverscan = resolveTanstackOverscan();
    const [historyOverscan, setHistoryOverscan] = React.useState(() => getInitialHistoryOverscan(targetOverscan));
    React.useEffect(() => {
        if (!isTanstack || historyOverscan >= targetOverscan) {
            return;
        }
        return scheduleAfterPaintTask(() => {
            React.startTransition(() => {
                setHistoryOverscan((current) => getNextHistoryOverscan(current, targetOverscan));
            });
        });
    }, [historyOverscan, isTanstack, targetOverscan]);
    // Measurement cache is mode-scoped: collapsed vs summary geometry must not
    // cross-seed each other (see resolveTimelineVirtualizerCacheKey).
    const timelineCacheKey = resolveTimelineVirtualizerCacheKey(virtualizerKey, activityRenderMode);
    // Initial-only read: measurement cache restore is a mount-time concern;
    // afterwards the live virtualizer owns measurements. Mode is fixed for the
    // list instance identity via the cache key; a mode switch remounts through
    // a new cache namespace rather than reusing the wrong heights.
    const [initialMeasurements] = React.useState(() => (
        isTanstack
            ? readTanstackTimelineCache(timelineCacheKey, entries.map((entry) => entry.key))
            : undefined
    ));

    const sizeContainerRef = React.useRef<HTMLDivElement | null>(null);
    const setHistoryRoot = useEvent((element: HTMLDivElement | null) => {
        sizeContainerRef.current = element;
        contentRef.current = element;
    });
    const historyReadingAnchorRef = React.useRef<ViewportMessageAnchor | null>(null);
    const columnReadingAnchorRef = React.useRef<ViewportMessageAnchor | null>(null);
    const unmeasuredHistoryRowsRef = React.useRef(new Set<HTMLDivElement>());
    const revealingHistoryRowsRef = React.useRef(new Set<HTMLDivElement>());
    const previousHistoryAnchorTokenRef = React.useRef(historyAnchorToken);
    // A held prepend must use the reading position at adoption, after the
    // user's drag/momentum, rather than the position when the request began.
    const previousDisplayEntriesRef = React.useRef(renderEntries);
    const adoptingPrepend = previousDisplayEntriesRef.current !== renderEntries
        && isPrependAboveCommit(previousDisplayEntriesRef.current, renderEntries);
    previousDisplayEntriesRef.current = renderEntries;
    if (previousHistoryAnchorTokenRef.current !== historyAnchorToken || adoptingPrepend) {
        previousHistoryAnchorTokenRef.current = historyAnchorToken;
        const container = scrollRef?.current;
        const content = sizeContainerRef.current ?? contentRef.current;
        historyReadingAnchorRef.current = container && content
            ? captureViewportMessageAnchor(container, content)
            : null;
    }
    const releaseHistoryReadingAnchor = useEvent(() => {
        historyReadingAnchorRef.current = null;
        columnReadingAnchorRef.current = null;
    });
    useEventListener('wheel', releaseHistoryReadingAnchor, undefined, { passive: true, capture: true });
    useEventListener('touchstart', releaseHistoryReadingAnchor, undefined, { passive: true, capture: true });
    useEventListener('pointerdown', releaseHistoryReadingAnchor, undefined, { passive: true, capture: true });
    useEventListener('click', releaseHistoryReadingAnchor, undefined, { capture: true });
    useEventListener('keydown', releaseHistoryReadingAnchor, undefined, { capture: true });
    const restoreHistoryReadingAnchor = useEvent(() => {
        const anchor = columnReadingAnchorRef.current ?? historyReadingAnchorRef.current;
        const container = scrollRef?.current;
        if (!anchor || !container) return;
        const element = findMessageElement(container, anchor.messageId);
        if (!element) return;
        const delta = element.getBoundingClientRect().top - container.getBoundingClientRect().top - anchor.offsetTop;
        if (Math.abs(delta) > 0.5) {
            tanstackVirtualizer.scrollToOffset(container.scrollTop + delta, { behavior: 'auto' });
        }
    });
    // Unknown-row estimates stay fixed until the activity-density mode changes.
    const defaultEstimatedEntrySize = resolveTanstackEstimatedEntrySize(activityRenderMode);
    const estimatedEntrySizeRef = React.useRef(defaultEstimatedEntrySize);
    const estimateModeRef = React.useRef(activityRenderMode);
    if (estimateModeRef.current !== activityRenderMode) {
        estimateModeRef.current = activityRenderMode;
        estimatedEntrySizeRef.current = defaultEstimatedEntrySize;
    }
    // Core re-reads `initialOffset` every time it acquires a scroll element,
    // which includes the moment `enabled` flips on because the history grew
    // past the surface's virtualization threshold. Only a list that mounted already
    // virtualized is a cold open allowed to start at the newest message; a
    // mid-session flip must adopt the live position, or the load that crosses
    // the threshold teleports a viewport reading old history to the bottom.
    const mountedVirtualizedRef = React.useRef(isTanstack);
    // Row heights of the list while it renders in normal flow. Crossing the
    // threshold hands a virtualizer an EMPTY measurement cache, so its total
    // size would collapse from the real height to count × estimate: the browser
    // clamps scrollTop to that smaller height, auto-follow reads the clamp as
    // "at the bottom", and the viewport ends up pinned to the newest message —
    // the load that crosses the threshold looks like a teleport. Seeding the
    // cache with what the DOM already measured keeps the switch geometrically
    // exact; only entries added by that same commit fall back to the estimate.
    // Read the still-mounted normal-flow rows only when activating virtualization,
    // before the commit changes their geometry, not on every history update.
    const unvirtualizedSizesRef = React.useRef(new Map<string, number>());
    const measurementSeedRef = React.useRef<VirtualItem[] | undefined>(undefined);
    React.useLayoutEffect(() => {
        if (isTanstack) return;
        measurementSeedRef.current = undefined;
    });
    if (isTanstack && measurementSeedRef.current === undefined) {
        if (!initialMeasurements) {
            const sizes = unvirtualizedSizesRef.current;
            sizes.clear();
            contentRef?.current?.querySelectorAll<HTMLElement>('[data-turn-entry]').forEach((node) => {
                const key = node.dataset.turnEntry;
                if (key) sizes.set(key, node.getBoundingClientRect().height);
            });
        }
        measurementSeedRef.current = initialMeasurements ?? buildMeasurementSeedFromSizes(
            entryKeys,
            unvirtualizedSizesRef.current,
            estimatedEntrySizeRef.current,
        );
    }
    // A zero initial viewport produces an empty range on the activation commit,
    // unmounting every old row before ResizeObserver reports the actual size.
    const initialViewportRect = React.useMemo(() => isTanstack ? {
        width: scrollRef?.current?.clientWidth ?? 0,
        height: scrollRef?.current?.clientHeight ?? 0,
    } : undefined, [isTanstack, scrollRef]);
    const tanstackVirtualizer = useTanstackVirtualizer<HTMLDivElement, HTMLDivElement>({
        count: renderEntries.length,
        enabled: isTanstack,
        initialRect: initialViewportRect,
        getScrollElement: () => scrollRef?.current ?? null,
        estimateSize: () => estimatedEntrySizeRef.current,
        overscan: historyOverscan,
        measureElement: (element, entry, instance) => {
            const key = instance.options.getItemKey(instance.indexFromElement(element));
            const cached = instance.itemSizeCache.get(key);
            if (instance.options.useCachedMeasurements) return cached ?? instance.options.estimateSize(instance.indexFromElement(element));
            // Rows are in normal flow: rounding each fractional border box makes
            // the virtual padding disagree with the DOM after a prepend.
            const height = entry?.borderBoxSize?.[0]?.blockSize;
            if (height !== undefined) return height;
            if (!entry) return cached ?? instance.options.estimateSize(instance.indexFromElement(element));
            return element.getBoundingClientRect().height;
        },
        scrollToFn: (offset, options, instance) => {
            // Expose the new total height before core writes an anchor
            // correction so the browser does not clamp the offset to the old
            // height. Write minHeight (not height) so an underestimated
            // visible row can still grow the frame instead of overflowing
            // onto the live tail.
            applyTanstackHistoryFrameMinHeight(
                sizeContainerRef.current,
                instance.getTotalSize(),
            );
            elementScroll(offset, options, instance);
        },
        getItemKey: (index) => entriesRef.current[index]?.key ?? `index:${index}`,
        // Bottom-anchored chat contract (see package comment above). Prepends
        // keep the keyed viewport stable; appends follow only while pinned;
        // streaming growth of the last row stays end-pinned via wasAtEnd.
        // App-level useChatAutoFollow still owns composer/content observers
        // outside the virtualizer's count/measure path.
        anchorTo: 'end',
        followOnAppend: true,
        scrollEndThreshold: TANSTACK_AT_END_THRESHOLD_PX,
        initialOffset: () => {
            if (mountedVirtualizedRef.current) {
                const estimate = estimatedEntrySizeRef.current;
                const total = (measurementSeedRef.current ?? []).reduce(
                    (size, item) => size + (item.index < renderEntries.length ? item.size - estimate : 0),
                    renderEntries.length * estimate,
                );
                return Math.max(0, total - (scrollRef?.current?.clientHeight ?? 0));
            }
            const anchor = virtualizationTransitionAnchorRef.current;
            const seededAnchor = anchor && measurementSeedRef.current?.find((item) => item.key === anchor.entryKey);
            return (scrollRef?.current?.scrollTop ?? 0)
                + (seededAnchor && anchor ? seededAnchor.start - anchor.entryStart : 0);
        },
        initialMeasurementsCache: measurementSeedRef.current,
    });
    React.useEffect(() => {
        const container = scrollRef?.current;
        if (!isTanstack || !container || tanstackVirtualizer.scrollElement === container) return;
        // Activity restores child layout effects before the parent's scroll ref.
        // Reattach after refs settle, adopting the current viewport before core writes it.
        tanstackVirtualizer.scrollOffset = container.scrollTop;
        tanstackVirtualizer._willUpdate();
        tanstackVirtualizer.options.onChange?.(tanstackVirtualizer, false);
    });
    useIsomorphicLayoutEffect(() => {
        if (!isTanstack) return;
        tanstackVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = shouldAdjustHistoryScrollOnItemSizeChange;
        const dispose = installBatchedResizeItem(tanstackVirtualizer, finishHistoryMeasurement);
        return () => {
            dispose();
            for (const row of revealingHistoryRowsRef.current) row.style.removeProperty('opacity');
            revealingHistoryRowsRef.current.clear();
            unmeasuredHistoryRowsRef.current.clear();
            columnReadingAnchorRef.current = null;
        };
    }, [isTanstack, tanstackVirtualizer]);
    const finishHistoryMeasurement = useEvent(() => {
        restoreHistoryReadingAnchor();
        for (const row of revealingHistoryRowsRef.current) row.style.removeProperty('opacity');
        revealingHistoryRowsRef.current.clear();
        columnReadingAnchorRef.current = null;
    });
    const measureHistoryElement = useEvent((element: HTMLDivElement | null) => {
        tanstackVirtualizer.measureElement(element);
        if (!element || !element.isConnected) return;
        unmeasuredHistoryRowsRef.current.add(element);
    });
    useIsomorphicLayoutEffect(() => {
        if (!isTanstack || unmeasuredHistoryRowsRef.current.size === 0) return;
        // Read newly attached rows together before the browser can paint their
        // estimated padding. The existing resize batch commits sizes, padding
        // and the reading anchor before revealing these rows in that microtask.
        const measurements = [...unmeasuredHistoryRowsRef.current].filter((row) => row.isConnected).map((row) => ({
            row, index: tanstackVirtualizer.indexFromElement(row), height: row.getBoundingClientRect().height,
        }));
        unmeasuredHistoryRowsRef.current.clear();
        for (const { row, index, height } of measurements) {
            revealingHistoryRowsRef.current.add(row);
            tanstackVirtualizer.resizeItem(index, height);
        }
    });
    const columnWidthRef = React.useRef<number | null>(null);
    const columnMeasureTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    if (!isTanstack) {
        columnWidthRef.current = null;
    }
    const handleColumnResize = useEvent(() => {
        if (!isTanstack) return;
        const node = sizeContainerRef.current ?? scrollRef?.current;
        if (!node) return;
        const nextWidth = node.offsetWidth;
        if (!shouldInvalidateVirtualizerMeasurementsOnColumnResize(columnWidthRef.current, nextWidth)) {
            if (columnWidthRef.current === null && nextWidth > 0) {
                columnWidthRef.current = nextWidth;
            }
            return;
        }
        columnWidthRef.current = nextWidth;
        if (columnMeasureTimeoutRef.current !== null) {
            clearTimeout(columnMeasureTimeoutRef.current);
        }
        // ContextPanel animates width for 200ms. Measure after that transition
        // so wrap heights match the settled column, not an in-between frame.
        columnMeasureTimeoutRef.current = setTimeout(() => {
            columnMeasureTimeoutRef.current = null;
            const container = scrollRef?.current;
            const content = sizeContainerRef.current;
            if (container && content && !touchActiveRef.current) {
                columnReadingAnchorRef.current = captureViewportMessageAnchor(container, content);
            }
            // measure() clears sizes, but retained refs and unchanged row boxes
            // emit no new measurement. Enroll them in the same pre-paint batch
            // as newly attached rows before invalidating the cache.
            for (const row of tanstackVirtualizer.elementsCache.values()) {
                if (row.isConnected) unmeasuredHistoryRowsRef.current.add(row);
            }
            tanstackVirtualizer.measure();
        }, 220);
    });
    const canObserveColumnResize = isTanstack && typeof ResizeObserver !== 'undefined';
    useResizeObserver(
        canObserveColumnResize ? sizeContainerRef : null,
        handleColumnResize,
    );
    useResizeObserver(
        canObserveColumnResize && scrollRef ? scrollRef : null,
        handleColumnResize,
    );
    useUnmount(() => {
        if (columnMeasureTimeoutRef.current !== null) {
            clearTimeout(columnMeasureTimeoutRef.current);
            columnMeasureTimeoutRef.current = null;
        }
    });
    useIsomorphicLayoutEffect(() => {
        if (!isTanstack) return;
        handleColumnResize();
        // handleColumnResize is useEvent; seed once per virtualized mount.
        // eslint-disable-next-line react-hooks/exhaustive-deps -- handleColumnResize is useEvent
    }, [isTanstack]);
    useIsomorphicLayoutEffect(() => {
        committedEngineRef.current = isTanstack ? 'tanstack' : 'none';
        if (!isTanstack) {
            virtualizationTransitionAnchorRef.current = null;
            return;
        }

        const anchor = virtualizationTransitionAnchorRef.current;
        const container = scrollRef?.current;
        if (!anchor || !container) {
            return;
        }

        const message = findMessageElement(container, anchor.messageId);
        if (message) {
            const delta = message.getBoundingClientRect().top
                - container.getBoundingClientRect().top
                - anchor.offsetTop;
            if (Math.abs(delta) > 0.5) {
                tanstackVirtualizer.scrollToOffset(container.scrollTop + delta, { behavior: 'auto' });
            }
            virtualizationTransitionAnchorRef.current = null;
            return;
        }

        const index = entryKeys.indexOf(anchor.entryKey);
        if (index < 0 || anchor.attempts >= 1) {
            virtualizationTransitionAnchorRef.current = null;
            return;
        }

        anchor.attempts += 1;
        tanstackVirtualizer.scrollToIndex(index, { align: 'start' });
        retryVirtualizationTransitionAnchor();
    }, [engine, entryKeys, isTanstack, tanstackVirtualizer, virtualizationTransitionTick]);
    // Size-change scroll adjustment follows virtual-core's default (3.17.6+):
    // first measure compensates any above-fold row; remeasure only fully-above
    // rows; wasAtEnd pins total-size growth. Product policy diverges in one
    // place (installed above): fully-above rows are also compensated while
    // scrolling backward, because Markdown hydrating above an upward reader
    // after load-more otherwise shifts the visible messages.
    const virtualItems = tanstackVirtualizer.getVirtualItems();
    const mountedIndexes = virtualItems.map((item) => item.index);
    const [hydratedMarkdownEntryKeys, setHydratedMarkdownEntryKeys] = React.useState(() => (
        // Bottom-entering rows hydrate in this first commit; restore adds every
        // key a previous mount of the same scope had already hydrated. The
        // placeholder→Markdown swaps this replaces were the session-switch
        // flicker. Scroll-time metering still governs rows past this seed.
        createInitialMarkdownHydratedKeys(entryKeys, {
            seedCount: resolveMarkdownPreloadEntries(activityRenderMode),
            restore: readMarkdownHydrationRestore(timelineCacheKey),
        })
    ));
    // Streaming-tail Markdown is already painted. When that turn remounts into
    // history it must stay hydrated in this same render — an after-paint seed
    // would flash the deferred skeleton over finished content.
    let activeHydratedMarkdownEntryKeys = ensureNewestMarkdownKeyHydrated(
        hydratedMarkdownEntryKeys,
        entryKeys,
    );
    // Normal-flow rows already painted real Markdown. Enabling virtualization
    // must not replace their bodies with deferred hydration placeholders.
    for (const key of unvirtualizedSizesRef.current.keys()) {
        if (!activeHydratedMarkdownEntryKeys.has(key)) {
            if (activeHydratedMarkdownEntryKeys === hydratedMarkdownEntryKeys) {
                activeHydratedMarkdownEntryKeys = new Set(activeHydratedMarkdownEntryKeys);
            }
            activeHydratedMarkdownEntryKeys.add(key);
        }
    }
    if (activeHydratedMarkdownEntryKeys !== hydratedMarkdownEntryKeys) {
        setHydratedMarkdownEntryKeys(activeHydratedMarkdownEntryKeys);
    }
    // Latest hydrated set for the unmount-time restore write.
    const hydratedMarkdownKeysRef = React.useRef(activeHydratedMarkdownEntryKeys);
    hydratedMarkdownKeysRef.current = activeHydratedMarkdownEntryKeys;
    const lastScrollDirectionRef = React.useRef<MarkdownHydrationScrollDirection>(null);
    if (tanstackVirtualizer.scrollDirection) {
        lastScrollDirectionRef.current = tanstackVirtualizer.scrollDirection;
    }
    const visibleRangeStart = tanstackVirtualizer.range?.startIndex
        ?? virtualItems[0]?.index
        ?? Math.max(0, renderEntries.length - 1);
    const visibleRangeEnd = tanstackVirtualizer.range?.endIndex
        ?? virtualItems[virtualItems.length - 1]?.index
        ?? Math.max(0, renderEntries.length - 1);
    // Hydrating a visible row mid-scroll swaps its size spacer for real Markdown
    // after the virtualizer has already measured it, and the resulting scroll
    // compensation drags the viewport back toward earlier entries. Withholding
    // only the visible rows — while off-screen preload keeps running — means the
    // window is largely hydrated by the time the list settles, so the release
    // that follows is small instead of a screenful in one commit. The newest
    // entry is hydrated up front (see `ensureNewestMarkdownKeyHydrated`), so a
    // live turn never waits on this.
    const isScrolling = tanstackVirtualizer.isScrolling;
    const visibleMarkdownCount = Math.max(0, visibleRangeEnd - visibleRangeStart + 1);
    const markdownHydrationBatch = getMarkdownHydrationBatch({
        entryKeys,
        mountedIndexes,
        visibleStartIndex: visibleRangeStart,
        visibleEndIndex: visibleRangeEnd,
        scrollDirection: lastScrollDirectionRef.current,
        preloadEntries: resolveMarkdownPreloadEntries(activityRenderMode, visibleMarkdownCount),
        hydratedKeys: activeHydratedMarkdownEntryKeys,
        allowVisibleRelease: !isScrolling,
        preloadReleaseLimit: isScrolling
            ? resolveMarkdownPreloadReleaseWhileScrolling(activityRenderMode)
            : MARKDOWN_PRELOAD_RELEASE_IDLE,
        // While scrolling, visible is withheld entirely. Once idle, cap the
        // visible half so a dense collapsed viewport cannot freeze one frame.
        visibleReleaseLimit: isScrolling
            ? 0
            : resolveMarkdownVisibleReleaseLimit(activityRenderMode),
    });
    // The batch identity, not its array identity, is what the release effect
    // reacts to. The ref lets the after-paint task release the batch the list
    // wants now rather than the one that happened to schedule the task.
    const markdownHydrationBatchKey = markdownHydrationBatch.join('\u0000');
    const markdownHydrationBatchRef = React.useRef(markdownHydrationBatch);
    markdownHydrationBatchRef.current = markdownHydrationBatch;
    React.useEffect(() => {
        if (!isTanstack || !markdownHydrationBatchKey) {
            return;
        }
        return scheduleAfterPaintTask(() => {
            React.startTransition(() => {
                setHydratedMarkdownEntryKeys((current) => {
                    let next: Set<string> | null = null;
                    for (const key of markdownHydrationBatchRef.current) {
                        if (current.has(key)) {
                            continue;
                        }
                        next ??= new Set(current);
                        next.add(key);
                    }
                    return next ?? current;
                });
            });
        });
    }, [isTanstack, markdownHydrationBatchKey]);

    React.useEffect(() => {
        setHydratedMarkdownEntryKeys((current) => pruneMarkdownHydratedKeys(current, entryKeys));
    }, [entryKeys]);

    // Keep unknown-row estimates fixed within this timeline/mode. Changing the
    // global estimate after one row is measured silently moves every other
    // unmeasured row, outside the core's per-row scroll compensation.

    React.useEffect(() => {
        if (!isTanstack) return;
        registerTanstackVirtualizer?.(tanstackVirtualizer);
        return () => {
            writeTanstackTimelineCache(
                timelineCacheKey,
                entriesRef.current.map((entry) => entry.key),
                tanstackVirtualizer,
            );
            writeMarkdownHydrationRestore(timelineCacheKey, hydratedMarkdownKeysRef.current);
            registerTanstackVirtualizer?.(null);
        };
        // registerTanstackVirtualizer is useEvent (stable identity); semantic deps only.
        // eslint-disable-next-line react-hooks/exhaustive-deps -- registerTanstackVirtualizer is useEvent
    }, [isTanstack, tanstackVirtualizer, timelineCacheKey]);

    const renderEntry = useRenderPhaseCallback((entry: RenderEntry, hydrateMarkdown: boolean = true) => {
        return (
            <MessageListEntry
                key={entry.key}
                entry={entry}
                hydrateMarkdown={hydrateMarkdown}
                onMessageContentChange={onMessageContentChange}
                getAnimationHandlers={getAnimationHandlers}
                scrollToBottom={scrollToBottom}
                stickyUserHeader={stickyUserHeader}
                sessionIsWorking={false}
                activityRenderMode={activityRenderMode}
                turnUiStates={turnUiStates}
                onToggleTurnGroup={onToggleTurnGroup}
                chatRenderMode={chatRenderMode}
                shouldAnimateUserMessage={shouldAnimateUserMessage}
                onUserAnimationConsumed={onUserAnimationConsumed}
                reviewTransferDirection={reviewTransferDirection}
            />
        );
    });

    if (!isTanstack) {
        return (
            <div ref={setHistoryRoot} className="relative w-full">
                <div>
                    {renderEntries.map((entry) => (
                        <div
                            key={entry.key}
                            data-turn-entry={entry.key}
                            className="yuri-chat-message-layout-boundary"
                        >
                            {renderEntry(entry)}
                        </div>
                    ))}
                </div>
            </div>
        );
    }

    if (engine === 'tanstack') {
        const startOffset = virtualItems[0]?.start ?? 0;
        const lastEnd = virtualItems[virtualItems.length - 1]?.end ?? 0;
        const historyFrameStyle = resolveTanstackHistoryFrameStyle(
            startOffset,
            lastEnd,
            tanstackVirtualizer.getTotalSize(),
        );
        // Rendered rows stay in normal flow inside a single offset wrapper (not
        // per-row absolute positioning) so per-turn sticky user headers keep
        // working against the scroll container. The offset MUST be padding, not
        // transform: a transformed ancestor becomes the sticky containing block,
        // so headers would stick to the wrapper's (arbitrary, overscan-dependent)
        // top edge mid-list and float over the previous turn. Padding only
        // changes when the virtual window shifts — not per scroll frame — so the
        // layout cost is negligible. minHeight + trailing padding reserve the
        // unrendered range without locking the frame to cached sizes: a visible
        // row taller than its cache grows this sibling and keeps the live tail
        // below it instead of painting through it.
        return (
            <div
                ref={setHistoryRoot}
                className="relative flow-root w-full"
                style={{ minHeight: historyFrameStyle.minHeight }}
            >
                <div
                    style={{
                        // Core 3.19 holds unwritable corrections by exposing negative
                        // row starts. Preserve that shift without a transform (sticky headers).
                        marginTop: historyFrameStyle.marginTop,
                        paddingTop: historyFrameStyle.paddingTop,
                        paddingBottom: historyFrameStyle.paddingBottom,
                    }}
                >
                    {virtualItems.map((item) => {
                        const entry = renderEntries[item.index];
                        if (!entry) return null;
                        return (
                            <div
                                key={entry.key}
                                data-index={item.index}
                                ref={measureHistoryElement}
                                data-turn-entry={entry.key}
                                style={{ opacity: tanstackVirtualizer.itemSizeCache.has(entry.key) ? undefined : 0 }}
                                className="yuri-chat-message-layout-boundary"
                            >
                                {renderEntry(
                                    entry,
                                    activeHydratedMarkdownEntryKeys.has(entry.key),
                                )}
                            </div>
                        );
                    })}
                </div>
            </div>
        );
    }

    return null;
});

StaticHistoryList.displayName = 'StaticHistoryList';

/**
 * One turn inside the tail. Every tail entry — the streaming one and the ones
 * that already finished — renders through this single component so React
 * reconciles them by key. Rendering the newest turn from a different component
 * (or a different child slot) would tear its DOM down the moment a newer turn
 * arrived, which is the migration the tail window exists to remove.
 *
 * Memoized so live-part ticks, which only change the newest entry, leave the
 * finished ones untouched.
 */
const TailEntry = React.memo<{
    entry: RenderEntry;
    onMessageContentChange: (reason?: ContentChangeReason) => void;
    getAnimationHandlers: (messageId: string) => AnimationHandlers;
    scrollToBottom?: () => void;
    stickyUserHeader: boolean;
    sessionIsWorking: boolean;
    activityRenderMode: 'collapsed' | 'summary';
    turnUiStates: Map<string, TurnUiState>;
    onToggleTurnGroup: (turnId: string, defaultExpanded: boolean) => void;
    chatRenderMode: 'sorted' | 'live';
    shouldAnimateUserMessage: (message: ChatMessageEntry) => boolean;
    onUserAnimationConsumed: (messageId: string) => void;
    activeStreamingMessageId?: string | null;
    activeStreamingPhase?: StreamPhase | null;
    reviewTransferDirection?: ReviewTransferDirection | null;
}>((props) => (
    <div className="yuri-chat-message-layout-boundary">
        <MessageListEntry {...props} />
    </div>
));

TailEntry.displayName = 'TailEntry';

const StreamingTailContent: React.FC<{
    entries: RenderEntry[];
    directory?: string;
    /** Session scope for repository-narrowed parts subscription (Ticket 02). */
    sessionId?: string | null;
    onMessageContentChange: (reason?: ContentChangeReason) => void;
    getAnimationHandlers: (messageId: string) => AnimationHandlers;
    scrollToBottom?: () => void;
    stickyUserHeader: boolean;
    sessionIsWorking: boolean;
    activityRenderMode: 'collapsed' | 'summary';
    turnUiStates: Map<string, TurnUiState>;
    onToggleTurnGroup: (turnId: string, defaultExpanded: boolean) => void;
    chatRenderMode: 'sorted' | 'live';
    showTurnChangedFiles: boolean;
    shouldAnimateUserMessage: (message: ChatMessageEntry) => boolean;
    onUserAnimationConsumed: (messageId: string) => void;
    activeStreamingMessageId?: string | null;
    activeStreamingPhase?: StreamPhase | null;
    reviewTransferDirection?: ReviewTransferDirection | null;
}> = ({
    entries,
    directory,
    sessionId,
    onMessageContentChange,
    getAnimationHandlers,
    scrollToBottom,
    stickyUserHeader,
    sessionIsWorking,
    activityRenderMode,
    turnUiStates,
    onToggleTurnGroup,
    chatRenderMode,
    showTurnChangedFiles,
    shouldAnimateUserMessage,
    onUserAnimationConsumed,
    activeStreamingMessageId,
    activeStreamingPhase,
    reviewTransferDirection,
}) => {
    const newestIndex = entries.length - 1;
    // Ticket 02 remediation: session-scoped repository parts subscription —
    // no directory-wide notify fallback when sessionId is provided.
    const liveParts = useSessionParts(
        activeStreamingMessageId ?? '',
        directory,
        sessionId ?? undefined,
    );
    // The tail stays mounted through empty frames (see the mount note at the
    // call site), so the newest entry can be absent for a render.
    const liveEntry = React.useMemo(() => {
        const newest = entries[newestIndex];
        if (!newest) return undefined;
        return buildLiveStreamingEntry(newest, {
            activeStreamingMessageId,
            liveParts,
            showTextJustificationActivity: chatRenderMode === 'sorted',
            showTurnChangedFiles,
        });
    }, [activeStreamingMessageId, chatRenderMode, entries, newestIndex, liveParts, showTurnChangedFiles]);

    return (
        <>
            {entries.map((entry, index) => {
                const isNewest = index === newestIndex;
                return (
                    <TailEntry
                        key={entry.key}
                        entry={isNewest ? liveEntry ?? entry : entry}
                        onMessageContentChange={onMessageContentChange}
                        getAnimationHandlers={getAnimationHandlers}
                        scrollToBottom={scrollToBottom}
                        stickyUserHeader={stickyUserHeader}
                        sessionIsWorking={isNewest ? sessionIsWorking : false}
                        activityRenderMode={activityRenderMode}
                        turnUiStates={turnUiStates}
                        onToggleTurnGroup={onToggleTurnGroup}
                        chatRenderMode={chatRenderMode}
                        shouldAnimateUserMessage={shouldAnimateUserMessage}
                        onUserAnimationConsumed={onUserAnimationConsumed}
                        activeStreamingMessageId={isNewest ? activeStreamingMessageId : null}
                        activeStreamingPhase={isNewest ? activeStreamingPhase : null}
                        reviewTransferDirection={reviewTransferDirection}
                    />
                );
            })}
        </>
    );
};

StreamingTailContent.displayName = 'StreamingTailContent';

const MessageList = React.forwardRef<MessageListHandle, MessageListProps>(({
    sessionKey,
    virtualizerKey,
    messages,
    sessionIsWorking = false,
    activeStreamingMessageId = null,
    activeStreamingPhase = null,
    retryOverlay = null,
    onMessageContentChange,
    getAnimationHandlers,
    scrollToBottom,
    scrollRef,
    directory,
    liveStatusSlot,
    timelineHistoryAnchorToken,
    enableSendPark = true,
    initialPinRevealComplete = false,
}, ref) => {
    streamPerfCount('ui.message_list.render');
    const { sessionKey: domainSessionKey, virtualizerKey: resolvedVirtualizerKey } = resolveMessageListKeys(sessionKey, virtualizerKey);
    const compactionDisclosureStore = React.useMemo(
        () => createCompactionDisclosureStore(),
        // A view owns disclosure state across row recycling, never across sessions.
        // eslint-disable-next-line react-hooks/exhaustive-deps -- explicit view lifetime
        [domainSessionKey, directory],
    );
    const stickyUserHeader = useUIStore(state => state.stickyUserHeader);
    const chatRenderMode = useUIStore((state) => state.chatRenderMode);
    const activityRenderMode = useUIStore((state) => state.activityRenderMode);
    const showTurnChangedFiles = useUIStore((state) => state.showTurnChangedFiles);
    const reviewTransferDirection = useGlobalSessionsStore((state) => {
        return state.reviewTransferBySessionId.get(domainSessionKey) ?? null;
    });
    const [turnUiStates, setTurnUiStates] = React.useState<Map<string, TurnUiState>>(() => new Map());
    const [turnUiSessionKey, setTurnUiSessionKey] = React.useState(domainSessionKey);
    if (turnUiSessionKey !== domainSessionKey) {
        setTurnUiSessionKey(domainSessionKey);
        setTurnUiStates(new Map());
    }
    const userAnimationRef = React.useRef<{
        sessionKey: string | undefined;
        previousOrder: string[];
        animatedIds: Set<string>;
    }>({ sessionKey: undefined, previousOrder: [], animatedIds: new Set() });
    useIsomorphicLayoutEffect(() => {
        if (!enableSendPark) return;
        return () => {
            // Same-turn Strict remount still peeks the latch during render.
            // A later reopen must not, or the list parks on the old user row.
            queueMicrotask(() => {
                clearConsumedUserSendAnimation(sessionKey);
            });
        };
    }, [enableSendPark, sessionKey]);
    const stableGetAnimationHandlers = useEvent(getAnimationHandlers);
    const stableScrollToBottom = useEvent(() => {
        scrollToBottom?.();
    });

    const toggleTurnGroup = useEvent((turnId: string, defaultExpanded: boolean) => {
        setTurnUiStates((previous) => {
            const next = new Map(previous);
            next.set(turnId, { isExpanded: resolveToggledActivityExpanded(defaultExpanded) });
            return next;
        });
    });


    const baseDisplayMessages = React.useMemo(() => streamPerfMeasure('ui.message_list.base_display_ms', () => {
        const seenIds = new Set<string>();
        const latestById = new Map<string, ChatMessageEntry>();
        const dedupedMessages: ChatMessageEntry[] = [];
        for (const message of messages) {
            const messageId = message.info?.id;
            if (typeof messageId === 'string') latestById.set(messageId, message);
        }

        // Preserve the first occurrence's chronological position, but use the last
        // value because prepended history can overlap with newer live store data.
        for (let index = 0; index < messages.length; index += 1) {
            const message = messages[index];
            const messageId = message.info?.id;
            if (typeof messageId === 'string') {
                if (seenIds.has(messageId)) {
                    continue;
                }
                seenIds.add(messageId);
            }
            dedupedMessages.push(getNormalizedMessageForDisplay(
                typeof messageId === 'string' ? latestById.get(messageId) ?? message : message,
            ));
        }

        const output: ChatMessageEntry[] = [];
        const compactionCommandIds = new Set<string>();
        // A later assistant row confirms execution resumed. Retire the notice
        // in source order for both live output and reloaded history, without
        // removing the model-facing synthetic record from the transcript.
        let lastAssistantIndex = -1;
        for (let index = dedupedMessages.length - 1; index >= 0; index -= 1) {
            if (dedupedMessages[index].info.role !== 'assistant') continue;
            lastAssistantIndex = index;
            break;
        }
        for (let index = 0; index < dedupedMessages.length; index += 1) {
            const current = dedupedMessages[index];
            if (index < lastAssistantIndex && isRestartNotice(current.info)) continue;
            const currentWithRole = normalizeCompactionSummaryMessage(current, compactionCommandIds);
            if (isCompactionCommandMessage(current)) {
                compactionCommandIds.add(current.info.id);
            }
            const previous = output.length > 0 ? output[output.length - 1] : undefined;

            if (isUserSubtaskMessage(previous)) {
                const bridge = isSyntheticSubtaskBridgeAssistant(currentWithRole);
                if (bridge.hide) {
                    output[output.length - 1] = withSubtaskSessionId(previous as ChatMessageEntry, bridge.taskSessionId);
                    continue;
                }
            }

            if (isUserShellMarkerMessage(previous)) {
                const bridge = getShellBridgeAssistantDetails(currentWithRole, getMessageId(previous));
                if (bridge.hide) {
                    output[output.length - 1] = withShellBridgeDetails(previous as ChatMessageEntry, bridge.details);
                    continue;
                }
            }

            output.push(currentWithRole);
        }

        return output;
    }), [messages]);

    const historyContentRef = React.useRef<HTMLDivElement | null>(null);
    // Single active multi-frame anchor hold. A new hold cancels the previous
    // one so concurrent writers never fight over scrollTop.
    const activeAnchorHoldRef = React.useRef<{
        cancel: () => void;
    } | null>(null);
    const cancelViewportAnchorHold = React.useCallback(() => {
        const active = activeAnchorHoldRef.current;
        if (!active) return;
        activeAnchorHoldRef.current = null;
        active.cancel();
    }, []);
    React.useEffect(() => () => {
        cancelViewportAnchorHold();
    }, [cancelViewportAnchorHold]);
    const resolveScrollContainer = useEvent((): HTMLDivElement | null => {
        if (scrollRef?.current) {
            return scrollRef.current;
        }
        if (typeof document === 'undefined') {
            return null;
        }
        return document.querySelector<HTMLDivElement>('[data-scrollbar="chat"]');
    });

    const displayMessages = React.useMemo(() => streamPerfMeasure('ui.message_list.retry_overlay_ms', () => {
        return applyRetryOverlay(baseDisplayMessages, {
            sessionId: retryOverlay?.sessionId ?? null,
            message: retryOverlay?.message ?? 'Quota limit reached. Retrying automatically.',
            confirmedAt: retryOverlay?.confirmedAt,
            fallbackTimestamp: retryOverlay?.fallbackTimestamp ?? 0,
        });
    }), [baseDisplayMessages, retryOverlay]);

    // Reserve the latest turn in the tail from its first paint, including idle
    // history. Arming only on busy moves an already-mounted turn between two
    // React parents, rebuilding Markdown and losing row-local UI state.
    const liveTailActive = sessionIsWorking || Boolean(activeStreamingMessageId);

    const { projection, streamingTurns } = useTurnRecords(displayMessages, {
        sessionKey: domainSessionKey,
        // Activity is the original ordered prefix, never a regrouping by type.
        showTextJustificationActivity: chatRenderMode === 'sorted',
        showTurnChangedFiles,
        hasLiveTail: true,
        liveTailActive,
    });
    // Retain live expansion through step gaps and missing final content. Mark it
    // automatic so a confirmed final answer can restore the configured fold.
    useIsomorphicLayoutEffect(() => {
        if (!liveTailActive) return;
        setTurnUiStates((previous) => {
            let next = previous;
            for (const turn of streamingTurns) {
                if (turn.completionDisposition !== 'active' || turn.assistantMessages.length === 0 || previous.has(turn.turnId)) continue;
                if (next === previous) next = new Map(previous);
                next.set(turn.turnId, { isExpanded: true, automatic: true });
            }
            return next;
        });
    }, [liveTailActive, streamingTurns]);
    const timelineEntries = React.useMemo(() => streamPerfMeasure('ui.message_list.render_entries_ms', () => {
        return splitTimelineRenderEntries({
            messages: displayMessages,
            turns: projection.turns,
            streamingTurns,
            ungroupedMessageIds: projection.ungroupedMessageIds,
            lastTurnId: projection.lastTurnId,
        });
    }), [
        displayMessages,
        projection.lastTurnId,
        projection.turns,
        projection.ungroupedMessageIds,
        streamingTurns,
    ]);
    const staticRenderEntries = timelineEntries.history;
    const trailingStreamingEntries = timelineEntries.tail;
    const hasTrailingStreamingEntries = trailingStreamingEntries.length > 0;

    // Counts live streaming renders only — the tail outlives the stream now
    // (see the sticky live-tail note above), so the tail being non-empty alone
    // would keep reporting a stream that already finished.
    if (hasTrailingStreamingEntries && liveTailActive) {
        streamPerfCount('ui.message_list.render.streaming');
    }

    const historyEntries = staticRenderEntries;
    // All surfaces virtualize with @tanstack/react-virtual (see the engine
    // note at the top of the file). An unvirtualized list is kept only for
    // tiny histories where windowing overhead is not worth it.
    const shouldVirtualizeHistory = historyEntries.length >= resolveHistoryVirtualizationThreshold();
    const currentHistoryVirtualizationRef = React.useRef(shouldVirtualizeHistory);
    syncCurrentHistoryVirtualization(currentHistoryVirtualizationRef, shouldVirtualizeHistory);
    const historyEngine: HistoryEngine = shouldVirtualizeHistory ? 'tanstack' : 'none';
    const tanstackVirtualizerRef = React.useRef<TanstackVirtualizerInstance | null>(null);
    const registerTanstackVirtualizer = useEvent((virtualizer: TanstackVirtualizerInstance | null) => {
        tanstackVirtualizerRef.current = virtualizer;
    });

    const allEntries = React.useMemo(() => {
        return trailingStreamingEntries.length > 0
            ? [...historyEntries, ...trailingStreamingEntries]
            : historyEntries;
    }, [historyEntries, trailingStreamingEntries]);
    const [pinRevealGeneration, setPinRevealGeneration] = React.useState(0);
    const [tanstackPinRoot, setTanstackPinRoot] = React.useState<HTMLDivElement | null>(null);
    const tanstackPinScopeKey = resolveTimelineVirtualizerCacheKey(
        resolvedVirtualizerKey,
        activityRenderMode,
    );
    const tanstackPinKeys = React.useMemo(
        () => resolveMarkdownPinRevealKeys({
            entryKeys: allEntries.map((entry) => entry.key),
            seedCount: resolveMarkdownPreloadEntries(activityRenderMode),
        }),
        // Jump and session identity freeze the seed; length/tail cover a new last turn.
        // eslint-disable-next-line react-hooks/exhaustive-deps -- pinRevealGeneration + tail
        [tanstackPinScopeKey, pinRevealGeneration, allEntries.length, allEntries[allEntries.length - 1]?.key, activityRenderMode],
    );
    const tanstackPinHidden = useMarkdownPinReveal({
        scopeKey: tanstackPinScopeKey,
        generation: pinRevealGeneration,
        root: tanstackPinRoot,
        relevantKeys: tanstackPinKeys,
        // Trial without the legacy whole-transcript visibility gate.
        enabled: false,
        initiallyRevealed: initialPinRevealComplete,
    });
    const tanstackPinStyle = mergeMarkdownPinRevealStyle(undefined, tanstackPinHidden);

    const stableHistoryContentChange = useEvent((reason?: ContentChangeReason) => {
        onMessageContentChange(reason);
    });

    const stableTailContentChange = useEvent((reason?: ContentChangeReason) => {
        onMessageContentChange(reason);
    });

    const currentUserOrder = React.useMemo(() => {
        return messages
            .filter((message) => resolveMessageRole(message) === 'user')
            .map((message) => message.info.id);
    }, [messages]);

    // Detect new user messages SYNCHRONOUSLY during render.
    // This keeps the first render of a new message in the same animation state
    // as its append lifecycle.
    const anim = userAnimationRef.current;
    const sessionChanged = anim.sessionKey !== sessionKey;
    const previousUserOrder = anim.previousOrder;
    if (sessionChanged) {
        // A remount starts with sessionKey undefined, which must not clear
        // the module latch. Secondary transcripts never own that latch.
        if (enableSendPark && anim.sessionKey !== undefined) {
            clearConsumedUserSendAnimation(anim.sessionKey);
        }
        anim.sessionKey = sessionKey;
        anim.previousOrder = currentUserOrder;
        anim.animatedIds = new Set();
    }

    if (enableSendPark) {
        resolveConsumedSendMessageId({
            sessionId: sessionKey,
            sessionChanged,
            previousUserOrder,
            currentUserOrder,
            animatedIds: anim.animatedIds,
        });
    }
    anim.previousOrder = currentUserOrder;

    const shouldAnimateUserMessage = useEvent((message: ChatMessageEntry): boolean => {
        if (resolveMessageRole(message) !== 'user') return false;
        return userAnimationRef.current.animatedIds.has(message.info.id);
    });

    const onUserAnimationConsumed = useEvent((messageId: string) => {
        userAnimationRef.current.animatedIds.delete(messageId);
    });

    const messageIndexMap = React.useMemo(() => {
        const indexMap = new Map<string, number>();

        allEntries.forEach((entry, index) => {
            if (entry.kind === 'ungrouped') {
                indexMap.set(entry.message.info.id, index);
                return;
            }
            if (entry.turn.userMessage) indexMap.set(entry.turn.userMessage.info.id, index);
            entry.turn.assistantMessages.forEach((message) => {
                indexMap.set(message.info.id, index);
            });
        });

        return indexMap;
    }, [allEntries]);

    const turnIndexMap = React.useMemo(() => {
        const indexMap = new Map<string, number>();
        allEntries.forEach((entry, index) => {
            if (entry.kind === 'turn') {
                indexMap.set(entry.turn.turnId, index);
            }
        });
        return indexMap;
    }, [allEntries]);

    const findMessageElement = useEvent((messageId: string): HTMLElement | null => {
        const container = resolveScrollContainer();
        if (!container) {
            return null;
        }
        return container.querySelector(`[data-message-id="${messageId}"]`);
    });

    const scrollHistoryIndexIntoView = useEvent((index: number, behavior: ScrollBehavior = 'auto') => {
        if (index < 0 || index >= historyEntries.length) {
            return false;
        }

        if (!shouldVirtualizeHistory) {
            return false;
        }

        const virtualizer = tanstackVirtualizerRef.current;
        if (!virtualizer) {
            return false;
        }

        virtualizer.scrollToIndex(index, { align: 'start', behavior: behavior === 'smooth' ? 'smooth' : 'auto' });
        return true;
    });

    const scrollMessageElementIntoView = useEvent((messageId: string, behavior: ScrollBehavior = 'auto') => {
        const container = resolveScrollContainer();
        if (!container) {
            return false;
        }
        const messageElement = findMessageElement(messageId);
        if (!messageElement) {
            return false;
        }

        const containerRect = container.getBoundingClientRect();
        const messageRect = messageElement.getBoundingClientRect();
        const offset = 50;
        const top = messageRect.top - containerRect.top + container.scrollTop - offset;
        container.scrollTo({ top, behavior });
        return true;
    });

    React.useEffect(() => {
        if (!ref) {
            return;
        }

        const handle: MessageListHandle = {
            scrollToTurnId: (turnId: string, options?: { behavior?: ScrollBehavior }) => {
                const behavior = options?.behavior ?? 'auto';
                const index = turnIndexMap.get(turnId);
                if (index === undefined) {
                    return false;
                }

                const container = resolveScrollContainer();
                if (!container) {
                    return false;
                }
                const turnElement = container.querySelector<HTMLElement>(`[data-turn-id="${turnId}"]`);
                if (turnElement) {
                    turnElement.scrollIntoView({ behavior, block: 'start' });
                    return true;
                }

                const targetIsTail = hasTrailingStreamingEntries && index >= historyEntries.length;
                if (targetIsTail) {
                    return false;
                }

                return scrollHistoryIndexIntoView(index, behavior);
            },

            scrollToMessageId: (messageId: string, options?: { behavior?: ScrollBehavior }) => {
                const behavior = options?.behavior ?? 'auto';
                const index = messageIndexMap.get(messageId);
                if (index === undefined) {
                    return false;
                }

                return scrollMessageElementIntoView(messageId, behavior)
                    || (
                        hasTrailingStreamingEntries && index >= historyEntries.length
                            ? false
                            : scrollHistoryIndexIntoView(index, behavior)
                    );
            },

            holdViewportAnchor: (anchor) => {
                const container = resolveScrollContainer();
                if (!container || typeof window === 'undefined') {
                    return;
                }

                // Only one hold at a time: cancel any previous rAF + listeners.
                cancelViewportAnchorHold();

                let frames = 0;
                let stable = 0;
                let cancelled = false;
                let rafId: number | null = null;
                const removeListeners = () => {
                    container.removeEventListener('touchstart', cancelOnUserInput);
                    container.removeEventListener('wheel', cancelOnUserInput);
                    container.removeEventListener('keydown', cancelOnUserInput);
                    container.removeEventListener('pointerdown', cancelOnUserInput);
                };
                const cancelHold = () => {
                    if (cancelled) return;
                    cancelled = true;
                    if (rafId !== null) {
                        window.cancelAnimationFrame(rafId);
                        rafId = null;
                    }
                    removeListeners();
                    if (activeAnchorHoldRef.current?.cancel === cancelHold) {
                        activeAnchorHoldRef.current = null;
                    }
                };
                const cancelOnUserInput = () => {
                    cancelHold();
                };
                activeAnchorHoldRef.current = { cancel: cancelHold };
                container.addEventListener('touchstart', cancelOnUserInput, { passive: true });
                container.addEventListener('wheel', cancelOnUserInput, { passive: true });
                container.addEventListener('keydown', cancelOnUserInput);
                container.addEventListener('pointerdown', cancelOnUserInput, { passive: true });
                const step = () => {
                    if (cancelled) return;
                    const element = findMessageElement(anchor.messageId);
                    if (element) {
                        const delta = element.getBoundingClientRect().top
                            - container.getBoundingClientRect().top
                            - anchor.offsetTop;
                        if (Math.abs(delta) > 0.5) {
                            container.scrollTop += delta;
                            stable = 0;
                        } else {
                            stable += 1;
                        }
                    }
                    frames += 1;
                    if (stable >= ANCHOR_HOLD_STABLE_FRAMES || frames >= ANCHOR_HOLD_MAX_FRAMES) {
                        cancelHold();
                        return;
                    }
                    rafId = window.requestAnimationFrame(step);
                };
                rafId = window.requestAnimationFrame(step);
            },

            cancelViewportAnchorHold,

            isHistoryVirtualized: () => (
                currentHistoryVirtualizationRef.current
            ),

            captureViewportAnchor: () => {
                const container = resolveScrollContainer();
                if (!container) {
                    return null;
                }

                const containerRect = container.getBoundingClientRect();
                const nodes: HTMLElement[] = Array.from(container.querySelectorAll<HTMLElement>('[data-message-id]'));
                // Prefer a message that starts inside the viewport: a message
                // straddling the top edge can hydrate or shrink internally
                // while its own top stays put, moving everything the reader
                // sees below it without any anchor delta.
                const firstStartingInView = nodes.find((node) => {
                    const rect = node.getBoundingClientRect();
                    return rect.top >= containerRect.top
                        && rect.top < containerRect.bottom
                        && (typeof window === 'undefined' || !isInsideStuckSticky(node, container, containerRect.top));
                });
                const firstVisible = firstStartingInView ?? nodes.find((node) => {
                    const rect = node.getBoundingClientRect();
                    if (rect.bottom <= containerRect.top + 1) {
                        return false;
                    }

                    if (typeof window === 'undefined') {
                        return true;
                    }

                    return !isInsideStuckSticky(node, container, containerRect.top);
                }) ?? nodes.find((node) => node.getBoundingClientRect().bottom > containerRect.top + 1);
                if (!firstVisible) {
                    return null;
                }

                const messageId = firstVisible.dataset.messageId;
                if (!messageId) {
                    return null;
                }

                return {
                    messageId,
                    offsetTop: firstVisible.getBoundingClientRect().top - containerRect.top,
                };
            },

            restoreViewportAnchor: (anchor: { messageId: string; offsetTop: number }) => {
                const container = resolveScrollContainer();
                if (!container) {
                    return false;
                }

                if (!messageIndexMap.has(anchor.messageId)) {
                    return false;
                }

                const applyAnchor = (): boolean => {
                    const element = findMessageElement(anchor.messageId);
                    if (!element) {
                        return false;
                    }
                    const containerRect = container.getBoundingClientRect();
                    const targetTop = element.getBoundingClientRect().top - containerRect.top;
                    const delta = targetTop - anchor.offsetTop;
                    if (delta !== 0) {
                        const target = container.scrollTop + delta;
                        const virtualizer = tanstackVirtualizerRef.current;
                        if (shouldVirtualizeHistory && virtualizer) {
                            // The child still displays the pre-request window
                            // until the active gesture settles.
                            if (virtualizer.options.count !== historyEntries.length) return true;
                            // An absolute restore includes the measured prepend.
                            // Let core retire its pending iOS touch compensation
                            // instead of replaying that delta after a DOM write.
                            virtualizer.scrollToOffset(target, { behavior: 'auto' });
                        } else {
                            container.scrollTop = target;
                        }
                    }
                    return true;
                };

                if (!applyAnchor()) {
                    const index = messageIndexMap.get(anchor.messageId);
                    if (typeof index === 'number' && index < historyEntries.length) {
                        return scrollHistoryIndexIntoView(index, 'auto');
                    }
                }

                return applyAnchor();
            },

            cancelScroll: () => {
                cancelViewportAnchorHold();
                tanstackVirtualizerRef.current?.cancelScroll();
            },
            scrollToBottom: ({ behavior = 'auto', reveal = true } = {}) => {
                if (reveal) setPinRevealGeneration((current) => current + 1);
                if (shouldVirtualizeHistory && historyEntries.length > 0 && tanstackVirtualizerRef.current) {
                    tanstackVirtualizerRef.current.scrollToEnd({ behavior });
                    return true;
                }
                return false;
            },
        };

        if (typeof ref === 'function') {
            ref(handle);
            return () => {
                ref(null);
            };
        }

        const objectRef = ref;
        objectRef.current = handle;
        return () => {
            objectRef.current = null;
        };
        // useEvent callbacks are identity-stable; semantic inputs below drive handle re-publish.
        // eslint-disable-next-line react-hooks/exhaustive-deps -- resolveScrollContainer/findMessageElement/scroll* are useEvent
    }, [cancelViewportAnchorHold, historyEntries.length, messageIndexMap, shouldVirtualizeHistory, hasTrailingStreamingEntries, turnIndexMap, ref]);

    const disableFadeIn = false;

    return (
        <CompactionDisclosureContext.Provider value={compactionDisclosureStore}>
        <div>
                <FadeInDisabledProvider disabled={disableFadeIn}>
                    <div
                        ref={setTanstackPinRoot}
                        className="relative w-full"
                        style={tanstackPinStyle}
                    >
                        {/* Virtualized history rows unmount/remount during scroll;
                            re-running the reveal fade on every remount reads as
                            blinking. History content is never "new", so fade-in
                            is disabled there — the streaming tail keeps it. */}
                        <FadeInDisabledProvider disabled={shouldVirtualizeHistory}>
                            <DeferredToolHydrationProvider enabled={true}>
                                <StaticHistoryList
                                    key={resolvedVirtualizerKey}
                                    entries={historyEntries}
                                    historyAnchorToken={timelineHistoryAnchorToken}
                                    engine={historyEngine}
                                    contentRef={historyContentRef}
                                    scrollRef={scrollRef}
                                    registerTanstackVirtualizer={registerTanstackVirtualizer}
                                    virtualizerKey={resolvedVirtualizerKey}
                                    onMessageContentChange={stableHistoryContentChange}
                                    getAnimationHandlers={stableGetAnimationHandlers}
                                    scrollToBottom={stableScrollToBottom}
                                    stickyUserHeader={stickyUserHeader}
                                    activityRenderMode={activityRenderMode}
                                    turnUiStates={turnUiStates}
                                    onToggleTurnGroup={toggleTurnGroup}
                                    chatRenderMode={chatRenderMode}
                                    shouldAnimateUserMessage={shouldAnimateUserMessage}
                                    onUserAnimationConsumed={onUserAnimationConsumed}
                                    reviewTransferDirection={reviewTransferDirection}
                                />
                            </DeferredToolHydrationProvider>
                        </FadeInDisabledProvider>
                        {/* Mounted unconditionally. Gating on a non-empty tail
                            destroyed the whole streaming subtree whenever the
                            projection was momentarily empty (materialize/merge
                            frames), and the next frame rebuilt it from scratch:
                            the user message and its reasoning blinked out and
                            back mid-turn. An empty tail now renders nothing
                            while keeping its fiber, subscription and DOM. */}
                        <StreamingTailContent
                            entries={trailingStreamingEntries}
                            directory={directory}
                            sessionId={domainSessionKey}
                            onMessageContentChange={stableTailContentChange}
                            getAnimationHandlers={stableGetAnimationHandlers}
                            scrollToBottom={stableScrollToBottom}
                            stickyUserHeader={stickyUserHeader}
                            sessionIsWorking={sessionIsWorking}
                            activityRenderMode={activityRenderMode}
                            turnUiStates={turnUiStates}
                            onToggleTurnGroup={toggleTurnGroup}
                            chatRenderMode={chatRenderMode}
                            showTurnChangedFiles={showTurnChangedFiles}
                            shouldAnimateUserMessage={shouldAnimateUserMessage}
                            onUserAnimationConsumed={onUserAnimationConsumed}
                            activeStreamingMessageId={activeStreamingMessageId}
                            activeStreamingPhase={activeStreamingPhase}
                            reviewTransferDirection={reviewTransferDirection}
                        />
                        {/* Inside pin-reveal root: cold-open must not leave a
                            visible status label over a still-hidden transcript. */}
                        {liveStatusSlot}
                    </div>
                </FadeInDisabledProvider>

        </div>
        </CompactionDisclosureContext.Provider>
    );
});

MessageList.displayName = 'MessageList';

export default React.memo(MessageList);
