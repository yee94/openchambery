import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import {
  materializeSessionSnapshots,
  type MaterializedMessageRecord,
  type MaterializedState,
} from "./materialization"
import { mergeOptimisticPage, type OptimisticItem } from "./optimistic"
import {
  resolveSessionMergeStrategy,
  type SessionMergeStrategy,
  type SessionMessagePagePurpose,
} from "./session-merge-strategy"
import type { SessionHistoryBoundary } from "./types"
import { UNKNOWN_SESSION_HISTORY_BOUNDARY } from "./types"

/**
 * Pure reducer: HTTP session-message page → message/part materialization state.
 *
 * The reducer does not decide how the page combines with existing state; it
 * resolves one `SessionMergeStrategy` from `(purpose, staleness)` and hands that to
 * materialization. See `session-merge-strategy.ts` for the resolution table.
 *
 * No SDK / Query / store side effects. Production Query path uses
 * `transcript-merge` / Query adapters; this pure surface remains for the store
 * test adapter and residual pure callers that apply `message`/`part` and
 * execute returned `commands` (e.g. clear optimistic shadow entries).
 */

/**
 * Pagination meta for a session transcript.
 * `limit` is the cumulative **authored-user turn** budget loaded so far
 * (product limit), not a message count.
 *
 * @deprecated Pure reducer compatibility shape for tests and model helpers.
 * Production pagination reads the Query-backed repository projection through
 * `useSessionTranscriptPagination` or `TranscriptRepository.getPagination`.
 */
export type SessionMessagePageMeta = {
  /** Cumulative authored-user turns loaded (initial + prepends). */
  limit: number
  cursor: string | undefined
  complete: boolean
}

export type SessionMessageReducerState = MaterializedState & {
  /** Test/model boundary map consumed by this pure reducer. */
  session_history_boundary?: Record<string, SessionHistoryBoundary>
}

export type SessionMessagePageSuccess = {
  ok: true
  records: MaterializedMessageRecord[]
  cursor?: string
  complete: boolean
  /**
   * Authored-user turns in this page (Host turnCount). When omitted (legacy SDK
   * fallback pages), meta.limit falls back to the request turn budget.
   */
  turnCount?: number
  /** Requested product turn limit for this page (for meta accumulation). */
  requestedTurnLimit?: number
}

export type SessionMessagePageError = {
  ok: false
  error: string
}

export type SessionMessagePageInput = SessionMessagePageSuccess | SessionMessagePageError

export type SessionMessageReducerCommand =
  | { type: "clear-optimistic"; messageIDs: string[] }

export type ReduceSessionMessagePageOptions = {
  purpose: SessionMessagePagePurpose
  skipPartTypes?: ReadonlySet<string>
  optimistic?: OptimisticItem[]
  /** HTTP request captured live revision; when set with liveRevision, stale pages are dropped. */
  capturedRevision?: number
  /** Current live revision after SSE may have advanced while HTTP was in flight. */
  liveRevision?: number
}

export type ReduceSessionMessagePageResult = {
  applied: boolean
  /** Strategy the page was reduced under. Diagnostic; callers need not branch. */
  merge: SessionMergeStrategy
  changed: boolean
  messagesChanged: boolean
  partsChanged: boolean
  /** True when the boundary must be (re)committed even if messages are unchanged. */
  boundaryChanged: boolean
  message: Record<string, Message[]>
  part: Record<string, Part[]>
  messages: Message[]
  /**
   * Boundary to commit for this session. Always present on applied success
   * pages; equals the previous boundary when unchanged. Absent on dropped /
   * failed pages.
   */
  boundary: SessionHistoryBoundary | undefined
  meta: SessionMessagePageMeta | undefined
  confirmedOptimisticIDs: string[]
  commands: SessionMessageReducerCommand[]
  error?: string
}

function isLiveRevisionStale(
  capturedRevision: number | undefined,
  liveRevision: number | undefined,
): boolean {
  if (capturedRevision === undefined || liveRevision === undefined) return false
  return liveRevision > capturedRevision
}

