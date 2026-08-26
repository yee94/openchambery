import type { Part, Session } from "@opencode-ai/sdk/v2"

type BlockingRequest = { id: string }

// Task parts carry the authoritative dispatch join while a subagent task runs:
// `state.metadata.parentSessionId` / `sessionId`. When a parent session is
// forked and later reuses a prior task_id, the child session's `parentID` in
// the session catalog still points at the pre-fork session, so the catalog
// subtree alone misses the live dispatch edge and the subagent's pending
// question never surfaces in the dispatching session. These edges supplement
// the catalog subtree below.
export type TaskDispatchEdge = {
  parentSessionId: string
  sessionId: string
}

const readSessionIdCandidate = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

const readDispatchEdgeFromRecord = (value: unknown): TaskDispatchEdge | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const parentSessionId = readSessionIdCandidate(record.parentSessionId)
  const sessionId = readSessionIdCandidate(record.sessionId)
  if (!parentSessionId || !sessionId || parentSessionId === sessionId) return undefined
  return { parentSessionId, sessionId }
}

/**
 * Extract live subagent dispatch edges from a session's task tool parts.
 * A task part contributes an edge only while the task is running: completed
 * tasks no longer block the parent, and their historical edges would leak
 * unrelated requests into the scope forever.
 */
export const collectTaskDispatchEdgesFromParts = (parts: Part[]): TaskDispatchEdge[] => {
  const edges: TaskDispatchEdge[] = []
  for (const part of parts) {
    if (part?.type !== "tool" || part.tool !== "task") continue
    const state = (part as { state?: unknown }).state
    if (!state || typeof state !== "object" || Array.isArray(state)) continue
    const stateRecord = state as Record<string, unknown>
    if (stateRecord.status !== "running") continue
    const metadata = stateRecord.metadata
    const edge = readDispatchEdgeFromRecord(metadata)
    if (edge) edges.push(edge)
  }
  return edges
}

export const EMPTY_TASK_DISPATCH_EDGES: readonly TaskDispatchEdge[] = []

export const computeSubtreeIds = (
  sessions: Session[],
  rootId: string,
  dispatchEdges?: readonly TaskDispatchEdge[],
): Set<string> => {
  const childrenByParent = new Map<string, string[]>()
  for (const session of sessions) {
    if (!session.parentID) continue
    const list = childrenByParent.get(session.parentID) ?? []
    list.push(session.id)
    childrenByParent.set(session.parentID, list)
  }

  // Fork + task_id reuse can re-point a running task at a child whose catalog
  // parentID belongs to the pre-fork lineage. Seed adjacency with the live
  // dispatch edges so the walk still reaches the running subagent subtree.
  if (dispatchEdges) {
    for (const edge of dispatchEdges) {
      const list = childrenByParent.get(edge.parentSessionId) ?? []
      list.push(edge.sessionId)
      childrenByParent.set(edge.parentSessionId, list)
    }
  }

  const ids = new Set<string>([rootId])
  const queue = [rootId]
  for (const id of queue) {
    const children = childrenByParent.get(id)
    if (!children) continue
    for (const childId of children) {
      if (ids.has(childId)) continue
      ids.add(childId)
      queue.push(childId)
    }
  }
  return ids
}

export const areRequestArraysReferentiallyEqual = <T extends BlockingRequest>(left: T[], right: T[]): boolean => {
  if (left === right) return true
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

export const collectScopedBlockingRequests = <T extends BlockingRequest>(
  sessions: Session[],
  requestsBySession: Record<string, T[] | undefined>,
  sessionID: string | null,
  empty: T[],
  dispatchEdges?: readonly TaskDispatchEdge[],
): T[] => {
  if (!sessionID) return empty

  const scopedIds = computeSubtreeIds(sessions, sessionID, dispatchEdges)
  if (scopedIds.size === 0) return empty

  const seen = new Set<string>()
  const result: T[] = []
  for (const id of scopedIds) {
    const entries = requestsBySession[id]
    if (!entries) continue
    for (const entry of entries) {
      if (seen.has(entry.id)) continue
      seen.add(entry.id)
      result.push(entry)
    }
  }

  return result.length === 0 ? empty : result
}
