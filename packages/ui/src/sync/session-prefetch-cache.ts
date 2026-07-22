/**
 * Session prefetch TTL cache — prevents redundant session fetches
 * within a short window. Port of OpenCode's session-prefetch.ts.
 *
 * Tracks: last fetch time, pagination cursor, completeness.
 * Version counter invalidates stale inflight requests after eviction.
 */

import { getRuntimeKey } from "@/lib/runtime-switch"

const SESSION_PREFETCH_TTL = 15_000

export type SessionPrefetchMeta = {
  limit: number
  cursor?: string
  complete: boolean
  at: number
  status: "loading" | "ready" | "error"
  error?: string
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
  if (info.status !== "ready") return false
  if (info.complete) return true
  if (info.limit > input.pageSize) return true
  if (info.limit < input.pageSize) return false
  return (input.now ?? Date.now()) - info.at < SESSION_PREFETCH_TTL
}

export function getSessionPrefetch(directory: string, sessionID: string, runtimeKey = getRuntimeKey()): SessionPrefetchMeta | undefined {
  return cache.get(compositeKey(directory, sessionID, runtimeKey))
}

export function beginSessionMessageLoad(directory: string, sessionID: string, requestedLimit: number, runtimeKey = getRuntimeKey()) {
  const id = compositeKey(directory, sessionID, runtimeKey)
  const current = cache.get(id)
  cache.set(id, {
    limit: Math.max(current?.limit ?? 0, requestedLimit),
    cursor: current?.cursor,
    complete: current?.complete ?? false,
    at: current?.at ?? Date.now(),
    status: "loading",
  })
  notify(id)
}

export function failSessionMessageLoad(directory: string, sessionID: string, error: string, runtimeKey = getRuntimeKey()) {
  const id = compositeKey(directory, sessionID, runtimeKey)
  const current = cache.get(id)
  cache.set(id, {
    limit: current?.limit ?? 0,
    cursor: current?.cursor,
    complete: current?.complete ?? false,
    at: current?.at ?? Date.now(),
    status: "error",
    error,
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
}) {
  const id = compositeKey(input.directory, input.sessionID, input.runtimeKey)
  cache.set(id, {
    limit: input.limit,
    cursor: input.cursor,
    complete: input.complete,
    at: input.at ?? Date.now(),
    status: "ready",
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
