/**
 * TranscriptRepository — unified read/command seam for session transcript.
 *
 * Ticket 03/09: production writers (HTTP page commit, SSE message/part,
 * optimistic, narrow reset, snapshot materialize, single-message remove) submit
 * through this contract. QueryCache is the sole production authority
 * (`createQueryTranscriptRepository` via `mountProductionTranscriptStack`).
 * The store-backed adapter remains a pure test / harness implementation only.
 *
 * Ownership:
 * - Reads: transcript data, pagination projection, request lifecycle snapshot,
 *   hydration phase (`idle` / `p0` / `p1` / `p2`) and `p0Satisfied`.
 * - Commands: HTTP page apply / reduced-page commit, SSE merge, optimistic
 *   add/confirm/remove, materialize-snapshots, remove-message, reset/clear.
 *   Query durable first-paint uses merge `durable-seed` (conservative
 *   has-more pagination derived from the oldest seeded record); it is not a
 *   store-adapter command so existing exhaustiveness stays intact.
 * - Does not own session catalog, status, permission, question, or message queue.
 * - Does not own full-session eviction (`dropSessionCaches`); that remains a
 *   multi-domain cache operation outside this repository.
 */

import type { Event, Message, Part } from "@opencode-ai/sdk/v2/client"
import { isMessageSnapshotOpen, isSlimPart } from "./displayParts"
import type { SessionHistoryBoundary } from "./types"
import type {
  SessionMergeStrategy,
  SessionMessagePagePurpose,
} from "./session-merge-strategy"
import type { SessionMessagePageMeta } from "./session-message-reducer"
import type { SessionMaterializationReason } from "./event-reducer"

// ---------------------------------------------------------------------------
// Scope identity
// ---------------------------------------------------------------------------

/**
 * Canonical transcript scope. Query-backed implementations will fold these
 * dimensions into Query keys; the store adapter scopes child-store reads/writes.
 */
export type TranscriptScope = {
  readonly directory: string
  readonly sessionID: string
  /** Transport identity (runtime transport fingerprint). Optional for store adapter. */
  readonly transport?: string
  /** Runtime generation. Optional for store adapter; Query adapters must honor it. */
  readonly generation?: number
}

// ---------------------------------------------------------------------------
// Read models
// ---------------------------------------------------------------------------

/**
 * Flat transcript projection for a single session.
 * messageOrder is chronological (oldest → newest), matching child-store arrays.
 */
export type TranscriptData = {
  readonly sessionID: string
  readonly messageOrder: readonly string[]
  readonly messagesByID: Readonly<Record<string, Message>>
  readonly partsByMessageID: Readonly<Record<string, readonly Part[]>>
  readonly boundary: SessionHistoryBoundary
  /**
   * Live revision captured from the owning directory when known.
   * Store adapter reports 0 when no revision tracker is supplied.
   */
  readonly liveRevision: number
}

/**
 * Pagination projection. Mirrors useSync hasMore / isComplete / loadMore cursor
 * semantics derived solely from SessionHistoryBoundary.
 */
export type TranscriptPagination = {
  readonly sessionID: string
  readonly boundary: SessionHistoryBoundary
  /** True only when boundary is has-more with a non-empty cursor. */
  readonly hasPreviousPage: boolean
  /** True only when boundary is exhausted (authoritative complete). */
  readonly isComplete: boolean
  /** Cursor for the next older-history page; null when unavailable. */
  readonly cursor: string | null
  /** Cumulative authored-user turns loaded so far. */
  readonly loadedTurns: number
}

/**
 * Request lifecycle projection for a session transcript load.
 * Query adapter sources this from InfiniteQuery observer status; store adapter
 * may report idle when no request-state reader is provided.
 */
export type TranscriptRequestState = {
  readonly sessionID: string
  readonly status: "idle" | "loading" | "ready" | "error"
  readonly error?: string
  readonly requestedLimit?: number
}

export type TranscriptMessageMaterializationStatus = "idle" | "loading" | "ready" | "error"

export type TranscriptMessageMaterializationState = {
  readonly sessionID: string
  readonly messageID: string
  readonly status: TranscriptMessageMaterializationStatus
  readonly error?: string
}

const EXACT_MATERIALIZATION_PART_TYPES = new Set(["tool", "reasoning", "file", "text"])

const EXACT_REVALIDATION_PART_TYPES = new Set(["tool", "reasoning", "file"])

/**
 * Whether a message still has projected tool / reasoning / file / text parts
 * that need an exact `session.message` fill. Callers use this plus
 * `getMessageMaterializationState` to decide whether to request.
 * Requires `isSlimPart`, so a durable full text body never matches.
 */
