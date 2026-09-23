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

type V2QuestionLike = {
  id: string
  sessionID: string
  questions?: Array<{
    question: string
    header: string
    options: Array<{ label: string; description: string }>
    multiple?: boolean
  }>
  /** Official 2.0.12 FormInfo fields (question API is gone). */
  title?: string
  fields?: ReadonlyArray<{
    key: string
    type?: string
    title?: string
    description?: string
    options?: ReadonlyArray<{ label?: string; value?: string; description?: string }>
  }>
  metadata?: Record<string, unknown>
  tool?: { messageID?: string; id?: string }
}

function questionsFromFormFields(item: V2QuestionLike): QuestionRequest["questions"] {
  const fields = item.fields
  if (!fields || fields.length === 0) {
    const title = typeof item.title === "string" && item.title.length > 0 ? item.title : "Form"
    return [{ question: title, header: title, options: [] }]
  }
  return fields.map((field) => {
    const header = (typeof field.title === "string" && field.title.length > 0)
      ? field.title
      : field.key
    const question = (typeof field.description === "string" && field.description.length > 0)
      ? field.description
      : (typeof item.title === "string" && item.title.length > 0 ? item.title : header)
    const options = (field.options ?? []).map((option) => ({
      label: option.label || option.value || "",
      description: typeof option.description === "string" ? option.description : "",
    })).filter((option) => option.label.length > 0)
    return {
      question,
      header,
      options,
      ...(field.type === "multiselect" ? { multiple: true as const } : {}),
    }
  })
}

/**
 * Map v2 form rows (and legacy question.request shapes) onto the local
 * QuestionRequest UI contract. Official 2.0.12 replaced questions with forms.
 */
export function mapV2QuestionRequest(item: V2QuestionLike): QuestionRequest {
  const questions = item.questions && item.questions.length > 0
    ? item.questions.map((question) => ({
      question: question.question,
      header: question.header,
      options: question.options ?? [],
      ...(question.multiple ? { multiple: true } : {}),
    }))
    : questionsFromFormFields(item)
  return {
    id: item.id,
    sessionID: item.sessionID,
    questions,
    ...(item.tool?.messageID
      ? { tool: { messageID: item.tool.messageID, callID: item.tool.id ?? "" } }
      : {}),
  }
}

/** Build session.form.reply answers with the authoritative field keys and value types. */
export function answersToFormAnswer(
  answers: string[][],
  fields: NonNullable<V2QuestionLike["fields"]>,
): Record<string, string | number | boolean | string[]> {
  const answer: Record<string, string | number | boolean | string[]> = {}
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]
    const values = (answers[index] ?? []).map((value) =>
      field.options?.find((option) => (option.label || option.value) === value)?.value ?? value)
    const value = values[0] ?? ""
    if (field.type === "multiselect") answer[field.key] = values
    else if (field.type === "number" || field.type === "integer") {
      const number = Number(value)
      if (!value.trim() || !Number.isFinite(number) || (field.type === "integer" && !Number.isInteger(number))) {
        throw new Error(`Invalid numeric answer for ${field.key}`)
      }
      answer[field.key] = number
    } else if (field.type === "boolean") {
      if (value !== "true" && value !== "false") throw new Error(`Invalid boolean answer for ${field.key}`)
      answer[field.key] = value === "true"
    } else answer[field.key] = value
  }
  // Extra answer rows without field keys are ignored; form schema owns keys.
  return answer
}

export { projectSession }
