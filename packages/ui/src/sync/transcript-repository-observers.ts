/**
 * React observers for TranscriptRepository reads (Ticket 02/09).
 *
 * Production readers subscribe through the bound Query-backed repository
 * (QueryCache sole authority). When unbound (unit tests without SyncProvider),
 * an ephemeral store adapter may pin to a harness store so the same contract
 * path runs.
 *
 * Call sites keep stable public APIs in sync-context; this module owns the
 * useSyncExternalStore wiring and reference-stable projections.
 */

import React, { useCallback, useRef } from "react"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import type { StoreApi } from "zustand"

import type { DirectoryStore } from "./child-store"
import {
  getTranscriptRepository,
  getTranscriptRepositoryBindingRevision,
  resolveTranscriptRepositoryForStore,
  subscribeTranscriptRepositoryBinding,
  transcriptScope,
} from "./transcript-repository-runtime"
import type {
  TranscriptData,
  TranscriptPagination,
  TranscriptRepository,
} from "./transcript-repository"
import { projectPagination } from "./transcript-repository"
import {
  getSessionMaterializationStatusFromProjection,
  type SessionMaterializationStatus,
} from "./materialization"
import { ensureTranscriptOnObserve } from "./transcript-reconnect-compensation-runtime"
import { UNKNOWN_SESSION_HISTORY_BOUNDARY } from "./types"

const EMPTY_TRANSCRIPT_MESSAGES: Message[] = []
const EMPTY_TRANSCRIPT_PARTS: Part[] = []

const EMPTY_TRANSCRIPT_DATA: TranscriptData = {
  sessionID: "",
  messageOrder: [],
  messagesByID: {},
  partsByMessageID: {},
  boundary: UNKNOWN_SESSION_HISTORY_BOUNDARY,
  liveRevision: 0,
}

const EMPTY_PAGINATION: TranscriptPagination = projectPagination("", UNKNOWN_SESSION_HISTORY_BOUNDARY)

function resolveReaderRepository(
  directory: string,
  store: StoreApi<DirectoryStore>,
): TranscriptRepository {
  return resolveTranscriptRepositoryForStore(directory, store)
}

/**
 * In-flight gate for ensureTranscriptOnObserve on subscribe.
 * Controller staleOnObserve already enforces once-per-stale-checkpoint work;
 * this only coalesces concurrent subscribe storms for the same scope.
 */
const observeEnsureInFlight = new Set<string>()

function observeEnsureKey(directory: string, sessionID: string): string {
  return `${directory}\n${sessionID}`
}

/**
 * Fire ensureTranscriptOnObserve when a session is first observed.
 * Controller returns null when the session is not stale; errors surface via
 * compensation onError / repository request state — never throw into subscribe.
 */
export function scheduleEnsureTranscriptOnObserve(directory: string, sessionID: string): void {
  if (!sessionID) return
  const key = observeEnsureKey(directory, sessionID)
  if (observeEnsureInFlight.has(key)) return
  observeEnsureInFlight.add(key)
  void ensureTranscriptOnObserve(transcriptScope(directory, sessionID))
    .catch(() => {
      // Request-state / compensation onError owns surfacing; never throw into subscribe.
    })
    .finally(() => {
      observeEnsureInFlight.delete(key)
    })
}

/** Clear in-flight observe-ensure gate (tests / binding swap). */
export function resetObserveEnsureGate(directory?: string, sessionID?: string): void {
  if (directory && sessionID) {
    observeEnsureInFlight.delete(observeEnsureKey(directory, sessionID))
    return
  }
  observeEnsureInFlight.clear()
}

/**
 * Subscribe to a session transcript and select a projection.
 * Returns the same reference when the selected value is Object.is-equal.
 * On subscribe, schedules ensureTranscriptOnObserve once per scope for
 * reconnect-stale inactive sessions (Ticket 09 batch 1A).
 */