export function messageNeedsExactMaterialization(parts: readonly Part[]): boolean {
  return parts.some((part) =>
    isSlimPart(part) && EXACT_MATERIALIZATION_PART_TYPES.has(part.type),
  )
}

/**
 * Whether a durable-seeded message has tool / reasoning / file parts that
 * still need an exact `session.message` revalidation even when those parts
 * already look full. Text is intentionally excluded so cold-start
 * text-only messages do not fan out exact fetches.
 */
export function messageNeedsExactRevalidation(parts: readonly Part[]): boolean {
  return parts.some((part) => EXACT_REVALIDATION_PART_TYPES.has(part.type))
}

export type TranscriptHydrationPhase = "idle" | "p0" | "p1" | "p2"

export type TranscriptHydrationState = {
  readonly sessionID: string
  readonly phase: TranscriptHydrationPhase
  readonly p0Satisfied: boolean
}

const messageRole = (info: Message | undefined): string => {
  if (!info) return ""
  const raw = (info as { clientRole?: unknown; role?: unknown }).clientRole ?? info.role
  return typeof raw === "string" ? raw : ""
}

/**
 * Authored user turn used as the P0 tail boundary. Subtask / compaction rows
 * are not turns; empty user parts still count so a just-sent prompt can latch.
 */
export function isTranscriptHydrationAuthoredUser(
  info: Message | undefined,
  parts: readonly Part[] | undefined,
): boolean {
  if (!info?.id || messageRole(info) !== "user") return false
  if (!parts || parts.length === 0) return true
  return !parts.some((part) => part.type === "subtask" || part.type === "compaction")
}

export function countTranscriptAuthoredUserTurns(
  transcript: Pick<TranscriptData, "messageOrder" | "messagesByID" | "partsByMessageID">,
): number {
  let count = 0
  for (const id of transcript.messageOrder) {
    if (isTranscriptHydrationAuthoredUser(transcript.messagesByID[id], transcript.partsByMessageID[id])) {
      count += 1
    }
  }
  return count
}

const sameTurnAssistants = (
  transcript: Pick<TranscriptData, "messageOrder" | "messagesByID" | "partsByMessageID">,
  userID: string,
): Message[] => {
  const userIndex = transcript.messageOrder.lastIndexOf(userID)
  if (userIndex < 0) return []
  const assistants: Message[] = []
  for (let index = userIndex + 1; index < transcript.messageOrder.length; index += 1) {
    const id = transcript.messageOrder[index]!
    const info = transcript.messagesByID[id]
    if (!info) continue
    if (isTranscriptHydrationAuthoredUser(info, transcript.partsByMessageID[id])) break
    if (messageRole(info) !== "assistant") continue
    const parentID = (info as { parentID?: unknown }).parentID
    if (typeof parentID === "string" && parentID.length > 0 && parentID !== userID) continue
    assistants.push(info)
  }
  return assistants
}

const assistantHasDisplayableResult = (
  info: Message,
  parts: readonly Part[] | undefined,
): boolean => {
  if (isMessageSnapshotOpen(info)) return true
  return Array.isArray(parts) && parts.length > 0
}

/**
 * P0: latest authored user turn is readable and the same-turn assistant has a
 * displayable result or an in-progress row that can host the Activity shell.
 * A user-only tail stays unsatisfied so UI can pair live session status.
 */
export function evaluateTranscriptP0Satisfied(transcript: TranscriptData): boolean {
  let latestUserID: string | undefined
  for (let index = transcript.messageOrder.length - 1; index >= 0; index -= 1) {
    const id = transcript.messageOrder[index]!
    if (isTranscriptHydrationAuthoredUser(transcript.messagesByID[id], transcript.partsByMessageID[id])) {
      latestUserID = id
      break
    }
  }
  if (!latestUserID) return false
  return sameTurnAssistants(transcript, latestUserID).some((info) =>
    assistantHasDisplayableResult(info, transcript.partsByMessageID[info.id]),
  )
}

/**
 * Active work wins (p2 materialize, then p1 prepend). Otherwise the highest
 * satisfied phase: earlier history → p1, P0 latch → p0, else idle.
 */
export function resolveTranscriptHydrationPhase(input: {
  p0Satisfied: boolean
  prependActive?: boolean
  materializeActive?: boolean
  earlierHistoryLoaded?: boolean
}): TranscriptHydrationPhase {
  if (input.materializeActive) return "p2"
  if (input.prependActive || input.earlierHistoryLoaded) return "p1"
  if (input.p0Satisfied) return "p0"
  return "idle"
}

// ---------------------------------------------------------------------------
// Transport page / command inputs
// ---------------------------------------------------------------------------

