/**
 * In-flight signal for user-triggered `refreshFromAuthority`.
 *
 * That path fetches outside the InfiniteQuery observer, so `getRequestState`
 * stays `ready` while the tail is replaced. Chat headers subscribe here to
 * show a WeChat-style sync hint without treating warm prefetch `isFetching`
 * (which can stick on Relay) as live work.
 */

const flights = new Set<string>()
const listeners = new Set<() => void>()

function flightKey(directory: string, sessionID: string): string {
  return `${directory}\n${sessionID}`
}

function emit(): void {
  for (const listener of listeners) listener()
}

export function beginTranscriptAuthorityRefresh(directory: string, sessionID: string): void {
  if (!directory || !sessionID) return
  flights.add(flightKey(directory, sessionID))
  emit()
}

export function endTranscriptAuthorityRefresh(directory: string, sessionID: string): void {
  if (!directory || !sessionID) return
  if (!flights.delete(flightKey(directory, sessionID))) return
  emit()
}

export function isTranscriptAuthorityRefreshInFlight(
  sessionID: string,
  directory?: string,
): boolean {
  if (!sessionID) return false
  if (directory) return flights.has(flightKey(directory, sessionID))
  const suffix = `\n${sessionID}`
  for (const key of flights) {
    if (key.endsWith(suffix)) return true
  }
  return false
}

export function subscribeTranscriptAuthorityRefresh(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
