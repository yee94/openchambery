import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import {
  materializeSessionSnapshots,
  type MaterializedMessageRecord,
  type MaterializedState,
} from "./materialization"
import { mergeOptimisticPage, type OptimisticItem } from "./optimistic"

/**
 * Pure reducer: HTTP session-message page → store message/part state.
 *
 * Modes:
 * - initial: first load / replace (merge materialization)
 * - prepend: older history pagination (skip existing parts)
 * - recovery: reconnect; keep local history outside the fetched tail
 * - materialize: repair orphan/missing parts for existing messages
 *
 * No SDK / Query / store side effects. Callers apply `message`/`part` and
 * execute returned `commands` (e.g. clear optimistic shadow entries).
 */

export type SessionMessagePageMode = "initial" | "prepend" | "recovery" | "materialize"

export type SessionMessagePageMeta = {
  limit: number
  cursor: string | undefined
  complete: boolean
}

export type SessionMessageReducerState = MaterializedState & {
  meta?: SessionMessagePageMeta
}

export type SessionMessagePageSuccess = {
  ok: true
  records: MaterializedMessageRecord[]
  cursor?: string
  complete: boolean
}

export type SessionMessagePageError = {
  ok: false
  error: string
}

export type SessionMessagePageInput = SessionMessagePageSuccess | SessionMessagePageError

export type SessionMessageReducerCommand =
  | { type: "clear-optimistic"; messageIDs: string[] }

export type ReduceSessionMessagePageOptions = {
  mode: SessionMessagePageMode
  skipPartTypes?: ReadonlySet<string>
  optimistic?: OptimisticItem[]
  /** HTTP request captured live revision; when set with liveRevision, stale pages are dropped. */
  capturedRevision?: number
  /** Current live revision after SSE may have advanced while HTTP was in flight. */
  liveRevision?: number
}

export type ReduceSessionMessagePageResult = {
  applied: boolean
  changed: boolean
  messagesChanged: boolean
  partsChanged: boolean
  message: Record<string, Message[]>
  part: Record<string, Part[]>
  messages: Message[]
  meta: SessionMessagePageMeta | undefined
  confirmedOptimisticIDs: string[]
  commands: SessionMessageReducerCommand[]
  error?: string
}

function materializeMode(
  mode: SessionMessagePageMode,
): "merge" | "prepend" | "recovery" {
  if (mode === "prepend") return "prepend"
  if (mode === "recovery") return "recovery"
  // initial + materialize both use merge semantics for snapshots
  return "merge"
}

function isLiveRevisionStale(
  capturedRevision: number | undefined,
  liveRevision: number | undefined,
): boolean {
  if (capturedRevision === undefined || liveRevision === undefined) return false
  return liveRevision > capturedRevision
}

function metaFromPage(
  messages: Message[],
  page: SessionMessagePageSuccess,
): SessionMessagePageMeta {
  return {
    limit: messages.length,
    cursor: page.cursor,
    complete: page.complete,
  }
}

function metaUnchanged(
  previous: SessionMessagePageMeta | undefined,
  next: SessionMessagePageMeta,
): boolean {
  if (!previous) return false
  return (
    previous.limit === next.limit
    && previous.cursor === next.cursor
    && previous.complete === next.complete
  )
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
  if (!page.ok) {
    return {
      applied: false,
      changed: false,
      messagesChanged: false,
      partsChanged: false,
      message: state.message,
      part: state.part,
      messages: state.message[sessionID] ?? [],
      meta: state.meta,
      confirmedOptimisticIDs: [],
      commands: [],
      error: page.error,
    }
  }

  if (isLiveRevisionStale(options.capturedRevision, options.liveRevision)) {
    return {
      applied: false,
      changed: false,
      messagesChanged: false,
      partsChanged: false,
      message: state.message,
      part: state.part,
      messages: state.message[sessionID] ?? [],
      meta: state.meta,
      confirmedOptimisticIDs: [],
      commands: [],
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
      mode: materializeMode(options.mode),
    },
  )

  const nextMeta = metaFromPage(materialized.messages, {
    ok: true,
    records: page.records,
    cursor: merged.cursor,
    complete: merged.complete,
  })
  const metaChanged = !metaUnchanged(state.meta, nextMeta)
  const messagesChanged = materialized.messagesChanged
  const partsChanged = materialized.partsChanged
  const changed = messagesChanged || partsChanged || metaChanged

  const commands: SessionMessageReducerCommand[] = []
  if (merged.confirmed.length > 0) {
    commands.push({ type: "clear-optimistic", messageIDs: merged.confirmed })
  }

  return {
    applied: true,
    changed,
    messagesChanged,
    partsChanged,
    message: materialized.message,
    part: materialized.part,
    messages: materialized.messages,
    meta: metaChanged || !state.meta ? nextMeta : state.meta,
    confirmedOptimisticIDs: merged.confirmed,
    commands,
  }
}
