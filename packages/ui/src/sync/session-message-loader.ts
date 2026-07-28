/**
 * App-wide session message page loader.
 *
 * Transport layer: single-flight HTTP coordinator so imperative selection and
 * reactive sync share the exact in-flight page promise.
 *
 * Application layer: `loadSessionMessagePage` with `purpose` orchestrates
 * policy → query → (assistant-tail recovery) → reducer → store commit, and
 * tracks loading / ready / error via the prefetch cache.
 */

import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import {
  beginSessionMessageLoad,
  failSessionMessageLoad,
  setSessionPrefetch,
} from "./session-prefetch-cache"
import {
  getInitialSessionMessageLimit,
  getSessionHistoryMessageLimit,
  getSessionMaterializationMessageLimit,
  getSessionRecoveryMessageLimit,
} from "./session-message-policy"
import {
  reduceSessionMessagePage,
  type ReduceSessionMessagePageResult,
  type SessionMessagePageMode,
  type SessionMessagePageMeta,
  type SessionMessageReducerState,
} from "./session-message-reducer"
import type { OptimisticItem } from "./optimistic"

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

export function findMissingAssistantParentUserIDs(records: SessionMessageRecord[]): string[] {
  if (records.some((record) => isRole(record, "user"))) return []
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
  const initialBoundaryFound = input.records.some((record) => isRole(record, "user"))
  if (initialBoundaryFound || input.complete) {
    return { records: input.records, boundaryFound: initialBoundaryFound, partial: false }
  }

  const parentIDs = findMissingAssistantParentUserIDs(input.records)
  if (parentIDs.length === 0) {
    return { records: input.records, boundaryFound: false, partial: true }
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

export type SessionMessageLoadPurpose = SessionMessagePageMode

export type SessionMessageQueryRecord = {
  info: Message
  parts?: Part[]
}

export type SessionMessageQueryPage = {
  records: SessionMessageQueryRecord[]
  cursor?: string
  complete: boolean
}

export type LoadSessionMessagePageDeps = {
  /** HTTP page fetch (limit / before already resolved). */
  queryPage: (input: { limit: number; before?: string }) => Promise<SessionMessageQueryPage>
  /** Exact message fetch for assistant-only tail parent recovery. */
  queryMessage?: (input: { messageID: string }) => Promise<SessionMessageQueryRecord>
  getStoreState: () => SessionMessageReducerState
  /**
   * Atomic commit of reducer output into the owning directory store.
   * Callers may also apply meta / clear optimistic from `result.commands`.
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
  purpose: SessionMessageLoadPurpose
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
  messages: Message[]
  error?: string
  reduced?: ReduceSessionMessagePageResult
}

export function resolveSessionMessagePageLimit(purpose: SessionMessageLoadPurpose): number {
  switch (purpose) {
    case "prepend":
      return getSessionHistoryMessageLimit()
    case "recovery":
      return getSessionRecoveryMessageLimit()
    case "materialize":
      return getSessionMaterializationMessageLimit()
    case "initial":
    default:
      return getInitialSessionMessageLimit()
  }
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

  beginSessionMessageLoad(directory, sessionID, limit, runtimeKey)
  deps.onLoading?.()

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

    if (deps.isStale?.() && purpose !== "recovery") {
      setSessionPrefetch({
        directory,
        sessionID,
        runtimeKey,
        limit: page.records.length,
        cursor: page.cursor,
        complete: page.complete,
      })
      return {
        status: "skipped",
        applied: false,
        changed: false,
        messages: emptyMessages(),
        meta: deps.getStoreState().meta,
      }
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

    if (deps.isStale?.() && purpose !== "recovery") {
      setSessionPrefetch({
        directory,
        sessionID,
        runtimeKey,
        limit: records.length,
        cursor: page.cursor,
        complete: page.complete,
      })
      return {
        status: "skipped",
        applied: false,
        changed: false,
        messages: emptyMessages(),
        meta: deps.getStoreState().meta,
      }
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
      },
      {
        mode: purpose,
        skipPartTypes: deps.skipPartTypes,
        optimistic: deps.getOptimistic?.() ?? [],
        capturedRevision,
        liveRevision,
      },
    )

    if (!reduced.applied) {
      // Live revision won or reducer declined apply — preserve transcript.
      setSessionPrefetch({
        directory,
        sessionID,
        runtimeKey,
        limit: state.meta?.limit ?? records.length,
        cursor: state.meta?.cursor ?? page.cursor,
        complete: state.meta?.complete ?? page.complete,
      })
      return {
        status: "skipped",
        applied: false,
        changed: false,
        messages: reduced.messages,
        meta: reduced.meta,
        reduced,
      }
    }

    deps.commitStore(reduced)

    const meta = reduced.meta
    setSessionPrefetch({
      directory,
      sessionID,
      runtimeKey,
      limit: meta?.limit ?? reduced.messages.length,
      cursor: meta?.cursor,
      complete: meta?.complete ?? page.complete,
    })
    deps.onReady?.(meta)

    return {
      status: "ready",
      applied: true,
      changed: reduced.changed,
      messages: reduced.messages,
      meta,
      reduced,
    }
  } catch (error) {
    const message = formatLoadError(error)
    failSessionMessageLoad(directory, sessionID, message, runtimeKey)
    deps.onError?.(message)
    return {
      status: "error",
      applied: false,
      changed: false,
      messages: emptyMessages(),
      meta: deps.getStoreState().meta,
      error: message,
    }
  }
}
