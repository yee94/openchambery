import type { SessionStatus } from "@opencode-ai/sdk/v2/client"
import type { Session } from "@opencode-ai/sdk/v2"

type ReconnectMaterializationState = {
  session: Session[]
  session_status?: Record<string, SessionStatus>
}

/**
 * Ticket 09 batch 2: transcript invalidation is owned by Query reconnect
 * compensation. This helper returns no store-message keys.
 */
export function getReconnectTranscriptInvalidationSessionIds(
  _state?: unknown,
): string[] {
  return []
}

type ViewedSessionMaterializationTarget = {
  directory: string
  sessionId: string
}

type ReconnectCandidateOptions = {
  directory?: string
  viewedSession?: ViewedSessionMaterializationTarget | null
}

export function getStatusWatchdogCandidateSessionIds(state: ReconnectMaterializationState): string[] {
  return Object.entries(state.session_status ?? {})
    .filter(([, status]) => status && status.type !== "idle")
    .map(([sessionId]) => sessionId)
}

export function getReconnectMaterializationSessionIds(
  _candidateSessionIds: string[],
  options?: ReconnectCandidateOptions,
): string[] {
  // Viewed-session body recovery needs only a directory match. Transcript
  // recovery is Query compensation ensureOnObserve / immediate set.
  const viewed = options?.viewedSession
  if (!viewed?.sessionId || viewed.directory !== options?.directory) return []
  return [viewed.sessionId]
}

export function getReconnectCandidateSessionIds(state: ReconnectMaterializationState, options?: ReconnectCandidateOptions) {
  const ids = new Set<string>()

  for (const [sessionId, status] of Object.entries(state.session_status ?? {})) {
    if (status && status.type !== "idle") ids.add(sessionId)
  }

  // Ticket 09 batch 2: no store message/part incomplete heuristics.
  // Parent sessions still need status-watch coverage when children are active.
  const parentIds = new Set<string>()
  for (const session of state.session) {
    const parentId = (session as Session & { parentID?: string | null }).parentID
    if (parentId) {
      parentIds.add(parentId)
    }
  }
  for (const pid of parentIds) {
    ids.add(pid)
  }

  const viewedSession = options?.viewedSession
  if (viewedSession?.sessionId && viewedSession.directory === options?.directory) {
    const sessionId = viewedSession.sessionId
    const sessionExists = state.session.some((session) => session.id === sessionId)
      || Object.hasOwn(state.session_status ?? {}, sessionId)

    if (sessionExists) {
      ids.add(sessionId)
    }
  }

  return Array.from(ids)
}