/** Immutable HTTP transport page (records + pagination contract fields). */
export type TranscriptTransportPage = {
  readonly records: readonly {
    readonly info: Message
    readonly parts?: readonly Part[]
  }[]
  readonly cursor?: string
  readonly complete: boolean
  /** Authored-user turns in this page (Host turnCount). */
  readonly turnCount?: number
  /** Requested product turn limit for this page. */
  readonly requestedTurnLimit?: number
}

export type TranscriptHttpPageCommand = {
  readonly type: "http-page"
  readonly purpose: SessionMessagePagePurpose
  readonly page: TranscriptTransportPage
  /** Live revision captured when the HTTP request started. */
  readonly capturedLiveRevision?: number
  /** Current live revision at apply time (may have advanced via SSE). */
  readonly liveRevision?: number
  readonly skipPartTypes?: ReadonlySet<string>
  readonly optimistic?: readonly { message: Message; parts: Part[] }[]
}

export type TranscriptSseEventCommand = {
  readonly type: "sse-event"
  /**
   * Directory-scoped transcript events only:
   * message.updated | message.removed | message.part.updated |
   * message.part.removed | message.part.delta
   *
   * Non-transcript events are no-ops (return applied:false).
   */
  readonly event: Event
}

export type TranscriptOptimisticAddCommand = {
  readonly type: "optimistic-add"
  readonly message: Message
  readonly parts: readonly Part[]
}

export type TranscriptOptimisticConfirmCommand = {
  readonly type: "optimistic-confirm"
  readonly messageID: string
}

export type TranscriptOptimisticRemoveCommand = {
  readonly type: "optimistic-remove"
  readonly messageID: string
}

/**
 * Reset the session transcript to a fresh tail page (or empty).
 * Clears only transcript fields for the session (messages, associated parts,
 * history boundary). Non-transcript domains — session status, todo, permission,
 * question, session_diff — must remain untouched. Optionally applies the
 * provided page as an initial tail after the clear.
 */
export type TranscriptResetCommand = {
  readonly type: "reset"
  readonly page?: TranscriptTransportPage
  readonly capturedLiveRevision?: number
  readonly liveRevision?: number
  readonly skipPartTypes?: ReadonlySet<string>
}

/**
 * Materialize authoritative message/part snapshots without boundary mutation.
 * Covers send confirmation, edit refetch, and other non-paginated merges.
 */
export type TranscriptMaterializeSnapshotsCommand = {
  readonly type: "materialize-snapshots"
  readonly records: readonly {
    readonly info: Message
    readonly parts?: readonly Part[]
  }[]
  readonly merge?: SessionMergeStrategy
  readonly skipPartTypes?: ReadonlySet<string>
}

/** Remove one message and its parts from the session transcript. */
export type TranscriptRemoveMessageCommand = {
  readonly type: "remove-message"
  readonly messageID: string
}

export type TranscriptCommand =
  | TranscriptHttpPageCommand
  | TranscriptSseEventCommand
  | TranscriptOptimisticAddCommand
  | TranscriptOptimisticConfirmCommand
  | TranscriptOptimisticRemoveCommand
  | TranscriptResetCommand
  | TranscriptMaterializeSnapshotsCommand
  | TranscriptRemoveMessageCommand

export type TranscriptMaterializationHint = {
  readonly type: "incomplete-session-snapshot"
  readonly reason: SessionMaterializationReason
  readonly sessionID?: string
  readonly messageID: string
  readonly partID?: string
}

export type TranscriptCommandResult = {
  readonly applied: boolean
  readonly changed: boolean
  /** Present when an HTTP page command committed a boundary. */
  readonly boundary?: SessionHistoryBoundary
  /** Legacy meta projection for callers still on SessionMessagePageMeta. */
  readonly meta?: SessionMessagePageMeta
  readonly confirmedOptimisticIDs?: readonly string[]
  /** SSE incomplete-snapshot hint for materialization enqueue. */
  readonly materialization?: TranscriptMaterializationHint
  readonly error?: string
}

// ---------------------------------------------------------------------------
// Subscription
// ---------------------------------------------------------------------------

export type TranscriptChangeListener = (scope: TranscriptScope) => void

// ---------------------------------------------------------------------------
// Repository contract
// ---------------------------------------------------------------------------

/**
 * Unified transcript model interface.
 *
 * Implementations must:
 * 1. Keep messageOrder chronological and parts keyed by message ID.
 * 2. Derive pagination solely from the session history boundary.
 * 3. Preserve prior pages/messages on HTTP failure (error is not empty success).
 * 4. Apply optimistic messages by server-accepted message ID (in-place confirm).
 * 5. Notify listeners only when transcript data or pagination for a scope changes.
 */
