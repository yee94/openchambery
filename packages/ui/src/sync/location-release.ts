import { normalizePath } from "@/lib/pathNormalization"
import type { WorktreeMetadata } from "@/types/worktree"
import { useGlobalSessionStatusStore } from "./global-session-status"
import { useSessionFormStore } from "./session-form-store"
import type { State } from "./types"

export const WORKTREE_LOCATION_RELEASE_DELAY_MS = 5 * 60_000
const REQUEST_TIMEOUT_MS = 10_000
type DirectoryUse = "free" | "busy" | "unknown"

export function isWorktreeDirectory(
  directory: string,
  catalog: ReadonlyMap<string, readonly WorktreeMetadata[]>,
): boolean {
  const target = normalizePath(directory)
  if (!target || [...catalog.keys()].some((root) => normalizePath(root) === target)) return false
  return [...catalog.values()].some((rows) => rows.some((row) => normalizePath(row.path) === target))
}

export function directoryUse(directory: string, state: State | undefined): DirectoryUse {
  if (!state || state.status !== "complete" || state.session_status_snapshot_at === undefined) return "unknown"
  if (Object.values(state.session_status).some((status) => status.type === "busy" || status.type === "retry")) return "busy"
  if (Object.values(state.permission).some((rows) => rows.length > 0)) return "busy"
  if (Object.values(state.question).some((rows) => rows.length > 0)) return "busy"
  const forms = useSessionFormStore.getState().forms
  if (state.session.some((session) => forms[session.id]?.length)) return "busy"
  for (const entry of useGlobalSessionStatusStore.getState().statusById.values()) {
    if (normalizePath(entry.directory) === normalizePath(directory)) return "busy"
  }
  return "free"
}

/** Best-effort idle release, not a cross-client lease. Only left, known scopes are probed. */
export function createLocationRelease(deps: {
  eligible: (directory: string) => boolean
  isCurrentDirectory: (directory: string) => boolean
  isRuntimeCurrent: () => boolean
  directoryUse: (directory: string) => DirectoryUse
  checkRemoteUse: (directory: string, signal: AbortSignal) => Promise<DirectoryUse>
  release: (directory: string, signal: AbortSignal) => Promise<void>
}) {
  type Pending = {
    timer?: ReturnType<typeof setTimeout>
    deadline?: ReturnType<typeof setTimeout>
    finish?: () => void
    controller: AbortController
  }
  const pending = new Map<string, Pending>()
  let disposed = false
  const cancel = (directory: string) => {
    const entry = pending.get(directory)
    if (!entry) return
    clearTimeout(entry.timer)
    clearTimeout(entry.deadline)
    entry.controller.abort()
    entry.finish?.()
    pending.delete(directory)
  }
  const schedule = (directory: string) => {
    cancel(directory)
    const entry: Pending = { controller: new AbortController() }
    pending.set(directory, entry)
    const valid = () => !disposed && !entry.controller.signal.aborted
      && pending.get(directory) === entry && deps.isRuntimeCurrent()
      && !deps.isCurrentDirectory(directory) && deps.eligible(directory)
    const attempt = async () => {
      try {
        if (!valid()) return
        const local = deps.directoryUse(directory)
        if (local === "unknown") return
        if (local === "busy") { schedule(directory); return }
        // Abort is best-effort: a bridge ignoring it must still lose commit eligibility.
        const timeout = new Promise<"unknown">((resolve) => {
          entry.finish = () => resolve("unknown")
          entry.deadline = setTimeout(() => { entry.controller.abort(); resolve("unknown") }, REQUEST_TIMEOUT_MS)
        })
        const remote = await Promise.race([deps.checkRemoteUse(directory, entry.controller.signal), timeout])
        if (!valid()) return
        const latest = deps.directoryUse(directory)
        if (remote === "unknown" || latest === "unknown") return
        if (remote === "busy" || latest === "busy") { schedule(directory); return }
        await Promise.race([deps.release(directory, entry.controller.signal), timeout])
      } catch {
        // Failed probes/evictions leave cleanup to OpenCode's own inactivity sweep.
      } finally {
        clearTimeout(entry.deadline)
        entry.controller.abort()
        if (pending.get(directory) === entry) pending.delete(directory)
      }
    }
    entry.timer = setTimeout(() => { void attempt() }, WORKTREE_LOCATION_RELEASE_DELAY_MS)
  }
  return {
    directoryChanged(previous: string | null | undefined, next: string | null | undefined) {
      if (disposed) return
      const before = normalizePath(previous ?? "")
      const after = normalizePath(next ?? "")
      if (before === after) return
      if (after) cancel(after)
      if (before && deps.eligible(before)) schedule(before)
    },
    dispose() {
      disposed = true
      for (const directory of pending.keys()) cancel(directory)
    },
  }
}