/** Page contract violation — an incomplete page must carry a usable cursor. */
class SessionMessagePageContractError extends Error {}

/**
 * Build the next history boundary. Product turns are cumulative:
 * - tail/initial: page turnCount (or requestedTurnLimit)
 * - prepend: previous cumulative turns + this page's turns
 *
 * Boundary kind enforces the strict page contract: `complete=true` yields
 * `exhausted` (no cursor exists); `complete=false` requires a non-empty cursor
 * and yields `has-more`. A missing or empty cursor on an incomplete page is a
 * page contract error — it must never silently widen into `has-more` with an
 * empty cursor. Callers treat the error like a failed page: the previous known
 * boundary is preserved and the loader error path records request status.
 */
function boundaryFromPage(
  previous: SessionHistoryBoundary | undefined,
  page: SessionMessagePageSuccess,
  purpose: SessionMessagePagePurpose,
): SessionHistoryBoundary {
  // Reconcile Host pages never own older-history pagination. `complete` ends a
  // compensation round only — preserve the existing cursor chain as-is.
  if (purpose === "reconcile-page") {
    return previous ?? UNKNOWN_SESSION_HISTORY_BOUNDARY
  }

  let pageTurns = 0
  if (typeof page.turnCount === "number" && Number.isFinite(page.turnCount)) {
    pageTurns = Math.max(0, Math.floor(page.turnCount))
  } else if (typeof page.requestedTurnLimit === "number" && Number.isFinite(page.requestedTurnLimit)) {
    pageTurns = Math.max(0, Math.floor(page.requestedTurnLimit))
  } else if (page.records.length > 0) {
    // Legacy / SDK fallback pages without Host turnCount: one turn window.
    pageTurns = 1
  }
  const previousTurns = previous?.loadedTurns ?? 0
  const loadedTurns = purpose === "prepend"
    ? previousTurns + pageTurns
    : pageTurns

  if (page.complete) {
    return { kind: "exhausted", loadedTurns }
  }
  const cursor = typeof page.cursor === "string" && page.cursor.length > 0 ? page.cursor : undefined
  if (!cursor) {
    throw new SessionMessagePageContractError(
      "session message page: complete=false requires non-empty cursor",
    )
  }
  // Cursor progress invariant: an incomplete page must advance the boundary.
  // An empty page (zero records, zero turns) makes no progress at all, and a
  // prepend that returns the same cursor it started from would paginate the
  // same window forever. Both are page contract errors: the caller preserves
  // the previous boundary/messages/loadedTurns and records request error.
  if (page.records.length === 0) {
    throw new SessionMessagePageContractError(
      "session message page: complete=false with zero records makes no progress",
    )
  }
  if (
    purpose === "prepend"
    && previous?.kind === "has-more"
    && previous.cursor === cursor
  ) {
    throw new SessionMessagePageContractError(
      "session message page: prepend returned the same cursor without progress",
    )
  }
  return { kind: "has-more", cursor, loadedTurns }
}

function boundariesEqual(
  a: SessionHistoryBoundary | undefined,
  b: SessionHistoryBoundary | undefined,
): boolean {
  if (!a || !b) return a === b
  if (a.kind !== b.kind) return false
  if (a.loadedTurns !== b.loadedTurns) return false
  if (a.kind === "has-more" && b.kind === "has-more") return a.cursor === b.cursor
  return true
}

/**
 * Reduce an HTTP message page into the next message/part state.
 * Unchanged maps keep their original references for Zustand selectors.
 */
