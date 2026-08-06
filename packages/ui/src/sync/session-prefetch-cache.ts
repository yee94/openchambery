/**
 * Session prefetch TTL cache — prevents redundant session fetches
 * within a short window. Port of OpenCode's session-prefetch.ts.
 *
 * Owns request **lifecycle** coordination only: last fetch time, TTL/dirty,
 * loading/ready/error status, the load-generation gate, and the requested
 * turn budget of the newest load. It carries NO pagination fact — the
 * directory child store owns the only client-side history boundary via
 * `state.session_history_boundary` (`SessionHistoryBoundary`), and a TanStack
 * Query page response is only transport input on its way to that store.
 * `shouldSkipSessionPrefetch` requires a known store boundary plus a fresh
 * ready request before any cache reuse is allowed.
 *
 * Version counter invalidates stale inflight requests after eviction.
 *
 * Load generation: each `beginSessionMessageLoad` bumps a per-entry epoch.
 * Failures and successes must pass that epoch so a slower concurrent load
 * cannot paint `error` (or overwrite ready) while a newer load is in flight —
 * the session-switch path starts imperative + reactive pulls that otherwise
 * flash `chat.history.loadFailedTitle` mid-retry.
 */

import { getRuntimeKey } from "@/lib/runtime-switch"
import type { SessionHistoryBoundary } from "./types"

const SESSION_PREFETCH_TTL = 15_000

/**
 * Request-lifecycle entry for one (runtime, directory, session) message pull.
 * Contains no pagination facts: no cursor, no completeness, no loaded turns.
 */
export type SessionPrefetchMeta = {
  /**
   * Product **turn** budget requested by the newest load (authored-user
   * turns), not messages and not cumulative history. Request semantics only —
   * the child-store boundary owns cumulative loaded turns.
   */
  requestedLimit: number
  /** Last successful request time; `0` encodes dirty (refresh required). */
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

/**
 * Check if a prefetch/sync can be skipped (recently fetched).
 *
 * `boundary` is the directory child store's authoritative history boundary:
 * - `unknown` can never reuse the cache — cached user messages with no known
 *   boundary must trigger one authoritative tail refresh.
 * - `exhausted` may reuse while the request is fresh (ready, in TTL, not
 *   dirty); without freshness info the caller keeps the known UI but must
 *   still perform a background refresh, so this returns false.
 * - `has-more` additionally requires the boundary's cumulative `loadedTurns`
 *   to cover the requested `pageSize` before TTL reuse applies.
 */
export function shouldSkipSessionPrefetch(input: {
  hasSession: boolean
  hasMessages: boolean
  info?: SessionPrefetchMeta
  boundary?: SessionHistoryBoundary
  pageSize: number
  now?: number
}): boolean {
  if (!input.hasSession) {
    return false
  }

  if (!input.hasMessages) {
    return false
  }

  if (!input.boundary || input.boundary.kind === "unknown") {
    return false
  }

  const info = input.info
  // A known boundary without a fresh ready request still refreshes in the
  // background; the caller keeps the known UI facts from the store boundary.
  if (!info) return false
  // Dirty encoding: at=0. It pierces TTL so a previously fresh request still
  // refreshes after markSessionPrefetchDirty.
  if (info.at === 0) return false
  if (info.status !== "ready") return false
  if (input.boundary.kind === "exhausted") return true
  if (input.boundary.loadedTurns > input.pageSize) return true
  if (input.boundary.loadedTurns < input.pageSize) return false
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
    requestedLimit: Math.max(current?.requestedLimit ?? 0, requestedLimit),
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
    requestedLimit: current?.requestedLimit ?? 0,
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

/**
 * Record a settled (ready) request. Lifecycle only — the caller must already
 * have committed the authoritative history boundary into the directory child
 * store in the same setState as message/part.
 */
export function setSessionPrefetch(input: {
  directory: string
  sessionID: string
  runtimeKey?: string
  /** Turn budget this request asked for (request semantics, not history). */
  requestedLimit: number
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
    requestedLimit: input.requestedLimit,
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
 * `at=0` forces the next cache check to refresh the tail while the child-store
 * boundary keeps history availability immediately usable through live tail
 * updates. No-op when the session was never prefetched.
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
