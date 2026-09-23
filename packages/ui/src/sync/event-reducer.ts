import type { Session, SessionStatus, Todo } from '@/lib/opencode/v2-types'
import type { Event, Project } from '@/sync/types'
import type { PermissionRequest } from '@/types/permission'
import type { QuestionRequest } from '@/types/question'

import { isVisibleGlobalSession } from "@/stores/globalSessions"
import { Binary } from "./binary"
import type { FileDiff, GlobalState, State } from "./types"
import { dropSessionCaches } from "./session-cache"
import { stripSessionDiffSnapshots, summarizeFileDiffs } from "./sanitize"
import { shouldSkipStaleSessionEvent } from "./session-event-freshness"
import { mapV2PermissionRequest, mapV2QuestionRequest } from "./v2-runtime"

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === "string")
}

/** Guard v2/legacy permission.asked properties onto PermissionRequest. */
export function permissionRequestFromEventProperties(properties: unknown): PermissionRequest | null {
  const record = asRecord(properties)
  if (!record) return null
  const id = asNonEmptyString(record.id)
  const sessionID = asNonEmptyString(record.sessionID) ?? asNonEmptyString(record.sessionId)
  const action = asNonEmptyString(record.permission) ?? asNonEmptyString(record.action)
  if (!id || !sessionID || !action) return null
  const source = asRecord(record.source) ?? asRecord(record.tool)
  const patterns = asStringArray(record.patterns)
  const resources = asStringArray(record.resources)
  const always = asStringArray(record.always)
  const save = asStringArray(record.save)
  return mapV2PermissionRequest({
    id,
    sessionID,
    action,
    resources: patterns.length > 0 ? patterns : resources,
    save: always.length > 0 ? always : save,
    metadata: asRecord(record.metadata) ?? {},
    source: source
      ? {
        messageID: asNonEmptyString(source.messageID),
        id: asNonEmptyString(source.callID) ?? asNonEmptyString(source.id),
      }
      : undefined,
  })
}

/** Guard v2/legacy question.asked properties onto QuestionRequest. */
export function questionRequestFromEventProperties(properties: unknown): QuestionRequest | null {
  const record = asRecord(properties)
  if (!record) return null
  const id = asNonEmptyString(record.id)
  const sessionID = asNonEmptyString(record.sessionID) ?? asNonEmptyString(record.sessionId)
  if (!id || !sessionID) return null
  const rawQuestions = Array.isArray(record.questions) ? record.questions : []
  const questions = rawQuestions.flatMap((item) => {
    const question = asRecord(item)
    if (!question) return []
    const options = Array.isArray(question.options)
      ? question.options.flatMap((option) => {
        const rec = asRecord(option)
        if (!rec) return []
        const label = asNonEmptyString(rec.label)
        if (!label) return []
        return [{
          label,
          description: typeof rec.description === "string" ? rec.description : "",
        }]
      })
      : []
    return [{
      question: asNonEmptyString(question.question) ?? "",
      header: asNonEmptyString(question.header) ?? "",
      options,
      ...(question.multiple === true ? { multiple: true } : {}),
    }]
  })
  const tool = asRecord(record.tool)
  return mapV2QuestionRequest({
    id,
    sessionID,
    questions,
    tool: tool
      ? {
        messageID: asNonEmptyString(tool.messageID),
        id: asNonEmptyString(tool.callID) ?? asNonEmptyString(tool.id),
      }
      : undefined,
  })
}

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

function assignSessionExecutionRecovery(
  draft: State,
  sessionID: string,
  value: { reason: "shutdown"; observedAt: number },
): boolean {
  const current = draft.session_execution_recovery?.[sessionID]
  if (
    current
    && current.reason === value.reason
    && current.observedAt === value.observedAt
  ) {
    return false
  }
  draft.session_execution_recovery = {
    ...draft.session_execution_recovery,
    [sessionID]: value,
  }
  return true
}

