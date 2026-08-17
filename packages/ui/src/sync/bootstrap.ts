import type { OpenCodeClient, SessionStatus } from '@/lib/opencode/v2-types'
import { mergeConfigDocuments } from "@/lib/opencode/v2-types"
import type { Project } from '@/sync/types'
import type { PermissionRequest } from '@/types/permission'
import type { QuestionRequest } from '@/types/question'

import { retry } from "./retry"
import type { GlobalState, State } from "./types"
import { runtimeFetch } from "../lib/runtime-fetch"
import { emitSyncConfigChanged } from "./sync-refs"
import {
  activeMembershipToStatus,
  locationToPath,
  mapV2PermissionRequest,
  mapV2Project,
  mapV2QuestionRequest,
  projectWorktree,
  v2CapabilityUnavailable,
} from "./v2-runtime"

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

function locationOf(directory?: string) {
  if (typeof directory !== "string" || directory.trim().length === 0) return undefined
  return { location: { directory } }
}

const requestSignature = (items: Array<{ id: string }> | undefined): string => {
  if (!items || items.length === 0) return ""
  return items
    .map((item) => item.id)
    .sort(cmp)
    .join("|")
}

function groupBySession<T extends { id: string; sessionID: string }>(input: T[]) {
  return input.reduce<Record<string, T[]>>((acc, item) => {
    if (!item?.id || !item.sessionID) return acc
    const list = acc[item.sessionID]
    if (list) list.push(item)
    else acc[item.sessionID] = [item]
    return acc
  }, {})
}

export function mergeSessionStatusSnapshot(
  before: Record<string, SessionStatus>,
  current: Record<string, SessionStatus>,
  snapshot: Record<string, SessionStatus>,
): Record<string, SessionStatus> {
  let merged = snapshot
  const sessionIDs = new Set([...Object.keys(before), ...Object.keys(current)])
  for (const sessionID of sessionIDs) {
    const status = current[sessionID]
    if (status === before[sessionID]) continue
    if (merged === snapshot) merged = { ...snapshot }
    if (status) merged[sessionID] = status
    else delete merged[sessionID]
  }
  return merged
}

function projectID(directory: string, projects: Project[]) {
  return projects.find(
    (project) => projectWorktree(project) === directory || project.sandboxes?.includes(directory),
  )?.id
}

// ---------------------------------------------------------------------------
// Bootstrap global state
// ---------------------------------------------------------------------------

export async function bootstrapGlobal(
  sdk: OpenCodeClient,
  set: (patch: Partial<GlobalState>) => void,
) {
  const results = await Promise.allSettled([
    retry(() => sdk.location.get().then((location) => set({ path: locationToPath(location) }))),
    retry(() => sdk.config.get().then((entries) => set({ config: mergeConfigDocuments(entries) }))),
    retry(() =>
      sdk.project.list().then((data) => {
        const projects = data
          .filter((p): p is NonNullable<typeof p> => !!p?.id)
          .map(mapV2Project)
          .filter((p) => !!projectWorktree(p) && !projectWorktree(p).includes("opencode-test"))
          .sort((a, b) => cmp(a.id, b.id))
        set({ projects })
      }),
    ),
  ])

  const errors = results
    .filter((r): r is PromiseRejectedResult => r.status === "rejected")
    .map((r) => r.reason)
  if (errors.length) {
    console.error("[bootstrap] global bootstrap failed", errors[0])
  }

  // If ALL requests failed, OpenCode is likely down — fetch the OpenChamber
  // health endpoint (outside the readiness gate) to get the actual error reason.
  if (errors.length === results.length) {
    let message = errors[0] instanceof Error ? errors[0].message : String(errors[0])
    try {
      const healthRes = await runtimeFetch('/health', { signal: AbortSignal.timeout(4000) })
      if (healthRes.ok) {
        const health = await healthRes.json()
        if (health.lastOpenCodeError) {
          message = health.lastOpenCodeError
        } else if (!health.openCodeRunning) {
          message = "OpenCode process is not running"
        }
      }
    } catch {
      // health endpoint itself unreachable — use the original error
    }
    set({ ready: true, error: { type: "init", message } })
  } else {
    set({ ready: true, error: undefined })
  }
}

// ---------------------------------------------------------------------------
// Bootstrap per-directory state
// ---------------------------------------------------------------------------

