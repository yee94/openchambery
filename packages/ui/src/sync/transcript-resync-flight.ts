/**
 * In-flight signal for background transcript resync work.
 *
 * Reconnect recovery (viewed-session tail pull), reconnect compensation
 * (reconcile / ensure-tail / destructive reset), and stale-on-observe
 * ensureInitial all fetch outside the InfiniteQuery observer, so
 * `getRequestState` stays `ready` while the transcript chases the remote
 * state. Chat headers subscribe here so the sync whisper stays truthful for
 * warm sessions that already have a visible transcript.
 *
 * This signal means a KNOWN GAP is being chased (disconnect, background
 * resume, marked-stale session). Routine verification fetches — hot
 * revalidation and the observe-time head check — intentionally do NOT mark
 * it: while foregrounded the SSE stream merges every canonical scope live,
 * so those fetches almost never find a diff and whispering on them would
 * flash noise on every session switch.
 *
 * Multiple paths can overlap for one session (directory resync recovery pull
 * racing the compensation reconcile), so this registry reference-counts: the
 * signal clears only when the last overlapping flight ends. Every begin must
 * be paired with an end in a `finally` so failures cannot strand the hint.
 */

const flights = new Map<string, number>()
const listeners = new Set<() => void>()

function flightKey(directory: string, sessionID: string): string {
  return `${directory}\n${sessionID}`
}

function emit(): void {
  for (const listener of listeners) listener()
}

export function beginTranscriptResync(directory: string, sessionID: string): void {
  if (!directory || !sessionID) return
  const key = flightKey(directory, sessionID)
  const previous = flights.get(key) ?? 0
  flights.set(key, previous + 1)
  if (previous === 0) emit()
}

export function endTranscriptResync(directory: string, sessionID: string): void {
  if (!directory || !sessionID) return
  const key = flightKey(directory, sessionID)
  const previous = flights.get(key)
  if (!previous) return
  if (previous <= 1) {
    flights.delete(key)
    emit()
    return
  }
  flights.set(key, previous - 1)
}

export function isTranscriptResyncInFlight(
  sessionID: string,
  directory?: string,
): boolean {
  if (!sessionID) return false
  if (directory) return flights.has(flightKey(directory, sessionID))
  const suffix = `\n${sessionID}`
  for (const key of flights.keys()) {
    if (key.endsWith(suffix)) return true
  }
  return false
}

export function subscribeTranscriptResync(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
