/**
 * Enter-and-sync authority-revalidate window.
 *
 * A successful authority tail (initial or hot reconcile) stamps
 * `(transport, generation, directory, sessionID)`. The next enter inside
 * this window reuses the hot cache and does not start another pull.
 * Failures and skipped pulls never stamp, so they cannot suppress a retry.
 */

import {
  getRuntimeGeneration,
  getRuntimeTransportIdentity,
} from "@/lib/runtime-switch"

export const SESSION_AUTHORITY_REVALIDATE_WINDOW_MS = 30_000

const MAX_WINDOW_ENTRIES = 200

const lastSuccessAt = new Map<string, number>()

function sessionAuthorityRevalidateKey(
  directory: string,
  sessionID: string,
  identity?: { transport?: string; generation?: number },
): string {
  const transport = identity?.transport ?? getRuntimeTransportIdentity()
  const generation = identity?.generation ?? getRuntimeGeneration()
  return `${transport}\n${generation}\n${directory.trim()}\n${sessionID}`
}

export function isSessionAuthorityRevalidateFresh(
  directory: string,
  sessionID: string,
  options?: { now?: number; transport?: string; generation?: number },
): boolean {
  if (!directory || !sessionID) return false
  const stamped = lastSuccessAt.get(sessionAuthorityRevalidateKey(directory, sessionID, options))
  if (stamped === undefined) return false
  return (options?.now ?? Date.now()) - stamped < SESSION_AUTHORITY_REVALIDATE_WINDOW_MS
}

export function markSessionAuthorityRevalidated(
  directory: string,
  sessionID: string,
  options?: { now?: number; transport?: string; generation?: number },
): void {
  if (!directory || !sessionID) return
  const key = sessionAuthorityRevalidateKey(directory, sessionID, options)
  if (lastSuccessAt.has(key)) lastSuccessAt.delete(key)
  while (lastSuccessAt.size >= MAX_WINDOW_ENTRIES) {
    const oldest = lastSuccessAt.keys().next().value
    if (typeof oldest !== "string") break
    lastSuccessAt.delete(oldest)
  }
  lastSuccessAt.set(key, options?.now ?? Date.now())
}

export function clearSessionAuthorityRevalidateWindows(): void {
  lastSuccessAt.clear()
}
