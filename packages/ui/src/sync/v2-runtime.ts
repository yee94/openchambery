/**
 * OpenCode v2 runtime helpers for the sync cutover.
 * Real client methods throw; missing capabilities fail closed.
 */

import type { LocationGetOutput, SessionStatus } from "@/lib/opencode/v2-types"
import { projectSession } from "@/lib/opencode/v2-types"
import type { PermissionRequest } from "@/types/permission"
import type { QuestionRequest } from "@/types/question"
import type { Path, Project } from "./types"

/**
 * Fail closed when v2 has no client method and no Host shallow-proxy module.
 * Callers must treat this as an observable error, not an empty success.
 */
export function v2CapabilityUnavailable(capability: string): Error {
  const error = new Error(`${capability} is not available on OpenCode v2`)
  error.name = "V2CapabilityUnavailableError"
  return error
}

export function isV2CapabilityUnavailable(error: unknown): boolean {
  return error instanceof Error && error.name === "V2CapabilityUnavailableError"
}

/** Map v2 `location.get` onto the Path fields directory stores already read. */
export function locationToPath(location: LocationGetOutput): Path {
  const directory = typeof location.directory === "string" ? location.directory : ""
  const worktree = typeof location.project?.directory === "string"
    ? location.project.directory
    : directory
  return {
    state: "",
    config: "",
    worktree,
    directory,
    home: "",
  }
}

/** Map a v2 project row so existing worktree/sandbox matchers still work. */
export function mapV2Project(project: {
  id: string
  canonical?: string
  sandboxes?: string[]
  name?: string
}): Project {
  return {
    id: project.id,
    worktree: project.canonical,
    canonical: project.canonical,
    sandboxes: project.sandboxes,
    name: project.name,
  }
}

export function projectWorktree(project: Project): string {
  return project.worktree || project.canonical || ""
}

/**
 * session.active is process-global. Only apply known directory-local IDs.
 * An empty known set means the catalog is not ready — do not invent IDs.
 */
export function activeMembershipToStatus(
  membership: Record<string, { type?: string } | undefined>,
  knownIDs: ReadonlySet<string>,
): Record<string, SessionStatus> {
  const snapshot: Record<string, SessionStatus> = {}
  if (knownIDs.size === 0) return snapshot
  for (const [id, active] of Object.entries(membership)) {
    if (!knownIDs.has(id)) continue
    if (active?.type === "running") snapshot[id] = { type: "busy" }
  }
  return snapshot
}

/** Map v2 permission.request rows onto the local PermissionRequest contract. */
export function mapV2PermissionRequest(item: {
  id: string
  sessionID: string
  action: string
  resources?: string[]
  save?: string[]
  metadata?: Record<string, unknown>
  source?: { messageID?: string; id?: string }
}): PermissionRequest {
  return {
    id: item.id,
    sessionID: item.sessionID,
    permission: item.action,
    patterns: Array.isArray(item.resources) ? item.resources : [],
    metadata: item.metadata ?? {},
    always: Array.isArray(item.save) ? item.save : [],
    ...(item.source?.messageID
      ? { tool: { messageID: item.source.messageID, callID: item.source.id ?? "" } }
      : {}),
  }
}

/** Map v2 question.request rows onto the local QuestionRequest contract. */
export function mapV2QuestionRequest(item: {
  id: string
  sessionID: string
  questions?: Array<{
    question: string
    header: string
    options: Array<{ label: string; description: string }>
    multiple?: boolean
  }>
  tool?: { messageID?: string; id?: string }
}): QuestionRequest {
  return {
    id: item.id,
    sessionID: item.sessionID,
    questions: (item.questions ?? []).map((question) => ({
      question: question.question,
      header: question.header,
      options: question.options ?? [],
      ...(question.multiple ? { multiple: true } : {}),
    })),
    ...(item.tool?.messageID
      ? { tool: { messageID: item.tool.messageID, callID: item.tool.id ?? "" } }
      : {}),
  }
}

export { projectSession }
