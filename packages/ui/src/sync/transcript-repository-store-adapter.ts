/**
 * Store-backed TranscriptRepository adapter (test / pure harness only).
 *
 * Bridges the unified TranscriptRepository contract to an in-memory
 * TranscriptStoreSurface (message / part / session_history_boundary) plus pure
 * reducers:
 * - HTTP pages → reduceSessionMessagePage → atomic store commit
 * - SSE events → applyTranscriptDirectoryEvent (transcript event types only)
 * - optimistic add/confirm/remove → append / clear shadow / remove
 * - reset → transcript-only clear (message/parts/boundary), optional initial page
 *
 * Production authority is QueryCache (`createQueryTranscriptRepository`).
 * This adapter is not bound in production SyncProvider.
 */

import type { Event, Message, Part } from "@opencode-ai/sdk/v2/client"

import { applyTranscriptDirectoryEvent } from "./transcript-event-reducer"
import { materializeSessionSnapshots } from "./materialization"
import {
  reduceSessionMessagePage,
  type ReduceSessionMessagePageResult,
  type SessionMessageReducerState,
} from "./session-message-reducer"
import type { SessionHistoryBoundary } from "./types"
import { UNKNOWN_SESSION_HISTORY_BOUNDARY } from "./types"
import {
  countTranscriptAuthoredUserTurns,
  evaluateTranscriptP0Satisfied,
  isTranscriptSseEventType,
  projectPagination,
  projectTranscriptData,
  resolveTranscriptHydrationPhase,
  type TranscriptCommand,
  type TranscriptCommandResult,
  type TranscriptChangeListener,
  type TranscriptHydrationState,
  type TranscriptRepository,
  type TranscriptRequestState,
  type TranscriptScope,
  type TranscriptTransportPage,
} from "./transcript-repository"

// ---------------------------------------------------------------------------
// Adapter store surface
// ---------------------------------------------------------------------------

/**
 * Minimal store surface the adapter needs.
 * Ticket 09 batch 2: pure transcript fields only — not production DirectoryStore State.
 */
export type TranscriptStoreSurface = {
  getState: () => SessionMessageReducerState
  setState: (
    partial:
      | Partial<SessionMessageReducerState>
      | ((state: SessionMessageReducerState) => Partial<SessionMessageReducerState>),
  ) => void
  subscribe: (
    listener: (
      state: SessionMessageReducerState,
      prev: SessionMessageReducerState,
    ) => void,
  ) => () => void
}

// ---------------------------------------------------------------------------
// Adapter deps
// ---------------------------------------------------------------------------

