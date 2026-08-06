import type { SessionStatus, Message, Part } from "@opencode-ai/sdk/v2/client"
import type { Session } from "@opencode-ai/sdk/v2"
import { getSessionMaterializationStatus } from "./materialization"
import type { SessionHistoryBoundary } from "./types"

type ReconnectMaterializationState = {
  session: Session[]
  session_status?: Record<string, SessionStatus>
  message?: Record<string, Message[]>
  part?: Record<string, Part[]>
  session_history_boundary?: Record<string, SessionHistoryBoundary>
}

/**
 * Sessions whose cached transcript state must be invalidated on a real
 * reconnect / transport switch: the union of cached message keys and
 * history-boundary keys, deduped. Runs once per reconnect per initialized
 * directory — O(cached sessions), never per event. The boundary itself is
 * preserved (last known UI facts); only request freshness is dirtied so the
 * next visit performs one authoritative tail refresh instead of reusing a
 * gap-stale cache.
 */
export function getReconnectTranscriptInvalidationSessionIds(
  state: Pick<ReconnectMaterializationState, "message" | "session_history_boundary">,
): string[] {
  const ids = new Set<string>()
  for (const sessionId of Object.keys(state.message ?? {})) {
    if (sessionId) ids.add(sessionId)
  }
  for (const sessionId of Object.keys(state.session_history_boundary ?? {})) {
    if (sessionId) ids.add(sessionId)
  }
  return Array.from(ids)
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
  // Viewed-session body recovery needs only a directory match. Do not require the
  // session to already appear in the reconnect candidate list or child store —
  // stale/empty local state is exactly when authoritative recovery is needed.
  // Background sessions never materialize here (candidates are intentionally unused).
  const viewed = options?.viewedSession
  if (!viewed?.sessionId || viewed.directory !== options?.directory) return []
  return [viewed.sessionId]
}

export function getReconnectCandidateSessionIds(state: ReconnectMaterializationState, options?: ReconnectCandidateOptions) {
  const ids = new Set<string>()

  for (const [sessionId, status] of Object.entries(state.session_status ?? {})) {
    if (status && status.type !== "idle") ids.add(sessionId)
  }

  for (const [sessionId, messages] of Object.entries(state.message ?? {})) {
    const lastMessage = messages[messages.length - 1]
    if (
      lastMessage
      && lastMessage.role === "assistant"
      && typeof (lastMessage as { time?: { completed?: number } }).time?.completed !== "number"
    ) {
      ids.add(sessionId)
    } else if (!getSessionMaterializationStatus({ message: state.message ?? {}, part: state.part ?? {} }, sessionId).renderable) {
      ids.add(sessionId)
    }
  }

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
      || Object.hasOwn(state.message ?? {}, sessionId)

    if (sessionExists) {
      ids.add(sessionId)
    }
  }

  return Array.from(ids)
}
