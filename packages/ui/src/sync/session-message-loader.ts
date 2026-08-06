/**
 * App-wide session message page loader.
 *
 * Transport layer: single-flight HTTP coordinator so imperative selection and
 * reactive sync share the exact in-flight page promise.
 *
 * Application layer: `loadSessionMessagePage` with `purpose` orchestrates
 * policy → query → (assistant-tail recovery) → reducer → store commit, and
 * tracks request lifecycle (loading / ready / error) via the prefetch cache.
 *
 * Boundary ownership: the reducer resolves the authoritative
 * `SessionHistoryBoundary` and the caller commits it into the directory child
 * store in the same setState as message/part. The prefetch cache entry only
 * carries request status + TTL coordination plus a transport copy of the
 * boundary so legacy readers keep working; it is never the read source for
 * pagination.
 */

import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import {
  beginSessionMessageLoad,
  failSessionMessageLoad,
  getSessionPrefetch,
  setSessionPrefetch,
} from "./session-prefetch-cache"
import {
  resolveSessionMessageTurnLimit,
} from "./session-message-policy"
import {
  reduceSessionMessagePage,
  type ReduceSessionMessagePageResult,
  type SessionMessagePageMeta,
  type SessionMessageReducerState,
} from "./session-message-reducer"
import type { OptimisticItem } from "./optimistic"
import {
  shouldDropStalePage,
  type SessionMessagePagePurpose,
} from "./session-merge-strategy"
import type { SessionHistoryBoundary } from "./types"

// ---------------------------------------------------------------------------
// Transport single-flight (legacy + internal)
// ---------------------------------------------------------------------------

type LoadSessionMessagePageTransportInput<T> = {
  runtimeKey: string
  directory: string
  sessionID: string
  limit: number
  before?: string
  request: () => Promise<T>
}

type LoadSessionMessageInput<T> = {
  runtimeKey: string
  directory: string
  sessionID: string
  messageID: string
  request: () => Promise<T>
}

export type SessionMessageRecord<TInfo extends { id: string; parentID?: string | null } = { id: string; parentID?: string | null }> = {
  info: TInfo
  parts?: unknown[]
}

export const MAX_ASSISTANT_TAIL_PARENT_LOADS = 8

const inflight = new Map<string, Promise<unknown>>()

const pageKey = (input: Pick<LoadSessionMessagePageTransportInput<unknown>, "runtimeKey" | "directory" | "sessionID" | "limit" | "before">) =>
  `page\n${input.runtimeKey}\n${input.directory}\n${input.sessionID}\n${input.limit}\n${input.before ?? "tail"}`

const messageKey = (input: Pick<LoadSessionMessageInput<unknown>, "runtimeKey" | "directory" | "sessionID" | "messageID">) =>
  `message\n${input.runtimeKey}\n${input.directory}\n${input.sessionID}\n${input.messageID}`

function singleFlight<T>(key: string, request: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key)
  if (existing) return existing as Promise<T>

  const pending = request()
  inflight.set(key, pending)
  void pending.finally(() => {
    if (inflight.get(key) === pending) inflight.delete(key)
  }).catch(() => {})
  return pending
}

/**
 * Transport-only single-flight for session message pages.
 * Prefer the application `loadSessionMessagePage` when committing to a store.
 */
export function loadSessionMessagePageTransport<T>(input: LoadSessionMessagePageTransportInput<T>): Promise<T> {
  return singleFlight(pageKey(input), input.request)
}

/** Shares exact parent-message requests across imperative and reactive loads. */
export function loadSessionMessage<T>(input: LoadSessionMessageInput<T>): Promise<T> {
  return singleFlight(messageKey(input), input.request)
}

function isRole(record: SessionMessageRecord, role: string): boolean {
  const info = record.info as typeof record.info & { role?: unknown; clientRole?: unknown }
  return info.role === role || info.clientRole === role
}

/**
 * Collect parent user IDs referenced by assistant rows but absent from the page.
 *
 * A mixed tail is common: the newest user+assistant turn lands in the page while
 * older multi-step assistant rows still point at a parent that fell outside the
 * limit window. Turn grouping requires those parents, so recover them even when
 * the page already contains some other user message.
 */
