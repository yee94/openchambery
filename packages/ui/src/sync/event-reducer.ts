import type {
  Event,
  PermissionRequest,
  Project,
  QuestionRequest,
  Session,
  SessionStatus,
  Todo,
} from "@opencode-ai/sdk/v2/client"
import { isVisibleGlobalSession } from "@/stores/globalSessions"
import { Binary } from "./binary"
import type { FileDiff, GlobalState, State } from "./types"
import { dropSessionCaches } from "./session-cache"
import { stripSessionDiffSnapshots, summarizeFileDiffs } from "./sanitize"
import { shouldSkipStaleSessionEvent } from "./session-event-freshness"

function assignSessionErrorAt(draft: State, sessionID: string, at: number): boolean {
  if (draft.session_error_at?.[sessionID] === at) return false
  draft.session_error_at = { ...draft.session_error_at, [sessionID]: at }
  return true
}

function clearSessionErrorAt(draft: State, sessionID: string): boolean {
  if (draft.session_error_at?.[sessionID] === undefined) return false
  const next = { ...draft.session_error_at }
  delete next[sessionID]
  draft.session_error_at = next
  return true
}

function areSessionStatusesEqual(left: SessionStatus | undefined, right: SessionStatus): boolean {
  if (left === right) return true
  if (!left || left.type !== right.type) return false
  if (left.type === "retry") {
    return right.type === "retry"
      && left.attempt === right.attempt
      && left.message === right.message
      && left.next === right.next
  }
  return true
}

// ---------------------------------------------------------------------------
// Global events
// ---------------------------------------------------------------------------

export type GlobalEventResult = {
  type: "refresh"
} | {
  type: "project"
  project: Project
} | null

export type SessionMaterializationReason =
  | "missing-owning-message"
  | "orphan-delta"
  | "missing-delta-part"
  | "child-session-idle"
  | "session-idle"
  | "child-session-discovered"
  | "ensure-session-messages"
  | "stream-reconnect"
  | "transport-switch"
  | "stale-status-resync"
  | "domain-stale-resync"
  | "manual-refresh"

export type DirectoryEventResult = boolean | {
  changed: boolean
  materialization: {
    type: "incomplete-session-snapshot"
    reason: SessionMaterializationReason
    sessionID?: string
    messageID: string
    partID?: string
  }
}

export function reduceGlobalEvent(event: Event): GlobalEventResult {
  if (event.type === "global.disposed" || event.type === "server.connected") {
    return { type: "refresh" }
  }
  if (event.type === "project.updated") {
    return { type: "project", project: event.properties as Project }
  }
  return null
}

export function applyGlobalProject(state: GlobalState, project: Project): GlobalState {
  const projects = [...state.projects]
  const result = Binary.search(projects, project.id, (s) => s.id)
  if (result.found) {
    projects[result.index] = { ...projects[result.index], ...project }
  } else {
    projects.splice(result.index, 0, project)
  }
  return { ...state, projects }
}

// ---------------------------------------------------------------------------
// Directory events — mutates draft in place for batching efficiency.
// Caller MUST pass a mutable copy of State (e.g. structuredClone or spread).
// ---------------------------------------------------------------------------

function cleanupSessionCaches(
  draft: State,
  sessionID: string,
  setSessionTodo?: (sessionID: string, todos: Todo[] | undefined) => void,
) {
  if (!sessionID) return
  setSessionTodo?.(sessionID, undefined)
  dropSessionCaches(draft, [sessionID])
}

/** Temporary SmartFetch model calls — safe to wipe when they leave the live list. */
const shouldWipeCachesWhenHiddenFromList = (session: Session): boolean =>
  session.title === "smartfetch-secondary"

/**
 * Remove a session from the live directory list without destroying its message
 * stream unless it is a temporary SmartFetch secondary. Viewers of archived /
 * system / subagent sessions keep SSE deltas after HTTP hydrate.
 */
