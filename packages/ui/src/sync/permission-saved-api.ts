/**
 * Official OpenCode v2 project-level saved permissions.
 *
 * SDK gap: `@opencode-ai/sdk@1.18.4` is not the v2 authority, and
 * `@opencode-ai/client` is not approved for this cut. GET/DELETE go through
 * the existing Host shallow proxy + `runtimeFetch`.
 *
 * - list: GET `/api/permission/saved?projectID=`
 * - remove: DELETE `/api/permission/saved/:id`
 */

import { runtimeFetch } from "../lib/runtime-fetch"

export type PermissionSavedInfo = {
  id: string
  projectID: string
  action: string
  resource: string
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
  const suffix = detail ? `: ${detail}` : ""
  const error = new Error(`${label} (${status})${suffix}`) as Error & { status?: number }
  error.status = status
  throw error
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

export function parsePermissionSavedList(payload: unknown): PermissionSavedInfo[] {
  const root = record(payload) ? payload : null
  const items = root && Array.isArray(root.data) ? root.data : Array.isArray(payload) ? payload : null
  if (!items) {
    throw new Error("permission saved: expected list payload")
  }
  return items.flatMap((entry) => {
    if (!record(entry)) return []
    const id = asString(entry.id)
    const projectID = asString(entry.projectID)
    const action = asString(entry.action)
    const resource = asString(entry.resource)
    if (!id || !projectID || !action || !resource) return []
    return [{ id, projectID, action, resource }]
  })
}

export async function listPermissionSaved(input: {
  projectID?: string | null
  signal?: AbortSignal
}): Promise<PermissionSavedInfo[]> {
  const response = await runtimeFetch("/api/permission/saved", {
    method: "GET",
    query: input.projectID ? { projectID: input.projectID } : {},
    signal: input.signal,
  })
  if (!response.ok) {
    throwHttp("permission saved list", response.status, await readFailedDetail(response))
  }
  return parsePermissionSavedList(await parseJsonBody(response, "permission saved list"))
}

export async function deletePermissionSaved(input: {
  id: string
  signal?: AbortSignal
}): Promise<void> {
  const response = await runtimeFetch(`/api/permission/saved/${encodeURIComponent(input.id)}`, {
    method: "DELETE",
    signal: input.signal,
  })
  if (!response.ok) {
    throwHttp("permission saved delete", response.status, await readFailedDetail(response))
  }
}