function useTranscriptSelector<T>(
  sessionID: string,
  directory: string,
  store: StoreApi<DirectoryStore>,
  select: (data: TranscriptData) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
  options?: { enabled?: boolean },
): T {
  const selectRef = useRef(select)
  selectRef.current = select
  const isEqualRef = useRef(isEqual)
  isEqualRef.current = isEqual
  const valueRef = useRef<T | undefined>(undefined)
  const enabled = options?.enabled !== false

  const getSnapshot = useCallback(() => {
    // Include binding revision so React re-reads after store→Query swap.
    void getTranscriptRepositoryBindingRevision()
    if (!sessionID || !enabled) {
      const empty = selectRef.current(EMPTY_TRANSCRIPT_DATA)
      if (valueRef.current === undefined || !isEqualRef.current(valueRef.current, empty)) {
        valueRef.current = empty
      }
      return valueRef.current as T
    }
    const repository = resolveReaderRepository(directory, store)
    const data = repository.getTranscript(transcriptScope(directory, sessionID))
    const next = selectRef.current(data)
    if (valueRef.current === undefined || !isEqualRef.current(valueRef.current, next)) {
      valueRef.current = next
    }
    return valueRef.current as T
  }, [directory, enabled, sessionID, store])

  const subscribe = useCallback((notify: () => void) => {
    if (!sessionID || !enabled) return () => undefined
    // Ticket 09 batch 1A: ensure stale inactive sessions when first observed.
    scheduleEnsureTranscriptOnObserve(directory, sessionID)
    // Ticket 09: re-subscribe when production binding swaps (ephemeral→Query).
    let repoUnsub = resolveReaderRepository(directory, store).subscribe(
      transcriptScope(directory, sessionID),
      () => {
        notify()
      },
    )
    const unsubBinding = subscribeTranscriptRepositoryBinding(() => {
      repoUnsub()
      valueRef.current = undefined
      // Re-arm ensure after production Query bind so post-swap observe can load.
      resetObserveEnsureGate(directory, sessionID)
      scheduleEnsureTranscriptOnObserve(directory, sessionID)
      repoUnsub = resolveReaderRepository(directory, store).subscribe(
        transcriptScope(directory, sessionID),
        () => {
          notify()
        },
      )
      notify()
    })
    return () => {
      unsubBinding()
      repoUnsub()
    }
  }, [directory, enabled, sessionID, store])

  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/**
 * Build a chronological message array from TranscriptData (stable empty ref).
 * When `previous` has the same length and the same message object refs in
 * messageOrder, reuse it so useSyncExternalStore getSnapshot stays Object.is-stable.
 */
export function messagesFromTranscriptData(
  data: TranscriptData,
  previous?: readonly Message[],
): Message[] {
  if (data.messageOrder.length === 0) return EMPTY_TRANSCRIPT_MESSAGES as Message[]

  if (previous && previous.length > 0) {
    let reusable = true
    let previousIndex = 0
    for (const id of data.messageOrder) {
      const message = data.messagesByID[id]
      if (!message) continue
      if (previousIndex >= previous.length || previous[previousIndex] !== message) {
        reusable = false
        break
      }
      previousIndex += 1
    }
    if (reusable && previousIndex === previous.length) {
      return previous as Message[]
    }
  }

  const messages: Message[] = []
  for (const id of data.messageOrder) {
    const message = data.messagesByID[id]
    if (message) messages.push(message)
  }
  return messages
}

/**
 * Materialization status from repository TranscriptData.
 * Pass `resolved: true` when hasSession reports a loaded-empty canonical entry
 * so empty messageOrder still counts as hasMessages + renderable.
 */
export function materializationStatusFromTranscriptData(
  data: TranscriptData,
  options?: { resolved?: boolean },
): SessionMaterializationStatus {
  if (data.messageOrder.length === 0) {
    if (options?.resolved === true) {
      return getSessionMaterializationStatusFromProjection({
        messages: EMPTY_TRANSCRIPT_MESSAGES,
        parts: data.partsByMessageID,
      })
    }
    return { hasMessages: false, renderable: false, missingPartMessageIDs: [] }
  }
  return getSessionMaterializationStatusFromProjection({
    messages: messagesFromTranscriptData(data),
    parts: data.partsByMessageID,
  })
}

/** Subscribe to session materialization status via TranscriptRepository. */
export function useTranscriptMaterializationStatus(
  sessionID: string,
  directory: string,
  store: StoreApi<DirectoryStore>,
  options?: { enabled?: boolean },
): SessionMaterializationStatus {
  return useTranscriptSelector(
    sessionID,
    directory,
    store,
    (data) => {
      if (!sessionID) {
        return { hasMessages: false, renderable: false, missingPartMessageIDs: [] }
      }
      const repository = resolveReaderRepository(directory, store)
      const resolved = repository.hasSession?.(transcriptScope(directory, sessionID))
      return materializationStatusFromTranscriptData(data, {
        resolved: resolved === true ? true : undefined,
      })
    },
    (a, b) => (
      a.hasMessages === b.hasMessages
      && a.renderable === b.renderable
      && a.missingPartMessageIDs.length === b.missingPartMessageIDs.length
      && a.missingPartMessageIDs.every((id, index) => id === b.missingPartMessageIDs[index])
    ),
    options,
  )
}

/** Chronological message array for a session (store-order references). */
export function useTranscriptMessages(
  sessionID: string,
  directory: string,
  store: StoreApi<DirectoryStore>,
  options?: { enabled?: boolean },
): readonly Message[] {
  return useTranscriptSelector(
    sessionID,
    directory,
    store,
    (data) => messagesFromTranscriptData(data),
    (a, b) => {
      if (a === b) return true
      if (a.length !== b.length) return false
      for (let i = 0; i < a.length; i += 1) {
        if (a[i] !== b[i]) return false
      }
      return true
    },
    options,
  )
}

export type TranscriptLastMessageSnapshot = {
  readonly id: string
  readonly role: string
  readonly timestamp: number
}

/**
 * Narrow last-message projection for assist/recap (id/role/time only).
 * Stable reference when the trailing message identity is unchanged.
 */
export function useTranscriptLastMessageSnapshot(
  sessionID: string,
  directory: string,
  store: StoreApi<DirectoryStore>,
): TranscriptLastMessageSnapshot | null {
  return useTranscriptSelector(
    sessionID,
    directory,
    store,
    (data) => {
      if (data.messageOrder.length === 0) return null
      const lastID = data.messageOrder[data.messageOrder.length - 1]
      const message = lastID ? data.messagesByID[lastID] : undefined
      if (!message?.id) return null
      const time = (message as { time?: { completed?: number; created?: number } }).time
      return {
        id: message.id,
        role: typeof message.role === "string" ? message.role : "",
        timestamp: time?.completed ?? time?.created ?? 0,
      }
    },
    (a, b) => {
      if (a === b) return true
      if (!a || !b) return false
      return a.id === b.id && a.role === b.role && a.timestamp === b.timestamp
    },
  )
}

function transcriptDataEqual(a: TranscriptData, b: TranscriptData): boolean {
  if (a === b) return true
  if (a.sessionID !== b.sessionID || a.liveRevision !== b.liveRevision) return false
  if (a.boundary.kind !== b.boundary.kind || a.boundary.loadedTurns !== b.boundary.loadedTurns) {
    return false
  }
  if (
    a.boundary.kind === "has-more"
    && b.boundary.kind === "has-more"
    && a.boundary.cursor !== b.boundary.cursor
  ) {
    return false
  }
  if (a.messageOrder.length !== b.messageOrder.length) return false
  for (let i = 0; i < a.messageOrder.length; i += 1) {
    const id = a.messageOrder[i]
    if (id !== b.messageOrder[i]) return false
    if (a.messagesByID[id] !== b.messagesByID[id]) return false
    if (a.partsByMessageID[id] !== b.partsByMessageID[id]) return false
  }
  // Parts for messages no longer in order should not keep the snapshot stale;
  // only ordered message parts participate in display.
  return true
}

/**
 * Full transcript data projection (messages + parts maps + boundary).
 * Used when a reader needs parts without reading child-store.part directly.
 */
export function useTranscriptData(
  sessionID: string,
  directory: string,
  store: StoreApi<DirectoryStore>,
  options?: { enabled?: boolean },
): TranscriptData {
  return useTranscriptSelector(
    sessionID,
    directory,
    store,
    (data) => data,
    transcriptDataEqual,
    options,
  )
}

export type TranscriptScopeRef = {
  readonly directory: string
  readonly sessionID: string
}

/**
 * Subscribe to many transcript scopes (one notify for any scope change).
 * Used by queue auto-send which tracks multiple sessions without owning queue domain.
 */
export function subscribeTranscriptScopes(
  scopes: readonly TranscriptScopeRef[],
  notify: () => void,
  storeResolver?: (directory: string) => StoreApi<DirectoryStore> | undefined,
): () => void {
  if (scopes.length === 0) return () => undefined
  const unsubs: Array<() => void> = []
  const seen = new Set<string>()
  for (const scope of scopes) {
    const key = `${scope.directory}\n${scope.sessionID}`
    if (seen.has(key)) continue
    seen.add(key)
    const bound = getTranscriptRepository()
    if (bound) {
      unsubs.push(bound.subscribe(transcriptScope(scope.directory, scope.sessionID), notify))
      continue
    }
    const store = storeResolver?.(scope.directory)
    if (!store) continue
    const repository = resolveTranscriptRepositoryForStore(scope.directory, store)
    unsubs.push(repository.subscribe(transcriptScope(scope.directory, scope.sessionID), notify))
  }
  return () => {
    for (const unsub of unsubs) unsub()
  }
}

/**
 * Compact trailing-message fingerprint for multi-scope completion detection.
 * Format: sessionID:lastId:role:completed per scope, joined by NUL.
 */
export function readTranscriptCompletionSignature(
  scopes: readonly TranscriptScopeRef[],
  storeResolver?: (directory: string) => StoreApi<DirectoryStore> | undefined,
): string {
  if (scopes.length === 0) return ""
  return scopes.map((scope) => {
    const messages = readTranscriptMessages(
      scope.directory,
      scope.sessionID,
      storeResolver?.(scope.directory),
    )
    const last = messages[messages.length - 1] as {
      id?: string
      role?: string
      time?: { completed?: number }
    } | undefined
    return `${scope.sessionID}:${last?.id ?? ""}:${last?.role ?? ""}:${last?.time?.completed ?? ""}`
  }).join("\u0000")
}

/** Message count for a session. */
export function useTranscriptMessageCount(
  sessionID: string,
  directory: string,
  store: StoreApi<DirectoryStore>,
): number {
  return useTranscriptSelector(
    sessionID,
    directory,
    store,
    (data) => data.messageOrder.length,
  )
}

/** Whether the session has a message entry in the transcript model. */
export function useTranscriptMessagesResolved(
  sessionID: string,
  directory: string,
  store: StoreApi<DirectoryStore>,
): boolean {
  const valueRef = useRef(false)
  const getSnapshot = useCallback(() => {
    if (!sessionID) {
      valueRef.current = false
      return false
    }
    const repository = resolveReaderRepository(directory, store)
    const next = repository.hasSession?.(transcriptScope(directory, sessionID))
      ?? repository.getTranscript(transcriptScope(directory, sessionID)).messageOrder.length > 0
    valueRef.current = next
    return valueRef.current
  }, [directory, sessionID, store])
  const subscribe = useCallback((notify: () => void) => {
    if (!sessionID) return () => undefined
    const repository = resolveReaderRepository(directory, store)
    return repository.subscribe(transcriptScope(directory, sessionID), () => {
      notify()
    })
  }, [directory, sessionID, store])
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/**
 * Parts for a message. Prefer session-scoped repository subscribe when
 * sessionID is known. Without sessionID, still reads via getParts but cannot
 * narrow the subscription (callers should pass sessionID in production UI).
 */
export function useTranscriptParts(
  messageID: string,
  directory: string,
  store: StoreApi<DirectoryStore>,
  sessionID?: string,
): readonly Part[] {
  const valueRef = useRef<readonly Part[] | undefined>(undefined)

  const getSnapshot = useCallback(() => {
    if (!messageID) {
      valueRef.current = EMPTY_TRANSCRIPT_PARTS
      return EMPTY_TRANSCRIPT_PARTS
    }
    const repository = resolveReaderRepository(directory, store)
    // Parts are keyed by messageID in the store adapter; session scopes the
    // subscription. Prefer real sessionID; messageID-as-scope is a last resort
    // for imperative reads only (UI must pass sessionID).
    const scopeSession = sessionID || messageID
    const parts = repository.getParts(transcriptScope(directory, scopeSession), messageID)
    const next = parts.length === 0 ? EMPTY_TRANSCRIPT_PARTS : parts
    if (valueRef.current === undefined || valueRef.current !== next) {
      // Prefer stable empty; for non-empty keep repository array reference.
      if (
        valueRef.current
        && valueRef.current.length === next.length
        && valueRef.current.every((part, index) => part === next[index])
      ) {
        return valueRef.current
      }
      valueRef.current = next
    }
    return valueRef.current
  }, [directory, messageID, sessionID, store])

  const subscribe = useCallback((notify: () => void) => {
    if (!messageID) return () => undefined
    const repository = resolveReaderRepository(directory, store)
    if (sessionID) {
      return repository.subscribe(transcriptScope(directory, sessionID), () => {
        notify()
      })
    }
    // No session scope: still use repository if bound with a message-id scope
    // only for notify coalescing is wrong; require callers to pass sessionID.
    // Fall back to a no-op subscription that never fires — getSnapshot is still
    // correct on first read. Production MessageList always passes sessionId.
    return () => undefined
  }, [directory, messageID, sessionID, store])

  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** Pagination projection for a session. */
export function useTranscriptPagination(
  sessionID: string,
  directory: string,
  store: StoreApi<DirectoryStore>,
): TranscriptPagination {
  return useTranscriptSelector(
    sessionID,
    directory,
    store,
    (data) => projectPagination(sessionID, data.boundary),
    (a, b) => (
      a.sessionID === b.sessionID
      && a.hasPreviousPage === b.hasPreviousPage
      && a.isComplete === b.isComplete
      && a.cursor === b.cursor
      && a.loadedTurns === b.loadedTurns
      && a.boundary.kind === b.boundary.kind
      && a.boundary.loadedTurns === b.boundary.loadedTurns
      && (a.boundary.kind !== "has-more"
        || b.boundary.kind !== "has-more"
        || a.boundary.cursor === b.boundary.cursor)
    ),
  )
}

/** Imperative read helpers for non-React callers (sync-refs, streaming). */
export function readTranscriptMessages(
  directory: string,
  sessionID: string,
  store?: StoreApi<DirectoryStore>,
): Message[] {
  if (!sessionID) return []
  const bound = getTranscriptRepository()
  if (bound) {
    const data = bound.getTranscript(transcriptScope(directory, sessionID))
    return data.messageOrder
      .map((id) => data.messagesByID[id])
      .filter((message): message is Message => Boolean(message))
  }
  if (!store) return []
  const repository = resolveTranscriptRepositoryForStore(directory, store)
  const data = repository.getTranscript(transcriptScope(directory, sessionID))
  return data.messageOrder
    .map((id) => data.messagesByID[id])
    .filter((message): message is Message => Boolean(message))
}

export function readTranscriptParts(
  directory: string,
  messageID: string,
  store?: StoreApi<DirectoryStore>,
  sessionID?: string,
): readonly Part[] {
  if (!messageID) return EMPTY_TRANSCRIPT_PARTS
  const bound = getTranscriptRepository()
  const scopeSession = sessionID || messageID
  if (bound) {
    return bound.getParts(transcriptScope(directory, scopeSession), messageID)
  }
  if (!store) return EMPTY_TRANSCRIPT_PARTS
  const repository = resolveTranscriptRepositoryForStore(directory, store)
  return repository.getParts(transcriptScope(directory, scopeSession), messageID)
}

export function readTranscriptPagination(
  directory: string,
  sessionID: string,
  store?: StoreApi<DirectoryStore>,
): TranscriptPagination {
  if (!sessionID) return EMPTY_PAGINATION
  const bound = getTranscriptRepository()
  if (bound) {
    return bound.getPagination(transcriptScope(directory, sessionID))
  }
  if (!store) return EMPTY_PAGINATION
  const repository = resolveTranscriptRepositoryForStore(directory, store)
  return repository.getPagination(transcriptScope(directory, sessionID))
}

export function isTranscriptMessagesResolved(
  directory: string,
  sessionID: string,
  store?: StoreApi<DirectoryStore>,
): boolean {
  if (!sessionID) return false
  const bound = getTranscriptRepository()
  const repository = bound ?? (store ? resolveTranscriptRepositoryForStore(directory, store) : null)
  if (!repository) return false
  if (repository.hasSession) {
    return repository.hasSession(transcriptScope(directory, sessionID))
  }
  return repository.getTranscript(transcriptScope(directory, sessionID)).messageOrder.length > 0
}