export async function bootstrapDirectory(input: {
  directory: string
  sdk: OpenCodeClient
  getState: () => State
  set: (patch: Partial<State>) => void
  global: {
    config: Record<string, unknown>
    projects: Project[]
  }
}) {
  const { directory, sdk, getState, set, global: g } = input
  const state = getState()
  const loading = state.status !== "complete"

  // Seed from global state while we fetch directory-specific data
  const seededProject = projectID(directory, g.projects)
  if (seededProject) set({ project: seededProject })
  if (Object.keys(state.config ?? {}).length === 0 && Object.keys(g.config ?? {}).length > 0) {
    const seededConfig = g.config as State["config"]
    set({ config: seededConfig })
    emitSyncConfigChanged(directory, seededConfig)
  }
  if (loading) set({ status: "partial" })

  // ---------------------------------------------------------------------------
  // Phase 1: Critical path — block until these resolve so the UI can render.
  // These are the minimum data needed to show a functional chat interface.
  // ---------------------------------------------------------------------------
  const phase1Results = await Promise.allSettled([
    seededProject
      ? Promise.resolve()
      : retry(() => sdk.project.current(locationOf(directory)).then((current) => set({ project: current.id }))),
    retry(() => sdk.config.get(locationOf(directory)).then((entries) => {
      const config = mergeConfigDocuments(entries)
      set({ config })
      emitSyncConfigChanged(directory, config)
    })),
    retry(() =>
      sdk.location.get(locationOf(directory)).then((location) => {
        const data = locationToPath(location)
        set({ path: data })
        const next = projectID(data.directory || directory, g.projects)
        if (next) set({ project: next })
      }),
    ),
    retry(async () => {
      const requestedAt = Date.now()
      const before = getState().session_status
      const membership = await sdk.session.active()
      const knownIDs = new Set([
        ...Object.keys(before),
        ...getState().session.map((session) => session.id),
      ])
      const snapshot = activeMembershipToStatus(membership, knownIDs)
      const current = getState().session_status
      const observedAt = { ...getState().session_status_observed_at }
      for (const sessionID of Object.keys(snapshot)) {
        if (current[sessionID] !== before[sessionID]) continue
        observedAt[sessionID] = requestedAt
      }
      set({
        session_status: mergeSessionStatusSnapshot(before, current, snapshot),
        session_status_observed_at: observedAt,
        session_status_snapshot_at: requestedAt,
      })
    }),
  ])

  const phase1Errors = phase1Results
    .filter((r): r is PromiseRejectedResult => r.status === "rejected")
    .map((r) => r.reason)

  // De-block the UI: only a total failure (OpenCode genuinely unreachable)
  // should abort the directory. Don't let one transient initial fetch strand
  // the directory in "loading" forever and skip phase 2/3 (sessions).
  //   - session.status is LIVE data the event pipeline keeps current — a failed
  //     initial snapshot is harmless; SSE will deliver the real status.
  //   - path.get feeds project resolution, but if we already resolved a project
  //     (from global projects) its failure is tolerable; the worktree path is
  //     refreshed by later events.
  const [, , pathResult] = phase1Results
  const pathFailedWithoutProject =
    pathResult.status === "rejected" && !getState().project

  if (phase1Errors.length === phase1Results.length || pathFailedWithoutProject) {
    console.error(`[bootstrap] directory bootstrap failed for ${directory}`, phase1Errors[0])
    return
  }

  // Mark ready after critical data arrives so the UI can paint.
  if (loading) set({ status: "complete" })

  // ---------------------------------------------------------------------------
  // Phase 2: Deferrable — fetch after first paint without blocking.
  // These enrich the UI but aren't required for basic functionality.
  // ---------------------------------------------------------------------------
  void Promise.allSettled([
    retry(async () => {
      const listed = await sdk.mcp.list(locationOf(directory))
      const mcp: State["mcp"] = {}
      for (const server of listed.data) {
        if (!server?.name) continue
        mcp[server.name] = server.status
      }
      set({ mcp })
    }),
    retry(async () => {
      throw v2CapabilityUnavailable("lsp.status")
    }),
    retry(async () => {
      const result = await sdk.vcs.get(locationOf(directory))
      if (!result?.data) {
        throw new Error("vcs.get returned no data")
      }
      set({ vcs: result.data })
    }),
    retry(async () => {
      const before = getState()
      const beforeSignatures = new Map(
        Object.entries(before.question ?? {}).map(([sessionID, questions]) => [sessionID, requestSignature(questions)]),
      )
      const listed = await sdk.question.request.list(locationOf(directory))
      const grouped = groupBySession(
        listed.data
          .filter((q): q is NonNullable<typeof q> => !!q?.id && !!q?.sessionID)
          .map(mapV2QuestionRequest),
      )
      const current = getState()
      const merged = { ...current.question }
      for (const [sessionID, questions] of Object.entries(grouped)) {
        merged[sessionID] = questions
          .filter((q) => !!q?.id)
          .sort((a, b) => cmp(a.id, b.id))
      }
      for (const sessionID of beforeSignatures.keys()) {
        if (grouped[sessionID]) continue
        const beforeSignature = beforeSignatures.get(sessionID) ?? ""
        const currentSignature = requestSignature(current.question[sessionID])
        if (currentSignature !== beforeSignature) continue
        delete merged[sessionID]
      }
      set({ question: merged })
    }),
    retry(async () => {
      const before = getState()
      const beforeSignatures = new Map(
        Object.entries(before.permission ?? {}).map(([sessionID, permissions]) => [sessionID, requestSignature(permissions)]),
      )
      const listed = await sdk.permission.request.list(locationOf(directory))
      const grouped = groupBySession(
        listed.data
          .filter((perm): perm is NonNullable<typeof perm> => !!perm?.id && !!perm?.sessionID)
          .map(mapV2PermissionRequest),
      )
      const current = getState()
      const merged = { ...current.permission }
      for (const [sessionID, perms] of Object.entries(grouped)) {
        merged[sessionID] = perms
          .filter((p) => !!p?.id)
          .sort((a, b) => cmp(a.id, b.id))
      }
      for (const sessionID of beforeSignatures.keys()) {
        if (grouped[sessionID]) continue
        const beforeSignature = beforeSignatures.get(sessionID) ?? ""
        const currentSignature = requestSignature(current.permission[sessionID])
        if (currentSignature !== beforeSignature) continue
        delete merged[sessionID]
      }
      set({ permission: merged })
    }),
  ]).then((results) => {
    const errors = results
      .filter((r): r is PromiseRejectedResult => r.status === "rejected")
      .map((r) => r.reason)
    if (errors.length) {
      console.error(`[bootstrap] deferred phase failed for ${directory}`, errors[0])
    }
  })

  // Session summaries are intentionally not loaded here. The root startup
  // coordinator owns one bounded SQLite-backed list per project, avoiding a
  // second active-directory `experimental.session.list` request.
}