function clearSessionExecutionRecovery(draft: State, sessionID: string): boolean {
  if (draft.session_execution_recovery?.[sessionID] === undefined) return false
  const next = { ...draft.session_execution_recovery }
  delete next[sessionID]
  draft.session_execution_recovery = next
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

/** OpenCode 2 `session.created` / `session.updated` carry only ids, no `info`. */
function readSessionEventInfo(event: Event): Session | undefined {
  const info = (event.properties as { info?: unknown } | undefined)?.info
  if (!info || typeof info !== "object") return undefined
  return typeof (info as { id?: unknown }).id === "string" ? info as Session : undefined
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
      const rawInfo = readSessionEventInfo(event)
      if (!rawInfo) return false
      const info = stripSessionDiffSnapshots(rawInfo)
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
      const rawInfo = readSessionEventInfo(event)
      if (!rawInfo) return false
      const info = stripSessionDiffSnapshots(rawInfo)
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
      {
        const archivedAt = info.time?.archived
        const isArchived = typeof archivedAt === "number" && Number.isFinite(archivedAt) && archivedAt > 0
        if (!isVisibleGlobalSession(info) || isArchived) {
          return removeFromLiveDirectoryList(draft, info, result, callbacks?.onSetSessionTodo)
        }
      }

      if (result.found) {
        sessions[result.index] = info
      } else {
        sessions.splice(result.index, 0, info)
        trimSessions(draft)
      }
      return true
    }

    // Host session-metadata store: replace metadata on an already-known session.
    // Do not create rows when the session is absent. A later isolation patch
    // (scheduled-task / assistant / llm) must hide the row the same way
    // session.updated does — otherwise a create-before-persist race stays visible.
    case "openchamber:session-metadata": {
      const props = event.properties as { sessionID?: string; metadata?: Session["metadata"] }
      const sessionID = typeof props.sessionID === "string" ? props.sessionID : ""
      if (!sessionID || props.metadata === undefined) return false
      const sessions = draft.session
      const result = Binary.search(sessions, sessionID, (s) => s.id)
      if (!result.found) return false
      const next = {
        ...sessions[result.index],
        metadata: props.metadata,
      }
      sessions[result.index] = next
      if (!isVisibleGlobalSession(next)) {
        return removeFromLiveDirectoryList(draft, next, result, callbacks?.onSetSessionTodo)
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
      // Authoritative status snapshot ends shutdown-recovery pending.
      const recoveryCleared = clearSessionExecutionRecovery(draft, props.sessionID)
      if (callbacks?.now) draft.session_status_observed_at[props.sessionID] = callbacks.now()
      if (areSessionStatusesEqual(draft.session_status[props.sessionID], props.status)) {
        return Boolean(callbacks?.now) || errorChanged || recoveryCleared
      }
      draft.session_status[props.sessionID] = props.status
      return true
    }

    case "session.idle": {
      const props = event.properties as { sessionID: string }
      callbacks?.onServerSessionIdle?.(props.sessionID)
      const recoveryCleared = clearSessionExecutionRecovery(draft, props.sessionID)
      const status = { type: "idle" } as const
      if (callbacks?.now) draft.session_status_observed_at[props.sessionID] = callbacks.now()
      if (areSessionStatusesEqual(draft.session_status[props.sessionID], status)) {
        return Boolean(callbacks?.now) || recoveryCleared
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

    case "session.execution.started": {
      // Authoritative new-run signal (v2 busy). Clear the previous turn's
      // session_error_at the same way session.status busy/retry does, so a
      // retry does not keep showing the prior failure.
      const props = event.properties as { sessionID: string }
      const status = { type: "busy" } as const
      const errorChanged = clearSessionErrorAt(draft, props.sessionID)
      const recoveryCleared = clearSessionExecutionRecovery(draft, props.sessionID)
      if (callbacks?.now) draft.session_status_observed_at[props.sessionID] = callbacks.now()
      if (areSessionStatusesEqual(draft.session_status[props.sessionID], status)) {
        return Boolean(callbacks?.now) || errorChanged || recoveryCleared
      }
      draft.session_status[props.sessionID] = status
      return true
    }

    case "session.execution.succeeded": {
      const props = event.properties as { sessionID: string }
      // Same release path as legacy session.idle / status idle — queue abort
      // blocks and idle materialization hooks depend on this callback.
      callbacks?.onServerSessionIdle?.(props.sessionID)
      const recoveryCleared = clearSessionExecutionRecovery(draft, props.sessionID)
      const status = { type: "idle" } as const
      if (callbacks?.now) draft.session_status_observed_at[props.sessionID] = callbacks.now()
      if (areSessionStatusesEqual(draft.session_status[props.sessionID], status)) {
        return Boolean(callbacks?.now) || recoveryCleared
      }
      draft.session_status[props.sessionID] = status
      return true
    }

    case "session.execution.interrupted": {
      // Official reason: user | shutdown | superseded | inactivity.
      // Shutdown keeps the execution claim for restart recovery — do not open
      // queue/auto-continue gates (onServerSessionIdle) and surface recovery.
      const props = event.properties as {
        sessionID: string
        reason?: "user" | "shutdown" | "superseded" | "inactivity" | string
      }
      const reason = props.reason
      const now = callbacks?.now?.()
      if (now !== undefined) draft.session_status_observed_at[props.sessionID] = now

      if (reason === "shutdown") {
        const status = { type: "busy" } as const
        const recoveryChanged = assignSessionExecutionRecovery(draft, props.sessionID, {
          reason: "shutdown",
          observedAt: now ?? Date.now(),
        })
        // Keep busy so UI is not a permanent false idle; recovery marker
        // distinguishes restart-pending from a live running turn.
        if (areSessionStatusesEqual(draft.session_status[props.sessionID], status)) {
          return recoveryChanged || now !== undefined
        }
        draft.session_status[props.sessionID] = status
        return true
      }

      callbacks?.onServerSessionIdle?.(props.sessionID)
      const recoveryCleared = clearSessionExecutionRecovery(draft, props.sessionID)
      const status = { type: "idle" } as const
      if (areSessionStatusesEqual(draft.session_status[props.sessionID], status)) {
        return recoveryCleared || now !== undefined
      }
      draft.session_status[props.sessionID] = status
      return true
    }

    case "session.execution.failed": {
      // v2 terminal failure (e.g. Agent not found). Same idle settle as
      // session.error, plus session_error_at so live UI can show the reason
      // when no assistant row is produced.
      const props = event.properties as { sessionID: string; error?: unknown }
      callbacks?.onServerSessionIdle?.(props.sessionID)
      const status = { type: "idle" } as const
      const now = callbacks?.now?.()
      if (now !== undefined) draft.session_status_observed_at[props.sessionID] = now
      const errorChanged = now !== undefined ? assignSessionErrorAt(draft, props.sessionID, now) : false
      const recoveryCleared = clearSessionExecutionRecovery(draft, props.sessionID)
      if (areSessionStatusesEqual(draft.session_status[props.sessionID], status)) {
        return now !== undefined || errorChanged || recoveryCleared
      }
      draft.session_status[props.sessionID] = status
      return true
    }

    case "session.revert.staged": {
      const props = event.properties as {
        sessionID?: string
        revert?: { messageID?: string; partID?: string }
      }
      const sessionID = typeof props.sessionID === "string" ? props.sessionID : undefined
      const messageID = typeof props.revert?.messageID === "string" ? props.revert.messageID : undefined
      if (!sessionID || !messageID) return false
      const sessions = draft.session
      const result = Binary.search(sessions, sessionID, (s) => s.id)
      if (!result.found) return false
      const current = sessions[result.index]!
      const nextRevert = {
        messageID,
        ...(typeof props.revert?.partID === "string" ? { partID: props.revert.partID } : {}),
      }
      const prev = current.revert
      if (
        prev
        && prev.messageID === nextRevert.messageID
        && (prev as { partID?: string }).partID === nextRevert.partID
      ) {
        return false
      }
      sessions[result.index] = { ...current, revert: nextRevert } as typeof current
      return true
    }

    case "session.revert.cleared":
    case "session.revert.committed": {
      // Catalog marker only. Transcript truncation + read retirement live in
      // TranscriptRepository (`session.revert.committed` SSE / revert-committed).
      const props = event.properties as { sessionID?: string }
      const sessionID = typeof props.sessionID === "string" ? props.sessionID : undefined
      if (!sessionID) return false
      const sessions = draft.session
      const result = Binary.search(sessions, sessionID, (s) => s.id)
      if (!result.found) return false
      const current = sessions[result.index]!
      if (!current.revert) return false
      sessions[result.index] = { ...current, revert: undefined } as typeof current
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
      const branch = asNonEmptyString(asRecord(event.properties)?.branch)
      if (!branch) return false
      if (draft.vcs?.branch?.current === branch) return false
      draft.vcs = {
        ...draft.vcs,
        branch: { ...draft.vcs?.branch, current: branch },
      }
      return true
    }

    case "permission.asked": {
      const permission = permissionRequestFromEventProperties(event.properties)
      if (!permission) return false
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
      const question = questionRequestFromEventProperties(event.properties)
      if (!question) return false
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
