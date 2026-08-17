/**
 * Official OpenCode v2 session revert: stage / clear / commit.
 *
 * SDK gap: `@opencode-ai/sdk@1.18.4` is not the v2 authority, and
 * `@opencode-ai/client` is not approved for this cut. POST goes through the
 * existing Host shallow proxy + `runtimeFetch`. Host must not interpret body.
 *
 * - stage: POST `/api/session/:sessionID/revert/stage` — hide messages after
 *   the boundary without deleting them; `files:true` restores snapshot files.
 * - clear: POST `/api/session/:sessionID/revert/clear` — redo, restore files.
 * - commit: POST `/api/session/:sessionID/revert/commit` — new send; no redo.
 */

import { runtimeFetch } from "../lib/runtime-fetch"

export const SESSION_REVERT_BUSY_CODE = "session-revert-busy"

export type SessionRevertFile = {
  file: string
  status?: "added" | "deleted" | "modified"
  additions?: number
  deletions?: number
  patch?: string
}

export type SessionRevert = {
  messageID: string
  partID?: string
  snapshot?: string
  files?: SessionRevertFile[]
}

export type SessionRevertInput = {
  sessionID: string
  directory?: string | null
  signal?: AbortSignal
}

export type PostSessionRevertStageInput = SessionRevertInput & {
  messageID: string
  files?: boolean
}

const isHtmlContentType = (value: string | null): boolean => {
  if (!value) return false
  return value.toLowerCase().includes("text/html")
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function throwHttp(label: string, status: number, detail?: string): never {
  if (status === 409) {
    throw sessionRevertBusyError()
  }
  const suffix = detail ? `: ${detail}` : ""
  const error = new Error(`${label} (${status})${suffix}`) as Error & { status?: number }
  error.status = status
  throw error
}

export function sessionRevertBusyError(): Error {
  const error = new Error(SESSION_REVERT_BUSY_CODE)
  error.name = "SessionRevertBusyError"
  return error
}

export function isSessionRevertBusyError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const named = error as { name?: unknown; message?: unknown }
  return named.name === "SessionRevertBusyError" || named.message === SESSION_REVERT_BUSY_CODE
}

async function readFailedDetail(response: Response): Promise<string> {
  try {
    return (await response.text()).trim()
  } catch {
    return ""
  }
}

async function parseJsonBody(response: Response, label: string): Promise<unknown> {
  const contentType = response.headers.get("content-type")
  if (isHtmlContentType(contentType)) {
    throw new Error(`${label}: unexpected HTML response`)
  }
  if (response.status === 204) return null
  const text = await response.text()
  if (!text.trim()) {
    if (response.ok) return null
    throw new Error(`${label}: empty response`)
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${label}: malformed JSON`)
  }
}

function directoryQuery(directory?: string | null): Record<string, string> {
  return directory ? { directory } : {}
}

function revertPath(sessionID: string, action: "stage" | "clear" | "commit"): string {
  return `/api/session/${encodeURIComponent(sessionID)}/revert/${action}`
}

export function parseSessionRevert(payload: unknown): SessionRevert {
  const root = record(payload) ? payload : null
  const item = root && record(root.data) ? root.data : root
  if (!item) {
    throw new Error("session revert: expected revert payload")
  }
  const messageID = asString(item.messageID)
  if (!messageID) {
    throw new Error("session revert: missing messageID")
  }
  const files = Array.isArray(item.files)
    ? item.files.flatMap((entry) => {
      if (!record(entry)) return []
      const file = asString(entry.file) ?? asString(entry.path)
      if (!file) return []
      return [{
        file,
        ...(entry.status === "added" || entry.status === "deleted" || entry.status === "modified"
          ? { status: entry.status }
          : {}),
        ...(typeof entry.additions === "number" ? { additions: entry.additions } : {}),
        ...(typeof entry.deletions === "number" ? { deletions: entry.deletions } : {}),
        ...(typeof entry.patch === "string" ? { patch: entry.patch } : {}),
      } satisfies SessionRevertFile]
    })
    : undefined
  return {
    messageID,
    ...(asString(item.partID) ? { partID: asString(item.partID) } : {}),
    ...(asString(item.snapshot) ? { snapshot: asString(item.snapshot) } : {}),
    ...(files ? { files } : {}),
  }
}

export function revertFilePaths(revert: { files?: readonly { file?: string; path?: string }[] } | null | undefined): string[] {
  if (!revert?.files) return []
  return revert.files.flatMap((entry) => {
    const file = typeof entry.file === "string" && entry.file.length > 0
      ? entry.file
      : typeof entry.path === "string" && entry.path.length > 0
        ? entry.path
        : ""
    return file ? [file] : []
  })
}

export async function postSessionRevertStage(
  input: PostSessionRevertStageInput,
): Promise<SessionRevert> {
  const response = await runtimeFetch(revertPath(input.sessionID, "stage"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    query: directoryQuery(input.directory),
    body: JSON.stringify({
      messageID: input.messageID,
      files: input.files !== false,
    }),
    signal: input.signal,
  })
  if (!response.ok) {
    throwHttp("session revert stage", response.status, await readFailedDetail(response))
  }
  return parseSessionRevert(await parseJsonBody(response, "session revert stage"))
}

export async function postSessionRevertClear(input: SessionRevertInput): Promise<void> {
  const response = await runtimeFetch(revertPath(input.sessionID, "clear"), {
    method: "POST",
    query: directoryQuery(input.directory),
    signal: input.signal,
  })
  if (!response.ok) {
    throwHttp("session revert clear", response.status, await readFailedDetail(response))
  }
}

export async function postSessionRevertCommit(input: SessionRevertInput): Promise<void> {
  const response = await runtimeFetch(revertPath(input.sessionID, "commit"), {
    method: "POST",
    query: directoryQuery(input.directory),
    signal: input.signal,
  })
  if (!response.ok) {
    throwHttp("session revert commit", response.status, await readFailedDetail(response))
  }
}
