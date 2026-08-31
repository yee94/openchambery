import type {
  PermissionRequest,
  QuestionRequest,
  SessionStatus,
  Todo,
} from "@opencode-ai/sdk/v2/client"
import type { FileDiff } from "./types"

type SessionCache = {
  session_status: Record<string, SessionStatus | undefined>
  session_status_observed_at?: Record<string, number | undefined>
  session_error_at?: Record<string, number | undefined>
  session_diff: Record<string, FileDiff[] | undefined>
  todo: Record<string, Todo[] | undefined>
  permission: Record<string, PermissionRequest[] | undefined>
  question: Record<string, QuestionRequest[] | undefined>
}

export function getProtectedSessionCacheIds(store: SessionCache): Set<string> {
  const protectedIds = new Set<string>()

  for (const [sessionID, status] of Object.entries(store.session_status ?? {})) {
    if (status && status.type !== "idle") {
      protectedIds.add(sessionID)
    }
  }

  for (const [sessionID, permissions] of Object.entries(store.permission ?? {})) {
    if ((permissions?.length ?? 0) > 0) {
      protectedIds.add(sessionID)
    }
  }

  for (const [sessionID, questions] of Object.entries(store.question ?? {})) {
    if ((questions?.length ?? 0) > 0) {
      protectedIds.add(sessionID)
    }
  }

  // Ticket 09 batch 2: incomplete-message heuristic removed — transcript is Query-owned.
  return protectedIds
}

/**
 * Drop non-transcript session-scoped caches (status/todo/permission/question/diff).
 * Transcript message/part/boundary live in QueryCache — callers must also
 * invoke `purgeTranscriptSession` for those domains.
 */
export function dropSessionCaches(store: SessionCache, sessionIDs: Iterable<string>) {
  const stale = new Set(Array.from(sessionIDs).filter(Boolean))
  if (stale.size === 0) return

  for (const sessionID of stale) {
    delete store.todo[sessionID]
    delete store.session_diff[sessionID]
    delete store.session_status[sessionID]
    if (store.session_status_observed_at) delete store.session_status_observed_at[sessionID]
    if (store.session_error_at) delete store.session_error_at[sessionID]
    delete store.permission[sessionID]
    delete store.question[sessionID]
  }
}

export function pickSessionCacheEvictions(input: {
  seen: Set<string>
  keep: string
  limit: number
  preserve?: Iterable<string>
}) {
  const stale: string[] = []
  const keep = new Set([input.keep, ...Array.from(input.preserve ?? [])])
  if (input.seen.has(input.keep)) input.seen.delete(input.keep)
  input.seen.add(input.keep)
  for (const id of input.seen) {
    if (input.seen.size - stale.length <= input.limit) break
    if (keep.has(id)) continue
    stale.push(id)
  }
  for (const id of stale) {
    input.seen.delete(id)
  }
  return stale
}