export function findMissingAssistantParentUserIDs(records: SessionMessageRecord[]): string[] {
  const present = new Set(records.map((record) => record.info.id))
  const parentIDs: string[] = []
  const seen = new Set<string>()
  for (const record of records) {
    if (!isRole(record, "assistant")) continue
    const parentID = record.info.parentID
    if (!parentID || present.has(parentID) || seen.has(parentID)) continue
    seen.add(parentID)
    parentIDs.push(parentID)
    if (parentIDs.length === MAX_ASSISTANT_TAIL_PARENT_LOADS) break
  }
  return parentIDs
}

export async function recoverAssistantTailBoundary<T extends SessionMessageRecord>(input: {
  records: T[]
  complete: boolean
  requestMessage: (messageID: string) => Promise<T>
}): Promise<{ records: T[]; boundaryFound: boolean; partial: boolean }> {
  // Authoritative complete pages already contain every message; exact parent
  // fetches would only chase deleted/missing IDs. Incomplete tails may still
  // omit parents of assistant steps that sit above a newer user turn.
  if (input.complete) {
    const boundaryFound = input.records.some((record) => isRole(record, "user"))
    return { records: input.records, boundaryFound, partial: false }
  }

  const parentIDs = findMissingAssistantParentUserIDs(input.records)
  if (parentIDs.length === 0) {
    const boundaryFound = input.records.some((record) => isRole(record, "user"))
    return { records: input.records, boundaryFound, partial: !boundaryFound }
  }

  const parents = await Promise.all(parentIDs.map(input.requestMessage))
  const byID = new Map<string, T>()
  for (const record of [...input.records, ...parents]) byID.set(record.info.id, record)
  const records = [...byID.values()].sort((a, b) => a.info.id.localeCompare(b.info.id))
  const boundaryFound = records.some((record) => isRole(record, "user"))
  return { records, boundaryFound, partial: !boundaryFound }
}

// ---------------------------------------------------------------------------
// Application orchestration: policy → query → reducer → commit
// ---------------------------------------------------------------------------

export type SessionMessageQueryRecord = {
  info: Message
  parts?: Part[]
}

export type SessionMessageQueryPage = {
  records: SessionMessageQueryRecord[]
  cursor?: string
  complete: boolean
  /** Authored-user turns in this page (Host turnCount). */
  turnCount?: number
}

export type LoadSessionMessagePageDeps = {
  /**
   * HTTP page fetch. `limit` is the product **turn** budget for this request
   * (not a message count). Host turn-page uses it as `turns=`.
   */
  queryPage: (input: { limit: number; before?: string }) => Promise<SessionMessageQueryPage>
  /** Exact message fetch for assistant-only tail parent recovery. */
  queryMessage?: (input: { messageID: string }) => Promise<SessionMessageQueryRecord>
  getStoreState: () => SessionMessageReducerState
  /**
   * Atomic commit of reducer output into the owning directory store.
   * Must apply `result.boundary` (session_history_boundary) in the same
   * setState as message/part — even when messages are unchanged. Callers may
   * also clear optimistic from `result.commands`.
   */
  commitStore: (result: ReduceSessionMessagePageResult) => void
  getOptimistic?: () => OptimisticItem[]
  getLiveRevision?: () => number | undefined
  isStale?: () => boolean
  skipPartTypes?: ReadonlySet<string>
  onLoading?: () => void
  onReady?: (meta: SessionMessagePageMeta | undefined) => void
  onError?: (error: string) => void
}

export type LoadSessionMessagePageAppInput = {
  purpose: SessionMessagePagePurpose
  runtimeKey: string
  directory: string
  sessionID: string
  /** Override policy limit when a caller needs a specific window. */
  limit?: number
  before?: string
  deps: LoadSessionMessagePageDeps
}

export type LoadSessionMessagePageResult = {
  status: "ready" | "error" | "skipped"
  applied: boolean
  changed: boolean
  meta?: SessionMessagePageMeta
  /** Boundary the caller must commit (present on applied pages). */
  boundary?: SessionHistoryBoundary
  messages: Message[]
  /** Records the server page contributed, after assistant-tail parent recovery. */
  recordCount: number
  error?: string
  reduced?: ReduceSessionMessagePageResult
}

/**
 * Product turn limit for a load purpose (authored-user turns, not messages).
 */
export function resolveSessionMessagePageLimit(purpose: SessionMessagePagePurpose): number {
  return resolveSessionMessageTurnLimit(purpose)
}

function formatLoadError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === "string" && error) return error
  return "session message load failed"
}

