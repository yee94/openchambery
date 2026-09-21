/**
 * Official OpenCode v2 project-level saved permissions.
 *
 * Uses the active official client for project resolution and saved rules.
 * Project IDs come from location.get(...).project for the selected directory.
 *
 * - list: GET `/api/permission/saved?projectID=`
 * - remove: DELETE `/api/permission/saved/:id`
 */

import { opencodeClient } from "../lib/opencode/client"

export type PermissionSavedInfo = {
  id: string
  projectID: string
  action: string
  resource: string
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

export function parsePermissionSavedList(payload: unknown): PermissionSavedInfo[] {
  const root = record(payload) ? payload : null
  const items = root && Array.isArray(root.data) ? root.data : Array.isArray(payload) ? payload : null
  if (!items) {
    throw new Error("permission saved: expected list payload")
  }
  return items.map((entry) => {
    if (!record(entry)) throw new Error("permission saved: invalid rule")
    const id = asString(entry.id)
    const projectID = asString(entry.projectID)
    const action = asString(entry.action)
    const resource = asString(entry.resource)
    if (!id || !projectID || !action || !resource) throw new Error("permission saved: invalid rule")
    return { id, projectID, action, resource }
  })
}

export async function resolvePermissionSavedProject(directory: string, signal?: AbortSignal): Promise<string> {
  if (!directory.trim()) throw new Error("permission saved: directory required")
  signal?.throwIfAborted()
  // Official 2.x dropped project.current; location.get exposes project.id.
  const location = await opencodeClient.getApiClient().location.get({ location: { directory } }, { signal })
  signal?.throwIfAborted()
  const id = asString(location?.project?.id)
  if (!id) throw new Error("permission saved: project ID required")
  return id
}

export async function listPermissionSaved(input: {
  projectID?: string | null
  signal?: AbortSignal
}): Promise<PermissionSavedInfo[]> {
  input.signal?.throwIfAborted()
  const result = await opencodeClient.getApiClient().permission.saved.list(
    { projectID: input.projectID ?? undefined }, { signal: input.signal },
  )
  input.signal?.throwIfAborted()
  const items = parsePermissionSavedList(result)
  if (input.projectID && items.some((item) => item.projectID !== input.projectID)) {
    throw new Error("permission saved: project mismatch")
  }
  return items
}

export async function deletePermissionSaved(input: {
  id: string
  signal?: AbortSignal
}): Promise<void> {
  input.signal?.throwIfAborted()
  await opencodeClient.getApiClient().permission.saved.remove({ id: input.id }, { signal: input.signal })
}
