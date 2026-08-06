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
 * - `hydrating`: stable skeleton — loading, or cold with no settled failure
 * - `load-error`: settled failure only (error + not loading + no shell)
 * - `pass`: enough UI shell (user/pending/history) or ready empty snapshot
 */
export type ChatSessionTranscriptGate = 'pass' | 'hydrating' | 'load-error'

export const resolveChatSessionTranscriptGate = (input: {
  /** User boundary, retained pending rows, or hosted history prefix. */
  hasTranscriptShell: boolean
  hasRenderableSessionSnapshot: boolean
  prefetchStatus?: 'loading' | 'ready' | 'error'
  syncLoading: boolean
}): ChatSessionTranscriptGate => {
  if (input.hasTranscriptShell) return 'pass'

  const loading = input.prefetchStatus === 'loading' || input.syncLoading
  if (loading) return 'hydrating'

  // Settled cold failure — only after the load epoch finished as error.
  if (input.prefetchStatus === 'error') return 'load-error'

  // Cold / not yet materialised: keep skeleton, never invent an empty success.
  if (!input.hasRenderableSessionSnapshot) return 'hydrating'

  return 'pass'
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