function isTransportInput<T>(
  input: LoadSessionMessagePageAppInput | LoadSessionMessagePageTransportInput<T>,
): input is LoadSessionMessagePageTransportInput<T> {
  return typeof (input as LoadSessionMessagePageTransportInput<T>).request === "function"
    && !("purpose" in input && (input as LoadSessionMessagePageAppInput).purpose)
}

function boundaryToMeta(boundary: SessionHistoryBoundary | undefined, fallbackLimit: number): SessionMessagePageMeta {
  if (!boundary) return { limit: fallbackLimit, cursor: undefined, complete: false }
  return {
    limit: boundary.loadedTurns,
    cursor: boundary.kind === "has-more" ? boundary.cursor : undefined,
    complete: boundary.kind === "exhausted",
  }
}

/**
 * Application entry: policy → single-flight query → optional tail recovery →
 * pure reducer → independent store commit (per caller deps).
 *
 * Transport overload (legacy): when `request` is provided without `purpose`,
 * behaves as single-flight only so existing call sites keep working.
 */
export function loadSessionMessagePage<T>(
  input: LoadSessionMessagePageTransportInput<T>,
): Promise<T>
export function loadSessionMessagePage(
  input: LoadSessionMessagePageAppInput,
): Promise<LoadSessionMessagePageResult>
export function loadSessionMessagePage<T>(
  input: LoadSessionMessagePageAppInput | LoadSessionMessagePageTransportInput<T>,
): Promise<T | LoadSessionMessagePageResult> {
  if (isTransportInput(input)) {
    return loadSessionMessagePageTransport(input)
  }
  return loadSessionMessagePageApp(input)
}

