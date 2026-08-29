import type { ChatInputSurface } from '@/components/chat/chatInputSurface';
import type { SessionSurfaceContextValue } from '@/components/chat/SessionSurfaceContext';
import { hasUserDisplayableParts } from '@/components/chat/message/normalizeUserDisplayParts';
import type { AssistantHistoryEntry } from '@/queries/assistantQueries';
import type { PendingUserMessagePresentation } from '@/sync/session-ui-store';
import type { SessionHistoryBoundary } from '@/sync/types';
import type { Message, Part } from '@opencode-ai/sdk/v2';

type SessionMessageRecord = { info: Message; parts: Part[] };

/**
 * Fold retained pending rows into an authoritative transcript.
 * Rows the transcript does not have yet are appended. A row it has but whose
 * parts never landed (or landed as non-displayable synthetics only) is
 * substituted by its pending counterpart in place, so a hollow record cannot
 * turn a sent message into an empty bubble; substituting rather than appending
 * keeps one row per message ID.
 */
export const mergePendingUserMessagePresentations = (
  messages: readonly SessionMessageRecord[],
  pending: readonly PendingUserMessagePresentation[],
): SessionMessageRecord[] => {
  if (pending.length === 0) return messages as SessionMessageRecord[];
  const pendingByID = new Map(pending.map((message) => [message.info.id, message]));
  let substituted = false;
  const reconciled = messages.map((message) => {
    if (hasUserDisplayableParts(message.parts)) return message;
    const standIn = pendingByID.get(message.info.id);
    if (!standIn) return message;
    substituted = true;
    return standIn;
  });
  const base = substituted ? reconciled : messages as SessionMessageRecord[];
  const messageIDs = new Set(messages.map((message) => message.info.id));
  const additions = pending.filter((message) => !messageIDs.has(message.info.id));
  return additions.length === 0 ? base : [...base, ...additions];
};

type PendingCreatedCarrier = {
  info: { time?: { created?: number } };
};

/**
 * Whether host/retained pending rows still imply in-flight work.
 * Pending forces working only until session status has clearly finished this
 * send: missing resolved status/observedAt, or newest pending `time.created`
 * later than `sessionStatusObservedAt`. A fresh idle observation at/after the
 * send no longer forces working (body may still show the retained row).
 */
export const pendingUserMessagesImplyWorking = (
  pending: readonly PendingCreatedCarrier[],
  input: {
    resolvedSessionStatus: { type?: string } | null | undefined;
    sessionStatusObservedAt: number | null | undefined;
  },
): boolean => {
  if (pending.length === 0) return false;

  let newestCreated: number | undefined;
  for (const message of pending) {
    const created = message.info.time?.created;
    if (typeof created !== 'number') continue;
    if (newestCreated === undefined || created > newestCreated) {
      newestCreated = created;
    }
  }

  if (
    !input.resolvedSessionStatus
    || typeof input.sessionStatusObservedAt !== 'number'
    || typeof newestCreated !== 'number'
    || newestCreated > input.sessionStatusObservedAt
  ) {
    return true;
  }

  // observedAt >= newest pending created — status has seen this send; do not
  // keep working solely because the presentation row is still retained.
  return false;
};

/**
 * Live + assistant archive history gates for the chat timeline.
 *
 * Pagination facts come from TranscriptRepository.getPagination (boundary
 * projection). The store adapter sources that from
 * repository pagination boundary; a Query adapter sources the same
 * shape from InfiniteData page metadata:
 *
 * - `unknown`   — no authoritative page yet: not complete, cannot load.
 * - `has-more`  — live history has earlier pages (cursor present).
 * - `exhausted` — live history is positively complete; the assistant archive
 *   (when present and incomplete) may still page further.
 *
 * `complete` is true only when live history is exhausted AND the assistant
 * archive (if any) is also complete. An unknown boundary is never treated as
 * complete, and never enables load-more.
 */
export const resolveChatHistoryLoadState = (input: {
  boundary: SessionHistoryBoundary
  /** When no assistant archive is present, treat as complete. */
  assistantComplete: boolean
}): { complete: boolean; canLoadEarlier: boolean } => {
  const liveComplete = input.boundary.kind === 'exhausted'
  const hasMoreLive = input.boundary.kind === 'has-more'
  const canLoadAssistantArchive = liveComplete && !input.assistantComplete
  const canLoadEarlier = hasMoreLive || canLoadAssistantArchive
  const complete = liveComplete && input.assistantComplete
  return { complete, canLoadEarlier }
}

