/**
 * When a top-level session goes idle off-screen, do not GET its transcript
 * immediately. Remember it so the next view can run the same session-idle
 * materialize that the viewed session already uses to replace half-finished
 * reasoning with the completed snapshot (final body + collapsed thinking).
 */

export type SessionIdleMaterializationPlan =
  | { action: "materialize-parent"; sessionID: string }
  | { action: "materialize-now"; sessionID: string }
  | { action: "defer-until-viewed"; sessionID: string }
  | { action: "none" }

export function planSessionIdleMaterialization(input: {
  idleSessionID: string
  directory: string
  parentID?: string | null
  activeSessionID: string
  activeDirectory: string
}): SessionIdleMaterializationPlan {
  if (!input.idleSessionID || !input.directory || input.directory === "global") {
    return { action: "none" }
  }
  if (input.parentID) {
    return { action: "materialize-parent", sessionID: input.parentID }
  }
  if (
    input.idleSessionID === input.activeSessionID
    && input.directory === input.activeDirectory
  ) {
    return { action: "materialize-now", sessionID: input.idleSessionID }
  }
  return { action: "defer-until-viewed", sessionID: input.idleSessionID }
}

const deferredIdleTranscriptSettle = new Set<string>()

const settleKey = (directory: string, sessionID: string) => `${directory}\n${sessionID}`

export function deferIdleTranscriptSettle(directory: string, sessionID: string): void {
  if (!directory || directory === "global" || !sessionID) return
  deferredIdleTranscriptSettle.add(settleKey(directory, sessionID))
}

export function takeDeferredIdleTranscriptSettle(directory: string, sessionID: string): boolean {
  const key = settleKey(directory, sessionID)
  if (!deferredIdleTranscriptSettle.has(key)) return false
  deferredIdleTranscriptSettle.delete(key)
  return true
}

export function clearDeferredIdleTranscriptSettle(): void {
  deferredIdleTranscriptSettle.clear()
}

export function resetIdleTranscriptSettleForTests(): void {
  clearDeferredIdleTranscriptSettle()
}