export type TranscriptStoreAdapterDeps = {
  /**
   * Resolve the directory child store for a scope.
   * Must return the same store identity while the directory is live.
   */
  getStore: (directory: string) => TranscriptStoreSurface

  /** Optional live revision reader (session-scoped). Defaults to 0. */
  getLiveRevision?: (directory: string, sessionID: string) => number

  /** Optional request-lifecycle reader (prefetch cache). */
  getRequestState?: (directory: string, sessionID: string) => TranscriptRequestState | undefined

  /**
   * Optional optimistic shadow clear. Called on optimistic-confirm and
   * optimistic-remove so production shadow maps stay aligned when wired.
   */
  clearOptimisticShadow?: (input: {
    directory: string
    sessionID: string
    messageID: string
  }) => void

  /**
   * Optional optimistic shadow set. Called on optimistic-add when wired.
   */
  setOptimisticShadow?: (input: {
    directory: string
    sessionID: string
    message: Message
    parts: readonly Part[]
  }) => void
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function normalizeDirectory(directory: string): string {
  return directory.trim()
}

function scopeKey(scope: TranscriptScope): string {
  return `${normalizeDirectory(scope.directory)}\n${scope.sessionID}`
}

function readBoundary(
  state: SessionMessageReducerState,
  sessionID: string,
): SessionHistoryBoundary {
  return state.session_history_boundary?.[sessionID] ?? UNKNOWN_SESSION_HISTORY_BOUNDARY
}

function sortParts(parts: readonly Part[]): Part[] {
  return parts
    .filter((part) => !!part?.id)
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

function boundariesEqual(
  a: SessionHistoryBoundary,
  b: SessionHistoryBoundary,
): boolean {
  if (a.kind !== b.kind) return false
  if (a.loadedTurns !== b.loadedTurns) return false
  if (a.kind === "has-more" && b.kind === "has-more") return a.cursor === b.cursor
  return true
}

function commitReducedPage(
  store: TranscriptStoreSurface,
  sessionID: string,
  reduced: ReduceSessionMessagePageResult,
): void {
  if (!reduced.applied) return

  store.setState((state) => {
    const patch: Partial<SessionMessageReducerState> = {}

    if (reduced.messagesChanged) {
      patch.message = reduced.message
    }
    if (reduced.partsChanged) {
      patch.part = reduced.part
    }
    if (reduced.boundary && (reduced.boundaryChanged || !state.session_history_boundary?.[sessionID])) {
      patch.session_history_boundary = {
        ...(state.session_history_boundary ?? {}),
        [sessionID]: reduced.boundary,
      }
    } else if (reduced.boundary && reduced.boundaryChanged === false) {
      // Applied page with stable boundary still may need first commit.
      const previous = state.session_history_boundary?.[sessionID]
      if (!previous || !boundariesEqual(previous, reduced.boundary)) {
        patch.session_history_boundary = {
          ...(state.session_history_boundary ?? {}),
          [sessionID]: reduced.boundary,
        }
      }
    }

    // Boundary-only page: messages/parts unchanged but boundary must land.
    if (
      !patch.message
      && !patch.part
      && !patch.session_history_boundary
      && reduced.boundary
    ) {
      patch.session_history_boundary = {
        ...(state.session_history_boundary ?? {}),
        [sessionID]: reduced.boundary,
      }
    }

    if (!patch.message && !patch.part && !patch.session_history_boundary) {
      return {}
    }
    return patch
  })
}

function applyHttpPage(
  store: TranscriptStoreSurface,
  sessionID: string,
  command: Extract<TranscriptCommand, { type: "http-page" }>,
): TranscriptCommandResult {
  const state = store.getState()
  const page = command.page
  const reduced = reduceSessionMessagePage(
    state,
    sessionID,
    {
      ok: true,
      records: page.records.map((record) => ({
        info: record.info,
        parts: record.parts ? [...record.parts] : [],
      })),
      cursor: page.cursor,
      complete: page.complete,
      turnCount: page.turnCount,
      requestedTurnLimit: page.requestedTurnLimit,
    },
    {
      purpose: command.purpose,
      skipPartTypes: command.skipPartTypes,
      optimistic: command.optimistic
        ? command.optimistic.map((item) => ({
          message: item.message,
          parts: [...item.parts],
        }))
        : undefined,
      capturedRevision: command.capturedLiveRevision,
      liveRevision: command.liveRevision,
    },
  )

  if (!reduced.applied) {
    return {
      applied: false,
      changed: false,
      error: reduced.error,
    }
  }

  commitReducedPage(store, sessionID, reduced)

  return {
    applied: true,
    changed: reduced.changed,
    boundary: reduced.boundary,
    meta: reduced.meta,
    confirmedOptimisticIDs: reduced.confirmedOptimisticIDs,
  }
}

function applySseEventsOnStore(
  store: TranscriptStoreSurface,
  events: readonly Event[],
): TranscriptCommandResult {
  if (events.length === 0) {
    return { applied: false, changed: false }
  }

  const current = store.getState()
  // Pure transcript draft — production State no longer carries message/part.
  const draft = {
    message: { ...(current.message ?? {}) },
    part: { ...(current.part ?? {}) },
  }

  let anyApplied = false
  let anyChanged = false
  let firstMaterialization: TranscriptCommandResult["materialization"]

  for (const event of events) {
    if (!isTranscriptSseEventType(event.type)) continue
    anyApplied = true
    const result = applyTranscriptDirectoryEvent(draft, event as Event)
    const changed = typeof result === "boolean" ? result : result.changed
    const materialization = typeof result === "boolean" ? undefined : result.materialization
    if (materialization && !firstMaterialization) {
      firstMaterialization = materialization
    }
    if (changed) anyChanged = true
  }

  if (!anyApplied) {
    return { applied: false, changed: false }
  }

  if (!anyChanged) {
    return {
      applied: true,
      changed: false,
      ...(firstMaterialization ? { materialization: firstMaterialization } : {}),
    }
  }

  store.setState({
    message: draft.message,
    part: draft.part,
  })

  return {
    applied: true,
    changed: true,
    ...(firstMaterialization ? { materialization: firstMaterialization } : {}),
  }
}

function applySseEvent(
  store: TranscriptStoreSurface,
  command: Extract<TranscriptCommand, { type: "sse-event" }>,
): TranscriptCommandResult {
  return applySseEventsOnStore(store, [command.event])
}

function applySseEventBatch(
  store: TranscriptStoreSurface,
  command: Extract<TranscriptCommand, { type: "sse-event-batch" }>,
): TranscriptCommandResult {
  return applySseEventsOnStore(store, command.events)
}

function applyMaterializeSnapshots(
  store: TranscriptStoreSurface,
  sessionID: string,
  command: Extract<TranscriptCommand, { type: "materialize-snapshots" }>,
): TranscriptCommandResult {
  if (command.records.length === 0) {
    return { applied: false, changed: false }
  }

  const state = store.getState()
  const materialized = materializeSessionSnapshots(
    {
      message: state.message ?? {},
      part: state.part ?? {},
    },
    sessionID,
    command.records.map((record) => ({
      info: record.info,
      parts: record.parts ? [...record.parts] : [],
    })),
    {
      skipPartTypes: command.skipPartTypes,
      merge: command.merge,
    },
  )

  if (!materialized.messagesChanged && !materialized.partsChanged) {
    return { applied: true, changed: false }
  }

  store.setState({
    ...(materialized.messagesChanged
      ? { message: materialized.message as SessionMessageReducerState["message"] }
      : {}),
    ...(materialized.partsChanged
      ? { part: materialized.part as SessionMessageReducerState["part"] }
      : {}),
  })

  return { applied: true, changed: true }
}

function applyRemoveMessage(
  store: TranscriptStoreSurface,
  sessionID: string,
  messageID: string,
): TranscriptCommandResult {
  const current = store.getState()
  const messages = current.message?.[sessionID]
  const hasParts = current.part?.[messageID] !== undefined
  if (!messages && !hasParts) {
    return { applied: true, changed: false }
  }

  const message = { ...(current.message ?? {}) }
  let messagesChanged = false
  if (messages) {
    const next = [...messages]
    // Conversation order is messageOrder, not id lexicographic order.
    const index = next.findIndex((item) => item.id === messageID)
    if (index >= 0) {
      next.splice(index, 1)
      message[sessionID] = next
      messagesChanged = true
    }
  }

  const part = { ...(current.part ?? {}) }
  let partsChanged = false
  if (part[messageID] !== undefined) {
    delete part[messageID]
    partsChanged = true
  }

  if (!messagesChanged && !partsChanged) {
    return { applied: true, changed: false }
  }

  store.setState({
    ...(messagesChanged ? { message: message as SessionMessageReducerState["message"] } : {}),
    ...(partsChanged ? { part: part as SessionMessageReducerState["part"] } : {}),
  })
  return { applied: true, changed: true }
}

function applyOptimisticAdd(
  store: TranscriptStoreSurface,
  sessionID: string,
  command: Extract<TranscriptCommand, { type: "optimistic-add" }>,
  deps: TranscriptStoreAdapterDeps,
  directory: string,
): TranscriptCommandResult {
  deps.setOptimisticShadow?.({
    directory,
    sessionID,
    message: command.message,
    parts: command.parts,
  })

  const current = store.getState()
  const message = { ...(current.message ?? {}) }
  const part = { ...(current.part ?? {}) }

  const messages = message[sessionID] ? [...message[sessionID]] : []
  if (!messages.some((item) => item.id === command.message.id)) {
    messages.push(command.message)
  }
  message[sessionID] = messages
  part[command.message.id] = sortParts(command.parts)

  store.setState({ message, part })
  return { applied: true, changed: true }
}

function applyOptimisticRemove(
  store: TranscriptStoreSurface,
  sessionID: string,
  messageID: string,
  deps: TranscriptStoreAdapterDeps,
  directory: string,
): TranscriptCommandResult {
  deps.clearOptimisticShadow?.({ directory, sessionID, messageID })

  const current = store.getState()
  const message = { ...(current.message ?? {}) }
  const part = { ...(current.part ?? {}) }
  let changed = false

  const messages = message[sessionID]
  if (messages) {
    const next = [...messages]
    const index = next.findIndex((item) => item.id === messageID)
    if (index >= 0) {
      next.splice(index, 1)
      message[sessionID] = next
      changed = true
    }
  }
  if (part[messageID] !== undefined) {
    delete part[messageID]
    changed = true
  }

  if (changed) {
    store.setState({ message, part })
  }
  return { applied: true, changed }
}

function applyOptimisticConfirm(
  sessionID: string,
  messageID: string,
  deps: TranscriptStoreAdapterDeps,
  directory: string,
): TranscriptCommandResult {
  // Confirm clears the shadow only; the visible row stays (server owns it).
  deps.clearOptimisticShadow?.({ directory, sessionID, messageID })
  return { applied: true, changed: false }
}

/**
 * Clear only transcript fields for one session: messages, their parts, and the
 * history boundary. Status / todo / permission / question / diff stay intact —
 * those domains are outside TranscriptRepository ownership.
 */
function clearTranscriptFields(
  store: TranscriptStoreSurface,
  sessionID: string,
): boolean {
  const current = store.getState()
  const messages = current.message?.[sessionID]
  const boundary = current.session_history_boundary?.[sessionID]
  const hadMessages = Boolean(messages && messages.length > 0)
  const hadBoundary = boundary !== undefined
  // Collect part keys owned by this session's messages before dropping them.
  const messageIDs = new Set<string>()
  if (messages) {
    for (const message of messages) {
      if (message?.id) messageIDs.add(message.id)
    }
  }

  let partsChanged = false
  const nextPart = { ...(current.part ?? {}) }
  for (const messageID of messageIDs) {
    if (nextPart[messageID] !== undefined) {
      delete nextPart[messageID]
      partsChanged = true
    }
  }
  // Also drop orphan parts stamped with this sessionID (no owning message row).
  for (const [partKey, parts] of Object.entries(nextPart)) {
    if (messageIDs.has(partKey)) continue
    if (!parts?.some((part) => (part as { sessionID?: string }).sessionID === sessionID)) {
      continue
    }
    delete nextPart[partKey]
    partsChanged = true
  }

  if (!hadMessages && !hadBoundary && !partsChanged) {
    return false
  }

  const nextMessage = { ...(current.message ?? {}) }
  delete nextMessage[sessionID]
  const nextBoundary = { ...(current.session_history_boundary ?? {}) }
  delete nextBoundary[sessionID]

  store.setState({
    message: nextMessage as SessionMessageReducerState["message"],
    part: nextPart as SessionMessageReducerState["part"],
    session_history_boundary: nextBoundary as SessionMessageReducerState["session_history_boundary"],
  })
  return true
}

function applyReset(
  store: TranscriptStoreSurface,
  sessionID: string,
  command: Extract<TranscriptCommand, { type: "reset" }>,
): TranscriptCommandResult {
  const cleared = clearTranscriptFields(store, sessionID)

  if (!command.page) {
    return { applied: true, changed: cleared }
  }

  const pageResult = applyHttpPage(store, sessionID, {
    type: "http-page",
    purpose: "initial",
    page: command.page,
    capturedLiveRevision: command.capturedLiveRevision,
    liveRevision: command.liveRevision,
    skipPartTypes: command.skipPartTypes,
  })

  return {
    ...pageResult,
    // A successful rebuild always counts as changed relative to the prior chain,
    // even when the page itself happens to be empty/unchanged after clear.
    changed: cleared || pageResult.changed,
    applied: pageResult.applied || cleared,
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a store-backed TranscriptRepository (test / pure harness only).
 *
 * The adapter is harness-store oriented: each scope resolves its surface via
 * `deps.getStore(directory)`. Subscriptions watch that store and notify when
 * the session's message, part, or history-boundary references change.
 * Production binds Query via `createQueryTranscriptRepository`.
 */
export function createStoreTranscriptRepository(
  deps: TranscriptStoreAdapterDeps,
): TranscriptRepository {
  const listeners = new Map<string, Set<TranscriptChangeListener>>()
  const storeUnsubs = new Map<string, () => void>()

  const ensureStoreSubscription = (scope: TranscriptScope) => {
    const key = scopeKey(scope)
    if (storeUnsubs.has(key)) return

    const directory = normalizeDirectory(scope.directory)
    const store = deps.getStore(directory)
    const sessionID = scope.sessionID

    let prevMessages = store.getState().message?.[sessionID]
    let prevBoundary = readBoundary(store.getState(), sessionID)
    let prevPartRefs = new Map<string, readonly Part[] | undefined>()
    for (const message of prevMessages ?? []) {
      prevPartRefs.set(message.id, store.getState().part?.[message.id])
    }

    const unsubscribe = store.subscribe((state) => {
      const nextMessages = state.message?.[sessionID]
      const nextBoundary = readBoundary(state, sessionID)

      let partsChanged = false
      const nextPartRefs = new Map<string, readonly Part[] | undefined>()
      for (const message of nextMessages ?? []) {
        const parts = state.part?.[message.id]
        nextPartRefs.set(message.id, parts)
        if (prevPartRefs.get(message.id) !== parts) partsChanged = true
      }
      if (prevPartRefs.size !== nextPartRefs.size) partsChanged = true

      const messagesChanged = nextMessages !== prevMessages
      const boundaryEqual = boundariesEqual(nextBoundary, prevBoundary)

      prevMessages = nextMessages
      prevBoundary = nextBoundary
      prevPartRefs = nextPartRefs

      if (!messagesChanged && !partsChanged && boundaryEqual) return

      const set = listeners.get(key)
      if (!set || set.size === 0) return
      for (const listener of set) {
        listener(scope)
      }
    })

    storeUnsubs.set(key, unsubscribe)
  }

  const releaseStoreSubscriptionIfIdle = (key: string) => {
    const set = listeners.get(key)
    if (set && set.size > 0) return
    const unsub = storeUnsubs.get(key)
    if (unsub) {
      unsub()
      storeUnsubs.delete(key)
    }
    listeners.delete(key)
  }

  const repository: TranscriptRepository = {
    getTranscript(scope) {
      const directory = normalizeDirectory(scope.directory)
      const store = deps.getStore(directory)
      const state = store.getState()
      const sessionID = scope.sessionID
      const messages = state.message?.[sessionID] ?? []
      const liveRevision = deps.getLiveRevision?.(directory, sessionID) ?? 0
      return projectTranscriptData({
        sessionID,
        messages,
        parts: state.part ?? {},
        boundary: readBoundary(state, sessionID),
        liveRevision,
      })
    },

    getPagination(scope) {
      const directory = normalizeDirectory(scope.directory)
      const store = deps.getStore(directory)
      const state = store.getState()
      return projectPagination(scope.sessionID, readBoundary(state, scope.sessionID))
    },

    getRequestState(scope) {
      const directory = normalizeDirectory(scope.directory)
      return deps.getRequestState?.(directory, scope.sessionID) ?? {
        sessionID: scope.sessionID,
        status: "idle",
      }
    },

    getHydrationState(scope): TranscriptHydrationState {
      const transcript = repository.getTranscript(scope)
      const p0Satisfied = evaluateTranscriptP0Satisfied(transcript)
      return {
        sessionID: scope.sessionID,
        p0Satisfied,
        phase: resolveTranscriptHydrationPhase({
          p0Satisfied,
          earlierHistoryLoaded: countTranscriptAuthoredUserTurns(transcript) > 1,
        }),
      }
    },

    getMessage(scope, messageID) {
      const data = repository.getTranscript(scope)
      return data.messagesByID[messageID]
    },

    getParts(scope, messageID) {
      const directory = normalizeDirectory(scope.directory)
      const store = deps.getStore(directory)
      return store.getState().part?.[messageID] ?? []
    },

    hasSession(scope) {
      const directory = normalizeDirectory(scope.directory)
      const store = deps.getStore(directory)
      const message = store.getState().message
      if (!message) return false
      return Object.prototype.hasOwnProperty.call(message, scope.sessionID)
    },

    apply(scope, command) {
      const directory = normalizeDirectory(scope.directory)
      const store = deps.getStore(directory)
      const sessionID = scope.sessionID

      switch (command.type) {
        case "http-page":
          return applyHttpPage(store, sessionID, command)
        case "sse-event":
          return applySseEvent(store, command)
        case "sse-event-batch":
          return applySseEventBatch(store, command)
        case "optimistic-add":
          return applyOptimisticAdd(store, sessionID, command, deps, directory)
        case "optimistic-confirm":
          return applyOptimisticConfirm(sessionID, command.messageID, deps, directory)
        case "optimistic-remove":
          return applyOptimisticRemove(store, sessionID, command.messageID, deps, directory)
        case "reset":
          return applyReset(store, sessionID, command)
        case "materialize-snapshots":
          return applyMaterializeSnapshots(store, sessionID, command)
        case "remove-message":
          return applyRemoveMessage(store, sessionID, command.messageID)
        default: {
          const _exhaustive: never = command
          void _exhaustive
          return { applied: false, changed: false }
        }
      }
    },

    subscribe(scope, listener) {
      const key = scopeKey(scope)
      let set = listeners.get(key)
      if (!set) {
        set = new Set()
        listeners.set(key, set)
      }
      set.add(listener)
      ensureStoreSubscription(scope)

      return () => {
        const current = listeners.get(key)
        if (!current) return
        current.delete(listener)
        releaseStoreSubscriptionIfIdle(key)
      }
    },
  }

  return repository
}

/** @internal test helper — re-export page shape for harnesses. */
export type { TranscriptTransportPage }