/**
 * Timeline `historyMeta.loading` / concurrent-page wait gate.
 *
 * Only real useSync pagination flights and assistant-archive page loads block
 * `fetchOlderHistory`. Background sessionPrefetch (materialize / tail) can
 * stick at `status === 'loading'` on Relay for a long time and must never
 * OR into this gate — user-initiated load-more uses `fetchTranscriptPreviousPage`.
 * Prefetch status remains on the cold transcript gate only.
 */
export const resolveChatHistoryPaginationLoading = (input: {
  syncLoading: boolean
  assistantLoading: boolean
}): boolean => input.syncLoading || input.assistantLoading

/**
 * Mobile "load older" affordance contract.
 *
 * Visibility is authoritative-only: an unresolved history boundary (unknown
 * availability) renders nothing — no speculative placeholder, no spinner. The
 * button exists only when history positively has earlier pages
 * (`canLoadEarlier`) or a real user-initiated loadEarlier mutation is in
 * flight (that mutation keeps the button painted so its spinner has an
 * anchor). Spinner/disabled is mutation-owned (`isLoadingOlder`) — background
 * prefetch/SWR loading never drives the button.
 */
export const resolveMobileLoadOlderVisibility = (input: {
  isMobile: boolean
  canLoadEarlier: boolean
  isLoadingOlder: boolean
}): boolean =>
  input.isMobile && (input.canLoadEarlier || input.isLoadingOlder)

export const resolveMobileLoadOlderBusy = (input: {
  isLoadingOlder: boolean
}): boolean => input.isLoadingOlder

/**
 * Desktop (and non-mobile) load-older status line.
 *
 * Mobile already has the explicit top button + spinner. Desktop scroll / auto-fill
 * can wait on Host turn-page with no other affordance — show a restrained
 * muted status only while a real loadOlder flight is in progress. Never paint
 * from background historyLoading/prefetch.
 */
export const resolveDesktopLoadOlderStatusVisibility = (input: {
  isMobile: boolean
  isLoadingOlder: boolean
}): boolean => !input.isMobile && input.isLoadingOlder

/**
 * Cold-session transcript gate for ChatContainer.
 *
 * Session switch starts imperative + reactive message pulls. A transient or
 * stale `prefetch.status === 'error'` must not flash the "Unable to load"
 * wall while a load is in flight or before the first paint has a shell.
 *
 * - `hydrating`: stable skeleton — loading, user retry, or cold with no settled failure
 * - `load-error`: settled failure only (error + not loading + not retrying + no shell)
 * - `pass`: any landed/pending/hosted shell, a previously painted transcript on
 *   this mount, or a ready empty snapshot
 *
 * Retry from the load-error wall sets `userRetrying` so the gate returns to
 * `hydrating` on the click, then `retryTranscriptInitial` purges the failed
 * chain and ensures a fresh tail.
 *
 * The gate is sticky per session: once a transcript has painted, a later
 * empty read never demotes it. Transcript data is Query-cached, so an idle
 * session can lose its shell to cache eviction or a transport swap and read
 * back empty for one refetch. Demoting there swaps the whole viewport for the
 * skeleton branch, which unmounts the scroll container and composer and so
 * resets scroll, focus, and the composer caret.
 *
 * A repository P0 latch without rows is not a shell. Session-view remount
 * (desktop cache miss) can still see that latch after Query GC; treating it as
 * `pass` paints the empty-chat welcome for a frame before the tail returns.
 */
export type ChatSessionTranscriptGate = 'pass' | 'hydrating' | 'load-error'

/** Any landed row is a shell. Do not wait for a user message to leave the skeleton. */
export const hasChatTranscriptShell = (input: {
  transcriptMessageCount: number
  pendingUserCount: number
  historyPrefixCount: number
}): boolean =>
  input.transcriptMessageCount > 0
  || input.pendingUserCount > 0
  || input.historyPrefixCount > 0