export function reduceSessionMessagePage(
  state: SessionMessageReducerState,
  sessionID: string,
  page: SessionMessagePageInput,
  options: ReduceSessionMessagePageOptions,
): ReduceSessionMessagePageResult {
  const liveRevisionStale = isLiveRevisionStale(options.capturedRevision, options.liveRevision)
  const merge = resolveSessionMergeStrategy({ purpose: options.purpose, stale: liveRevisionStale })
  const previousBoundary = state.session_history_boundary?.[sessionID]

  if (!page.ok) {
    return {
      applied: false,
      merge,
      changed: false,
      messagesChanged: false,
      partsChanged: false,
      boundaryChanged: false,
      message: state.message,
      part: state.part,
      messages: state.message[sessionID] ?? [],
      boundary: undefined,
      meta: undefined,
      confirmedOptimisticIDs: [],
      commands: [],
      error: page.error,
    }
  }

  if (liveRevisionStale && merge.onStale === "drop") {
    const existing = state.message[sessionID] ?? []
    // Cold open has nothing to protect. Dropping the first tail leaves the
    // skeleton waiting for another GET after SSE already moved.
    if (existing.length > 0) {
      return {
        applied: false,
        merge,
        changed: false,
        messagesChanged: false,
        partsChanged: false,
        boundaryChanged: false,
        message: state.message,
        part: state.part,
        messages: existing,
        boundary: undefined,
        meta: undefined,
        confirmedOptimisticIDs: [],
        commands: [],
      }
    }
  }

  const optimistic = options.optimistic ?? []
  const pageForMerge = {
    session: page.records.map((record) => record.info),
    part: page.records.map((record) => ({
      id: record.info.id,
      part: record.parts ?? [],
    })),
    cursor: page.cursor,
    complete: page.complete,
  }

  const merged = mergeOptimisticPage(pageForMerge, optimistic)
  const records: MaterializedMessageRecord[] = merged.session.map((info) => ({
    info,
    parts: merged.part.find((item) => item.id === info.id)?.part ?? [],
  }))

  const materialized = materializeSessionSnapshots(
    state,
    sessionID,
    records,
    {
      skipPartTypes: options.skipPartTypes,
      merge,
      placeUnanchoredNewMessages:
        options.purpose === "prepend"
          ? "prepend"
          : options.purpose === "reconcile-page"
            ? "by-created"
            : "append",
    },
  )

  let nextBoundary: SessionHistoryBoundary
  try {
    nextBoundary = boundaryFromPage(previousBoundary, {
      ok: true,
      records: page.records,
      cursor: merged.cursor,
      complete: merged.complete,
      turnCount: page.turnCount,
      requestedTurnLimit: page.requestedTurnLimit,
    }, options.purpose)
  } catch (error) {
    if (!(error instanceof SessionMessagePageContractError)) throw error
    // Page contract violation: keep prior message/part state and the last
    // known boundary; the loader error path owns request status.
    return {
      applied: false,
      merge,
      changed: false,
      messagesChanged: false,
      partsChanged: false,
      boundaryChanged: false,
      message: state.message,
      part: state.part,
      messages: state.message[sessionID] ?? [],
      boundary: undefined,
      meta: undefined,
      confirmedOptimisticIDs: [],
      commands: [],
      error: error.message,
    }
  }
  const boundaryChanged = !boundariesEqual(previousBoundary, nextBoundary)
  const messagesChanged = materialized.messagesChanged
  const partsChanged = materialized.partsChanged
  const changed = messagesChanged || partsChanged || boundaryChanged

  const commands: SessionMessageReducerCommand[] = []
  if (merged.confirmed.length > 0) {
    commands.push({ type: "clear-optimistic", messageIDs: merged.confirmed })
  }

  const committedBoundary = boundaryChanged || !previousBoundary ? nextBoundary : previousBoundary

  return {
    applied: true,
    merge,
    changed,
    messagesChanged,
    partsChanged,
    boundaryChanged,
    message: materialized.message,
    part: materialized.part,
    messages: materialized.messages,
    boundary: committedBoundary,
    meta: {
      limit: committedBoundary.loadedTurns,
      cursor: committedBoundary.kind === "has-more" ? committedBoundary.cursor : undefined,
      complete: committedBoundary.kind === "exhausted",
    },
    confirmedOptimisticIDs: merged.confirmed,
    commands,
  }
}