async function loadSessionMessagePageApp(
  input: LoadSessionMessagePageAppInput,
): Promise<LoadSessionMessagePageResult> {
  const { purpose, runtimeKey, directory, sessionID, before, deps } = input
  const limit = input.limit ?? resolveSessionMessagePageLimit(purpose)
  const emptyMessages = (): Message[] => deps.getStoreState().message[sessionID] ?? []
  const currentBoundary = (): SessionHistoryBoundary | undefined =>
    deps.getStoreState().session_history_boundary?.[sessionID]

  // A page whose strategy backfills (reconnect recovery) stays useful after live
  // events land: it is the only source for messages the SSE gap swallowed. The
  // reducer then downgrades it to insert-only so live content keeps precedence.
  const dropWhenStale = shouldDropStalePage(purpose)
  const lostRaceToLiveState = () => dropWhenStale && Boolean(deps.isStale?.())

  // Generation gate: a newer load for the same scope supersedes this one.
  // A stale completion must not commit messages or a boundary over the newer
  // load's result — the same gate the prefetch cache uses for settle/fail.
  // A missing entry (cleared while this load was in flight) means the scope
  // was reset underneath us; that is not a newer generation.
  const loadGenerationIsCurrent = () => {
    const current = getSessionPrefetch(directory, sessionID, runtimeKey)
    if (!current) return true
    return current.loadGeneration === loadGeneration
  }

  // Generation gate: a newer load for the same scope supersedes this one.
  // Completions that share one single-flight transport response (provider
  // remount, imperative + reactive pull) belong to the same generation —
  // only a genuinely newer page request (different transport key, begun
  // after this one) invalidates this completion.
  const transportKey = pageKey({ runtimeKey, directory, sessionID, limit, before })
  const priorPrefetch = getSessionPrefetch(directory, sessionID, runtimeKey)
  const sharesInflightPage = priorPrefetch?.status === "loading" && inflight.has(transportKey)
  const loadGeneration = sharesInflightPage
    ? priorPrefetch.loadGeneration
    : beginSessionMessageLoad(directory, sessionID, limit, runtimeKey)
  deps.onLoading?.()

  // Settle request lifecycle only — the generation-gated ready write happens
  // AFTER the store commit below, and never carries pagination facts.
  const settleRequestReady = () => {
    setSessionPrefetch({
      directory,
      sessionID,
      runtimeKey,
      requestedLimit: limit,
      loadGeneration,
    })
  }

  const skipStalePage = (page: {
    recordCount: number
    turnLimit: number
  }): LoadSessionMessagePageResult => {
    settleRequestReady()
    return {
      status: "skipped",
      applied: false,
      changed: false,
      messages: emptyMessages(),
      recordCount: page.recordCount,
      meta: boundaryToMeta(currentBoundary(), page.turnLimit),
      boundary: currentBoundary(),
    }
  }

  let capturedRevision: number | undefined
  try {
    capturedRevision = deps.getLiveRevision?.()

    const page = await loadSessionMessagePageTransport({
      runtimeKey,
      directory,
      sessionID,
      limit,
      before,
      request: () => deps.queryPage({ limit, before }),
    })

    const pageTurnCount = typeof page.turnCount === "number" ? page.turnCount : limit

    if (lostRaceToLiveState()) {
      return skipStalePage({
        recordCount: page.records.length,
        turnLimit: pageTurnCount,
      })
    }

    let records = page.records.map((record) => ({
      info: record.info,
      parts: record.parts ?? [],
    }))

    // History pagination already has a user boundary in earlier pages; only
    // recover parents on incomplete tail fetches (initial / recovery / materialize).
    if (!before && !page.complete && deps.queryMessage) {
      const recovered = await recoverAssistantTailBoundary({
        records,
        complete: page.complete,
        requestMessage: async (messageID) => {
          const record = await loadSessionMessage({
            runtimeKey,
            directory,
            sessionID,
            messageID,
            request: () => deps.queryMessage!({ messageID }),
          })
          return {
            info: record.info,
            parts: record.parts ?? [],
          }
        },
      })
      records = recovered.records
    }

    if (lostRaceToLiveState()) {
      return skipStalePage({
        recordCount: records.length,
        turnLimit: pageTurnCount,
      })
    }

    const liveRevision = deps.getLiveRevision?.()
    const state = deps.getStoreState()
    const reduced = reduceSessionMessagePage(
      state,
      sessionID,
      {
        ok: true,
        records,
        cursor: page.cursor,
        complete: page.complete,
        turnCount: pageTurnCount,
        requestedTurnLimit: limit,
      },
      {
        purpose,
        skipPartTypes: deps.skipPartTypes,
        optimistic: deps.getOptimistic?.() ?? [],
        capturedRevision,
        liveRevision,
      },
    )

    if (!loadGenerationIsCurrent()) {
      // A newer load owns this scope now. Drop the whole completion — messages
      // and boundary — so an older response cannot overwrite newer state. Do
      // not settle prefetch either (that write is generation-gated anyway).
      return {
        status: "skipped",
        applied: false,
        changed: false,
        messages: emptyMessages(),
        recordCount: records.length,
        meta: boundaryToMeta(currentBoundary(), pageTurnCount),
        boundary: currentBoundary(),
      }
    }

    if (!reduced.applied) {
      if (reduced.error) {
        // Page contract violation (e.g. complete=false without a usable
        // cursor): treat the page like a failed load — preserve the last known
        // boundary and flip request status to error through the normal path.
        throw new Error(reduced.error)
      }
      // Live revision won or reducer declined apply — preserve transcript and
      // the last known boundary; the page's own boundary is dropped with it.
      settleRequestReady()
      return {
        status: "skipped",
        applied: false,
        changed: false,
        messages: reduced.messages,
        recordCount: records.length,
        meta: reduced.meta ?? boundaryToMeta(currentBoundary(), pageTurnCount),
        boundary: currentBoundary(),
        reduced,
      }
    }

    // commitStore must apply message/part/boundary atomically (single setState),
    // even when only the boundary changed. The generation-gated request-ready
    // settle happens strictly after the store commit.
    deps.commitStore(reduced)

    const boundary = reduced.boundary
    settleRequestReady()
    deps.onReady?.(reduced.meta)

    return {
      status: "ready",
      applied: true,
      changed: reduced.changed,
      messages: reduced.messages,
      recordCount: records.length,
      meta: reduced.meta,
      boundary,
      reduced,
    }
  } catch (error) {
    const message = formatLoadError(error)
    // Failure keeps the last known boundary untouched; only the request
    // lifecycle flips to error. A caller-declared stale completion (session
    // switched away mid-flight) must not paint error over a newer in-flight
    // or ready load for the same scope, so it leaves the entry untouched.
    if (!deps.isStale?.()) {
      failSessionMessageLoad(directory, sessionID, message, runtimeKey, loadGeneration)
    }
    deps.onError?.(message)
    return {
      status: "error",
      applied: false,
      changed: false,
      messages: emptyMessages(),
      recordCount: 0,
      meta: boundaryToMeta(currentBoundary(), limit),
      boundary: currentBoundary(),
      error: message,
    }
  }
}
