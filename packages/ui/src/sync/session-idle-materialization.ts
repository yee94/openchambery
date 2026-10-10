/**
 * Settle retained, previously loaded transcripts at completion, including
 * off-screen sessions. Cold sessions defer the GET until they are viewed.
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
  hasLoadedTranscript?: boolean
}): SessionIdleMaterializationPlan {
  if (!input.idleSessionID || !input.directory || input.directory === "global") {
    return { action: "none" }
  }
  if (input.parentID) {
    return { action: "materialize-parent", sessionID: input.parentID }
  }
  if (
    (input.idleSessionID === input.activeSessionID
    && input.directory === input.activeDirectory)
    || input.hasLoadedTranscript
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