export const resolveChatSessionTranscriptGate = (input: {
  /** Current transcript has at least one row. */
  hasTranscriptShell: boolean
  /** Repository-owned P0 latch for the latest authored turn. */
  p0Satisfied?: boolean
  /** Live status confirms that the current transcript shell is executing. */
  hasBusyShell?: boolean
  /** Retained pending presentation or authoritative hosted-history prefix. */
  hasImmediateShell?: boolean
  hasRenderableSessionSnapshot: boolean
  prefetchStatus?: 'loading' | 'ready' | 'error'
  syncLoading: boolean
  /** User clicked retry on the settled load-error wall for this session. */
  userRetrying?: boolean
  /** This session already painted a transcript under the current mount. */
  hasPaintedTranscript?: boolean
}): ChatSessionTranscriptGate => {
  // Visible rows always win. P0 without a shell must not: that latch outlives
  // Query data, and passing here flashes the empty-chat welcome on remount.
  if (input.hasTranscriptShell || input.hasBusyShell || input.hasImmediateShell) return 'pass'

  // Retained content outranks both the skeleton and the failure wall: a
  // refetch that errors must not blank a transcript the user is reading.
  if (input.hasPaintedTranscript) return 'pass'

  const loading = input.prefetchStatus === 'loading' || input.syncLoading || Boolean(input.userRetrying)
  if (loading) return 'hydrating'

  // Settled cold failure — only after the load epoch finished as error.
  if (input.prefetchStatus === 'error') return 'load-error'

  // Cold / not yet materialised: keep skeleton, never invent an empty success.
  if (!input.hasRenderableSessionSnapshot) return 'hydrating'

  return 'pass'
}

export type PaintedTranscript<T> = { sessionId: string; messages: readonly T[] }

/**
 * Retain the last painted transcript across a transient empty read.
 *
 * A non-empty read always wins and becomes the new retention. An empty read
 * for the same session replays the retained rows, which keeps the viewport
 * mounted and keeps the rendered count stable — a 0 → N rebound otherwise
 * reads as "first content landed" and re-pins the timeline to the bottom.
 * Switching sessions drops the retention: one session's rows must never paint
 * under another.
 */
export const resolveRetainedTranscript = <T>(input: {
  sessionId: string | null
  messages: readonly T[]
  retained: PaintedTranscript<T> | null
}): { messages: readonly T[]; retained: PaintedTranscript<T> | null } => {
  const { sessionId, messages, retained } = input
  if (!sessionId) return { messages, retained: null }
  if (messages.length > 0) return { messages, retained: { sessionId, messages } }
  if (retained?.sessionId === sessionId) return { messages: retained.messages, retained }
  return { messages, retained: null }
}

export type ChatContainerHostFeatures = {
  /** Primary-only new-session draft welcome. Hosted surfaces default this off. */
  newSessionDraft?: boolean;
  /** Desktop prompt navigator rail. Hosted surfaces default this off. */
  promptNavigator?: boolean;
  /** Navigate back to a parent/subagent session. Hosted surfaces default this off. */
  returnToParent?: boolean;
};

/**
 * Explicit host contract for embedding ChatContainer outside the primary
 * session selector (Assistant, and future secondary transcripts).
 *
 * When present, ChatContainer skips the primary session-view cache and renders
 * one bound transcript + composer for the supplied session/directory.
 */
export type ChatContainerHost = {
  sessionId: string;
  directory: string;
  composerSurface: ChatInputSurface;
  sessionSurface: SessionSurfaceContextValue;
  warning?: string | null;
  /** Local user rows retained until the same stable message ID materializes. */
  pendingUserMessages?: readonly PendingUserMessagePresentation[];
  onPendingUserMessagesMaterialized?: (messageIDs: readonly string[]) => void;
  /** Server-paged prior OpenCode entries to prepend ahead of the live binding. */
  assistantHistory?: {
    entries: readonly AssistantHistoryEntry[];
    complete: boolean;
    loading: boolean;
    fetchPrevious: () => Promise<unknown>;
  };
  features?: ChatContainerHostFeatures;
  onRevertMessage?: (messageId: string) => Promise<void>;
};

export const resolveChatContainerHostFeatures = (
  host: ChatContainerHost | undefined,
): Required<ChatContainerHostFeatures> => ({
  newSessionDraft: host?.features?.newSessionDraft ?? !host,
  promptNavigator: host?.features?.promptNavigator ?? !host,
  returnToParent: host?.features?.returnToParent ?? !host,
});