export type TranscriptRepository = {
  /** Snapshot of flat transcript data for a scope. */
  getTranscript(scope: TranscriptScope): TranscriptData

  /** Snapshot of pagination projection for a scope. */
  getPagination(scope: TranscriptScope): TranscriptPagination

  /** Snapshot of request lifecycle for a scope (optional; defaults to idle). */
  getRequestState?(scope: TranscriptScope): TranscriptRequestState

  /**
   * Read-only hydration phase. UI never advances this; HTTP / prepend /
   * per-message materialize do. Once `p0Satisfied` latches, a later empty
   * read must not drop it back to skeleton.
   */
  getHydrationState?(scope: TranscriptScope): TranscriptHydrationState

  /** Message by ID within a scope; undefined when absent. */
  getMessage(scope: TranscriptScope, messageID: string): Message | undefined

  /** Parts for a message within a scope; empty array when absent. */
  getParts(scope: TranscriptScope, messageID: string): readonly Part[]

  /**
   * Whether the session has an established transcript entry in the model.
   * True for an empty loaded array (key present) as well as non-empty data.
   * False when the session has never been loaded (unknown, no key).
   */
  hasSession?(scope: TranscriptScope): boolean

  /**
   * Fetch the exact Host snapshot for one message and merge it through
   * `materialize-snapshots`. Query production implements this; store tests
   * may omit it. Concurrent calls for the same identity share one flight.
   */
  materializeMessage?(scope: TranscriptScope, messageID: string): Promise<TranscriptData>

  /** Read-only exact-message fill status. Defaults to idle when unimplemented. */
  getMessageMaterializationState?(
    scope: TranscriptScope,
    messageID: string,
  ): TranscriptMessageMaterializationState

  /**
   * Apply a transcript command. Store adapter maps to existing reducer /
   * event-reducer / optimistic paths. Query adapter (Ticket 04) will map to
   * setQueryData / structuralSharing merge.
   */
  apply(scope: TranscriptScope, command: TranscriptCommand): TranscriptCommandResult

  /**
   * Subscribe to transcript/pagination changes for a scope.
   * Returns an unsubscribe function. Listener identity is not stable across
   * implementations; callers must not rely on it for effect deps.
   */
  subscribe(scope: TranscriptScope, listener: TranscriptChangeListener): () => void
}

// ---------------------------------------------------------------------------
// Pure projection helpers (shared by adapters and tests)
// ---------------------------------------------------------------------------

export function projectPagination(
  sessionID: string,
  boundary: SessionHistoryBoundary,
): TranscriptPagination {
  if (boundary.kind === "has-more") {
    return {
      sessionID,
      boundary,
      hasPreviousPage: true,
      isComplete: false,
      cursor: boundary.cursor,
      loadedTurns: boundary.loadedTurns,
    }
  }
  if (boundary.kind === "exhausted") {
    return {
      sessionID,
      boundary,
      hasPreviousPage: false,
      isComplete: true,
      cursor: null,
      loadedTurns: boundary.loadedTurns,
    }
  }
  return {
    sessionID,
    boundary,
    hasPreviousPage: false,
    isComplete: false,
    cursor: null,
    loadedTurns: boundary.loadedTurns,
  }
}

export function projectTranscriptData(input: {
  sessionID: string
  messages: readonly Message[]
  parts: Readonly<Record<string, readonly Part[] | undefined>>
  boundary: SessionHistoryBoundary
  liveRevision?: number
}): TranscriptData {
  const messagesByID: Record<string, Message> = {}
  const partsByMessageID: Record<string, readonly Part[]> = {}
  const messageOrder: string[] = []

  for (const message of input.messages) {
    if (!message?.id) continue
    messageOrder.push(message.id)
    messagesByID[message.id] = message
    const parts = input.parts[message.id]
    if (parts) partsByMessageID[message.id] = parts
  }

  return {
    sessionID: input.sessionID,
    messageOrder,
    messagesByID,
    partsByMessageID,
    boundary: input.boundary,
    liveRevision: input.liveRevision ?? 0,
  }
}

/** Transcript-domain event types the repository SSE command accepts. */
export const TRANSCRIPT_SSE_EVENT_TYPES = [
  "message.updated",
  "message.removed",
  "message.part.updated",
  "message.part.removed",
  "message.part.delta",
] as const

export type TranscriptSseEventType = (typeof TRANSCRIPT_SSE_EVENT_TYPES)[number]

export function isTranscriptSseEventType(type: string): type is TranscriptSseEventType {
  return (TRANSCRIPT_SSE_EVENT_TYPES as readonly string[]).includes(type)
}