function removeFromLiveDirectoryList(
  draft: State,
  info: Session,
  result: { found: boolean; index: number },
  setSessionTodo?: (sessionID: string, todos: Todo[] | undefined) => void,
): boolean {
  // Never entered the live list — no list mutation. Message caches stay
  // (viewers may already be streaming into them via open-by-id).
  if (!result.found) return false
  draft.session.splice(result.index, 1)
  // Temporary SmartFetch secondaries must not leave message/part residue after
  // a flash insert; system/subagent/archived keep their stream caches.
  if (shouldWipeCachesWhenHiddenFromList(info)) {
    cleanupSessionCaches(draft, info.id, setSessionTodo)
  }
  if (!info.parentID) draft.sessionTotal = Math.max(0, draft.sessionTotal - 1)
  return true
}

export function applyDirectoryEvent(
  draft: State,
  event: Event,
  callbacks?: {
    onRefresh?: (directory: string) => void
    onLoadLsp?: () => void
    onSetSessionTodo?: (sessionID: string, todos: Todo[] | undefined) => void
    onServerSessionIdle?: (sessionID: string) => void
    now?: () => number
  },
): DirectoryEventResult {
  switch (event.type) {
    case "server.instance.disposed": {
      callbacks?.onRefresh?.("")
      return false
    }

    case "session.created": {
      const info = stripSessionDiffSnapshots((event.properties as { info: Session }).info)
      const sessions = draft.session
      const result = Binary.search(sessions, info.id, (s) => s.id)
      // Catalog hide ≠ message-cache lifetime. System/subagent/archived sessions
      // stay off the live directory list but keep streaming caches while open.
      // Only temporary SmartFetch secondaries wipe caches when they leave the list.
      if (!isVisibleGlobalSession(info)) {
        return removeFromLiveDirectoryList(draft, info, result, callbacks?.onSetSessionTodo)
      }
      if (result.found && shouldSkipStaleSessionEvent(sessions[result.index], info)) {
        return false
      }
      if (result.found) {
        sessions[result.index] = info
      } else {
        sessions.splice(result.index, 0, info)
        trimSessions(draft)
        if (!info.parentID) draft.sessionTotal += 1
      }
      return true
    }

    case "session.updated": {
      const info = stripSessionDiffSnapshots((event.properties as { info: Session }).info)
      const sessions = draft.session
      const result = Binary.search(sessions, info.id, (s) => s.id)
      // Keep the freshness check ahead of the archive branch: direct archive
      // responses handle the store update on their own (optimistic removal +
      // SDK response), so stale SSE echoes should not win just because they
      // mark the session archived.
      if (result.found && shouldSkipStaleSessionEvent(sessions[result.index], info)) {
        return false
      }

      // Sidebar/live-list hide only. Do not drop message/part/status for
      // system-owned, subagent, or archived sessions — scheduled tasks and
      // assistants archive before/while prompting, and wiping caches is what
      // made in-progress viewing look nothing like a normal live session.
      if (!isVisibleGlobalSession(info) || info.time.archived) {
        return removeFromLiveDirectoryList(draft, info, result, callbacks?.onSetSessionTodo)
      }

      if (result.found) {
        sessions[result.index] = info
      } else {
        sessions.splice(result.index, 0, info)
        trimSessions(draft)
      }
      return true
    }

    case "session.deleted": {
      const info = (event.properties as { info: Session }).info
      const sessions = draft.session
      const result = Binary.search(sessions, info.id, (s) => s.id)
      if (result.found) sessions.splice(result.index, 1)
      cleanupSessionCaches(draft, info.id, callbacks?.onSetSessionTodo)
      if (!info.parentID) draft.sessionTotal = Math.max(0, draft.sessionTotal - 1)
      return true
    }

    case "session.diff": {
      const props = event.properties as { sessionID: string; diff: FileDiff[] }
      draft.session_diff[props.sessionID] = summarizeFileDiffs(props.diff)
      return true
    }

    case "todo.updated": {
      const props = event.properties as { sessionID: string; todos: Todo[] }
      draft.todo[props.sessionID] = props.todos
      callbacks?.onSetSessionTodo?.(props.sessionID, props.todos)
      return true
    }

    case "session.status": {
      const props = event.properties as { sessionID: string; status: SessionStatus }
      if (props.status.type === "idle") {
        callbacks?.onServerSessionIdle?.(props.sessionID)
      }
      let errorChanged = false
      if (props.status.type === "busy" || props.status.type === "retry") {
        errorChanged = clearSessionErrorAt(draft, props.sessionID)
      }
      if (callbacks?.now) draft.session_status_observed_at[props.sessionID] = callbacks.now()
      if (areSessionStatusesEqual(draft.session_status[props.sessionID], props.status)) {
        return Boolean(callbacks?.now) || errorChanged
      }
      draft.session_status[props.sessionID] = props.status
      return true
    }

    case "session.idle": {
      const props = event.properties as { sessionID: string }
      callbacks?.onServerSessionIdle?.(props.sessionID)
      const status = { type: "idle" } as const
      if (callbacks?.now) draft.session_status_observed_at[props.sessionID] = callbacks.now()
      if (areSessionStatusesEqual(draft.session_status[props.sessionID], status)) {
        return callbacks?.now ? true : false
      }
      draft.session_status[props.sessionID] = status
      return true
    }

    case "session.error": {
      const props = event.properties as { sessionID: string }
      callbacks?.onServerSessionIdle?.(props.sessionID)
      const status = { type: "idle" } as const
      const now = callbacks?.now?.()
      if (now !== undefined) draft.session_status_observed_at[props.sessionID] = now
      const errorChanged = now !== undefined ? assignSessionErrorAt(draft, props.sessionID, now) : false
      if (areSessionStatusesEqual(draft.session_status[props.sessionID], status)) {
        return now !== undefined || errorChanged
      }
      draft.session_status[props.sessionID] = status
      return true
    }

    // Ticket 09 batch 2: transcript SSE (message/part) is owned by
    // transcript-event-reducer + Query repository apply. Production event-reducer
    // only mutates non-transcript directory domains.
    case "message.updated":
    case "message.removed":
    case "message.part.updated":
    case "message.part.removed":
    case "message.part.delta":
      return false

    case "vcs.branch.updated": {
      const props = event.properties as { branch: string }
      if (draft.vcs?.branch === props.branch) return false
      draft.vcs = { branch: props.branch }
      return true
    }

    case "permission.asked": {
      const permission = event.properties as PermissionRequest
      const permissions = draft.permission[permission.sessionID] ?? []
      const next = [...permissions]
      const result = Binary.search(next, permission.id, (p) => p.id)
      if (result.found) {
        next[result.index] = permission
      } else {
        next.splice(result.index, 0, permission)
      }
      draft.permission[permission.sessionID] = next
      return true
    }

    case "permission.replied": {
      const props = event.properties as { sessionID: string; requestID: string }
      const permissions = draft.permission[props.sessionID]
      if (!permissions) return false
      const result = Binary.search(permissions, props.requestID, (p) => p.id)
      if (result.found) {
        const next = [...permissions]
        next.splice(result.index, 1)
        draft.permission[props.sessionID] = next
        return true
      }
      return false
    }

    case "question.asked": {
      const question = event.properties as QuestionRequest
      const questions = draft.question[question.sessionID] ?? []
      const next = [...questions]
      const result = Binary.search(next, question.id, (q) => q.id)
      if (result.found) {
        next[result.index] = question
      } else {
        next.splice(result.index, 0, question)
      }
      draft.question[question.sessionID] = next
      return true
    }

    case "question.replied":
    case "question.rejected": {
      const props = event.properties as { sessionID: string; requestID: string }
      const questions = draft.question[props.sessionID]
      if (!questions) return false
      const result = Binary.search(questions, props.requestID, (q) => q.id)
      if (result.found) {
        const next = [...questions]
        next.splice(result.index, 1)
        draft.question[props.sessionID] = next
        return true
      }
      return false
    }

    case "lsp.updated": {
      callbacks?.onLoadLsp?.()
      return false
    }

    default:
      return false
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function trimSessions(draft: State) {
  if (draft.session.length <= draft.limit) return
  // Keep sessions that have pending permissions (they need to stay visible)
  const hasPermission = new Set(
    Object.entries(draft.permission ?? {})
      .filter(([, perms]) => perms && perms.length > 0)
      .map(([sessionID]) => sessionID),
  )
  while (draft.session.length > draft.limit) {
    // Remove from the beginning (oldest by sorted ID)
    const candidate = draft.session[0]
    if (hasPermission.has(candidate.id)) break
    draft.session.shift()
  }
}
