/**
 * Event-stream liveness for send/refresh self-heal.
 *
 * SyncProvider notes transport activity and binds the pipeline reconnect.
 * Send must not trust `isConnected` after a long gap: a half-open socket can
 * stay "connected" while prompt HTTP hangs and no reconnect UI appears.
 */

export const STREAM_STALE_MS = 40_000

let lastActivityAt = 0
let reconnect: ((reason?: string) => void) | null = null

export function noteStreamActivity(at = Date.now()): void {
  lastActivityAt = at
}

export function getLastStreamActivityAt(): number {
  return lastActivityAt
}

export function bindStreamReconnect(fn: (reason?: string) => void): () => void {
  reconnect = fn
  return () => {
    if (reconnect === fn) reconnect = null
  }
}

export function requestStreamReconnect(reason: string): void {
  reconnect?.(reason)
}

export function isStreamActivityStale(
  now = Date.now(),
  staleMs: number = STREAM_STALE_MS,
): boolean {
  if (lastActivityAt <= 0) return false
  return now - lastActivityAt >= staleMs
}

/** Test-only: reset module state between cases. */
export function resetStreamLivenessForTests(): void {
  lastActivityAt = 0
  reconnect = null
}
