/**
 * Session prefetch TTL cache — prevents redundant session fetches
 * within a short window. Port of OpenCode's session-prefetch.ts.
 *
 * Tracks: last fetch time, response-owned pagination cursor, completeness.
 * Version counter invalidates stale inflight requests after eviction.
 *
 * Load generation: each `beginSessionMessageLoad` bumps a per-entry epoch.
 * Failures and successes must pass that epoch so a slower concurrent load
 * cannot paint `error` (or overwrite ready) while a newer load is in flight —
 * the session-switch path starts imperative + reactive pulls that otherwise
 * flash `chat.history.loadFailedTitle` mid-retry.
 */

import { getRuntimeKey } from "@/lib/runtime-switch"

const SESSION_PREFETCH_TTL = 15_000

export type SessionPrefetchMeta = {
  /**
   * Cumulative product **turn** limit loaded (authored-user turns), not messages.
   * Compared to request turn budgets in shouldSkipSessionPrefetch.
   */
  limit: number
  cursor?: string
  complete: boolean
  at: number
  status: "loading" | "ready" | "error"
  error?: string
  /** Monotonic load epoch; stale fail/success ignore when mismatched. */
  loadGeneration: number
}

const compositeKey = (directory: string, sessionID: string, runtimeKey = getRuntimeKey()) =>
  `${runtimeKey}\n${directory}\n${sessionID}`

const cache = new Map<string, SessionPrefetchMeta>()
const inflight = new Map<string, Promise<SessionPrefetchMeta | undefined>>()
const rev = new Map<string, number>()
const listeners = new Map<string, Set<() => void>>()

const version = (id: string) => rev.get(id) ?? 0

const notify = (id: string) => {
  const callbacks = listeners.get(id)
  if (!callbacks) return
  callbacks.forEach((callback) => callback())
}

/** Check if a prefetch/sync can be skipped (recently fetched). */
export function shouldSkipSessionPrefetch(input: {
  hasSession: boolean
  hasMessages: boolean
  info?: SessionPrefetchMeta
  pageSize: number
  now?: number
}): boolean {
  if (!input.hasSession) {
    return false
  }

  if (!input.hasMessages) {
    return false
  }

  const info = input.info
  if (!info) return true
  // Dirty encoding: at=0. It pierces complete/limit/TTL so a previously large
  // complete page still refreshes after markSessionPrefetchDirty.
  if (info.at === 0) return false
  if (info.status !== "ready") return false
  if (info.complete) return true
  if (info.limit > input.pageSize) return true
  if (info.limit < input.pageSize) return false
  return (input.now ?? Date.now()) - info.at < SESSION_PREFETCH_TTL
}

export function getSessionPrefetch(directory: string, sessionID: string, runtimeKey = getRuntimeKey()): SessionPrefetchMeta | undefined {
  return cache.get(compositeKey(directory, sessionID, runtimeKey))
}

/**
 * Mark an in-flight message page load. Returns the generation token that
 * `failSessionMessageLoad` / `setSessionPrefetch` must pass so only the latest
 * load can settle the entry.
 */
export function beginSessionMessageLoad(directory: string, sessionID: string, requestedLimit: number, runtimeKey = getRuntimeKey()): number {
  const id = compositeKey(directory, sessionID, runtimeKey)
  const current = cache.get(id)
  const loadGeneration = (current?.loadGeneration ?? 0) + 1
  cache.set(id, {
    limit: Math.max(current?.limit ?? 0, requestedLimit),
    cursor: current?.cursor,
    complete: current?.complete ?? false,
    at: current?.at ?? Date.now(),
    status: "loading",
    loadGeneration,
  })
  notify(id)
  return loadGeneration
}

export function failSessionMessageLoad(
  directory: string,
  sessionID: string,
  error: string,
  runtimeKey = getRuntimeKey(),
  loadGeneration?: number,
) {
  const id = compositeKey(directory, sessionID, runtimeKey)
  const current = cache.get(id)
  if (
    loadGeneration !== undefined
    && current
    && current.loadGeneration !== loadGeneration
  ) {
    return
  }
  const generation = loadGeneration ?? current?.loadGeneration ?? 0
  cache.set(id, {
    limit: current?.limit ?? 0,
    cursor: current?.cursor,
    complete: current?.complete ?? false,
    at: current?.at ?? Date.now(),
    status: "error",
    error,
    loadGeneration: generation,
  })
  notify(id)
}

export function subscribeSessionPrefetch(directory: string, sessionID: string, callback: () => void, runtimeKey = getRuntimeKey()) {
  if (!sessionID) return () => undefined
  const id = compositeKey(directory, sessionID, runtimeKey)
  let callbacks = listeners.get(id)
  if (!callbacks) {
    callbacks = new Set()
    listeners.set(id, callbacks)
  }
  callbacks.add(callback)
  return () => {
    callbacks?.delete(callback)
    if (callbacks?.size === 0) listeners.delete(id)
  }
}

export function setSessionPrefetch(input: {
  directory: string
  sessionID: string
  runtimeKey?: string
  limit: number
  cursor?: string
  complete: boolean
  at?: number
  /**
   * When set, only apply if this matches the entry's current load generation
   * (or the entry is missing). Omitting applies unconditionally — used for
   * non-load writers (dirty materialize, eviction recovery).
   */
  loadGeneration?: number
}) {
  const id = compositeKey(input.directory, input.sessionID, input.runtimeKey)
  const current = cache.get(id)
  if (
    input.loadGeneration !== undefined
    && current
    && current.loadGeneration !== input.loadGeneration
  ) {
    return
  }
  const loadGeneration = input.loadGeneration ?? current?.loadGeneration ?? 0
  cache.set(id, {
    limit: input.limit,
    cursor: input.cursor,
    complete: input.complete,
    at: input.at ?? Date.now(),
    status: "ready",
    loadGeneration,
  })
  notify(id)
}

/** Invalidate cache for specific sessions (e.g. after eviction). */
export function clearSessionPrefetch(directory: string, sessionIDs: Iterable<string>, runtimeKey = getRuntimeKey()) {
  for (const sessionID of sessionIDs) {
    if (!sessionID) continue
    const id = compositeKey(directory, sessionID, runtimeKey)
    rev.set(id, version(id) + 1)
    cache.delete(id)
    inflight.delete(id)
    notify(id)
  }
}

/**
 * Mark a session's prefetch entry as dirty after an authoritative live event.
 * `at=0` forces the next cache check to refresh the tail while the most recent
 * page response retains its cursor and complete boundary. That keeps history
 * pagination immediately usable through live tail updates. No-op when the
 * session was never prefetched.
 */
export function markSessionPrefetchDirty(directory: string, sessionIDs: Iterable<string>, runtimeKey = getRuntimeKey()) {
  for (const sessionID of sessionIDs) {
    if (!sessionID) continue
    const id = compositeKey(directory, sessionID, runtimeKey)
    const current = cache.get(id)
    if (!current) continue
    cache.set(id, {
      ...current,
      at: 0,
    })
    notify(id)
  }
}
