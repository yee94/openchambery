/** Native projection recovery. Scheduling owns demand; the repository owns reads and reconciliation. */
import type { QueryClient } from "@tanstack/react-query"
import { getRuntimeGeneration, getRuntimeTransportIdentity } from "@/lib/runtime-switch"
import type { EventPipelineCompensationTrigger } from "./event-pipeline"
import type { SessionMessageRuntimeProbe } from "./session-message-query"
import type { TranscriptData, TranscriptRepository, TranscriptScope } from "./transcript-repository"
import type { TranscriptQueryCacheBudget } from "./session-transcript-query-cache"
import { beginTranscriptResync, endTranscriptResync } from "./transcript-resync-flight"
import { isMessageSnapshotOpen } from "./displayParts"

export type QueryTranscriptCompensationRepository = TranscriptRepository & {
  ensureInitial: (scope: TranscriptScope) => Promise<TranscriptData>
  refreshFromAuthority: (scope: TranscriptScope) => Promise<TranscriptData>
  getCacheBudget?: () => TranscriptQueryCacheBudget
}

export type CompensationSessionRef = { readonly directory: string; readonly sessionID: string }
export type CollectImmediateCompensationSessionsInput = {
  readonly activeScopes: readonly CompensationSessionRef[]
  readonly viewed?: CompensationSessionRef | null
  readonly viewedSessions?: readonly CompensationSessionRef[]
  readonly busyOrRetrySessionIDs?: readonly string[]
  readonly directory: string
}

/** Viewed first, then busy/retry, then other observed sessions. */
export function collectImmediateCompensationSessions(input: CollectImmediateCompensationSessionsInput): CompensationSessionRef[] {
  const directory = input.directory.trim()
  const ids = new Set<string>()
  for (const ref of [...input.viewedSessions ?? [], ...input.viewed ? [input.viewed] : []]) {
    if (ref.directory.trim() === directory) ids.add(ref.sessionID)
  }
  for (const id of input.busyOrRetrySessionIDs ?? []) ids.add(id)
  for (const ref of input.activeScopes) {
    if (ref.directory.trim() === directory) ids.add(ref.sessionID)
  }
  return [...ids].map((sessionID) => ({ directory, sessionID }))
}

export type TranscriptReconnectCompensationController = {
  captureCheckpoints: (input: { lastEventID: string | null; reason: string; transport?: string; generation?: number }) => void
  onCompensation: (trigger: EventPipelineCompensationTrigger) => void
  ensureOnObserve: (scope: TranscriptScope) => Promise<TranscriptData | null>
  cancelAll: (reason?: string) => void
  isSessionInFlight: (directory: string, sessionID: string) => boolean
  destroy: () => void
}

export type CreateTranscriptReconnectCompensationControllerInput = {
  client: QueryClient
  repository: QueryTranscriptCompensationRepository
  listDirectories: () => readonly string[]
  getBusyOrRetrySessionIDs: (directory: string) => readonly string[]
  getViewedSession: () => CompensationSessionRef | null
  getViewedSessions?: () => readonly CompensationSessionRef[]
  cacheBudget?: TranscriptQueryCacheBudget
  transport?: string
  generation?: number
  probe?: SessionMessageRuntimeProbe
  directoryConcurrency?: number
  now?: () => number
  onError?: (error: unknown, context: { directory: string; sessionID: string; phase: string }) => void
  confirmSessionStatus?: (ref: CompensationSessionRef, hint: { tailOpen: boolean }) => Promise<void>
}

export function createTranscriptReconnectCompensationController(
  input: CreateTranscriptReconnectCompensationControllerInput,
): TranscriptReconnectCompensationController {
  const repository = input.repository
  const budget = input.cacheBudget ?? repository.getCacheBudget?.()
  const now = input.now ?? Date.now
  const concurrency = Math.max(1, input.directoryConcurrency ?? 2)
  const identity = () => ({
    transport: input.probe?.getTransport?.() ?? input.transport ?? getRuntimeTransportIdentity(),
    generation: input.probe?.getGeneration?.() ?? input.generation ?? getRuntimeGeneration(),
  })
  const scoped = (ref: TranscriptScope): TranscriptScope => ({ ...identity(), ...ref, directory: ref.directory.trim() })
  const keyOf = (scope: TranscriptScope) => JSON.stringify([scope.transport, scope.generation, scope.directory, scope.sessionID])
  let epoch = 0
  let destroyed = false
  const stale = new Set<string>()
  const checkedAt = new Map<string, number>()
  type Job = { scope: TranscriptScope; epoch: number; gap: boolean; resolve: (data: TranscriptData | null) => void; reject: (error: unknown) => void }
  const queues = new Map<string, Job[]>()
  const active = new Map<string, number>()
  const flights = new Map<string, Promise<TranscriptData | null>>()
  const resyncReleases = new Set<() => void>()
  const current = (job: Job) => !destroyed && job.epoch === epoch
    && job.scope.transport === identity().transport && job.scope.generation === identity().generation

  const pump = (directory: string) => {
    const queue = queues.get(directory)
    while (queue?.length && (active.get(directory) ?? 0) < concurrency) {
      const job = queue.shift()!
      if (!current(job)) { job.resolve(null); continue }
      active.set(directory, (active.get(directory) ?? 0) + 1)
      if (job.gap) beginTranscriptResync(directory, job.scope.sessionID)
      const releaseResync = () => {
        if (!resyncReleases.delete(releaseResync)) return
        if (job.gap) endTranscriptResync(directory, job.scope.sessionID)
      }
      resyncReleases.add(releaseResync)
      void (async () => {
        try {
          // No anchor scan or destructive reset. Native GET + touched-id merge
          // keeps cached rows readable even when the network never answers.
          const data = repository.hasSession?.(job.scope)
            ? await repository.refreshFromAuthority(job.scope)
            : await repository.ensureInitial(job.scope)
          if (!current(job)) { job.resolve(null); return }
          stale.delete(keyOf(job.scope))
          checkedAt.set(keyOf(job.scope), now())
          const tail = data.messagesByID[data.messageOrder.at(-1) ?? ""]
          try {
            await input.confirmSessionStatus?.(job.scope, { tailOpen: Boolean(tail?.role === "assistant" && isMessageSnapshotOpen(tail)) })
          } catch { /* Status failure must not invalidate a complete transcript. */ }
          job.resolve(data)
        } catch (error) {
          if (current(job)) {
            stale.add(keyOf(job.scope))
            input.onError?.(error, { ...job.scope, phase: "native-refresh" })
            job.reject(error)
          } else job.resolve(null)
        } finally {
          releaseResync()
          if (job.epoch === epoch) {
            active.set(directory, Math.max(0, (active.get(directory) ?? 1) - 1))
            pump(directory)
          }
        }
      })()
    }
  }

  const enqueue = (ref: TranscriptScope, gap: boolean): Promise<TranscriptData | null> => {
    const scope = scoped(ref)
    const key = keyOf(scope)
    const existing = flights.get(key)
    if (existing) return existing
    let resolve!: Job["resolve"]
    let reject!: Job["reject"]
    const promise = new Promise<TranscriptData | null>((yes, no) => { resolve = yes; reject = no })
    const tracked = promise.finally(() => { if (flights.get(key) === tracked) flights.delete(key) })
    flights.set(key, tracked)
    const queue = queues.get(scope.directory) ?? []
    queue.push({ scope, gap, epoch, resolve, reject })
    queues.set(scope.directory, queue)
    pump(scope.directory)
    return tracked
  }

  const inventory = () => {
    const live = identity()
    const canonical = budget?.listCanonical(live) ?? []
    const retained = budget?.activeRegistry.listRetained() ?? []
    const viewed = [...input.getViewedSessions?.() ?? [], ...input.getViewedSession() ? [input.getViewedSession()!] : []]
    const directories = new Set([...input.listDirectories(), ...canonical.map((entry) => entry.scope.directory), ...retained.map((entry) => entry.directory), ...viewed.map((entry) => entry.directory)])
    const immediate: CompensationSessionRef[] = []
    for (const directory of directories) {
      immediate.push(...collectImmediateCompensationSessions({ directory, viewedSessions: viewed,
        busyOrRetrySessionIDs: input.getBusyOrRetrySessionIDs(directory),
        activeScopes: [...canonical.filter((entry) => entry.active).map((entry) => entry.scope), ...retained.filter((entry) => entry.transport === live.transport && entry.generation === live.generation)],
      }))
    }
    return { canonical, immediate }
  }

  const markStale = () => {
    const { canonical, immediate } = inventory()
    for (const ref of [...canonical.map((entry) => entry.scope), ...immediate]) stale.add(keyOf(scoped(ref)))
  }
  const cancelAll = () => {
    epoch += 1
    for (const release of resyncReleases) release()
    for (const queue of queues.values()) for (const job of queue) job.resolve(null)
    queues.clear()
    active.clear()
    flights.clear()
    stale.clear()
    checkedAt.clear()
  }
  return {
    captureCheckpoints: () => { if (!destroyed) markStale() },
    onCompensation(trigger) {
      if (destroyed || !trigger.isReconnect || trigger.runtimeGeneration !== identity().generation) return
      markStale()
      for (const ref of inventory().immediate) void enqueue(ref, true).catch(() => undefined)
    },
    ensureOnObserve(ref) {
      if (destroyed) return Promise.resolve(null)
      const scope = scoped(ref)
      const key = keyOf(scope)
      const existing = flights.get(key)
      if (existing) return existing
      const gap = stale.has(key)
      if (!gap && (!repository.hasSession?.(scope) || now() - (checkedAt.get(key) ?? -Infinity) < 60_000)) return Promise.resolve(null)
      return enqueue(scope, gap)
    },
    cancelAll,
    isSessionInFlight: (directory, sessionID) => flights.has(keyOf(scoped({ directory, sessionID }))),
    destroy() { destroyed = true; cancelAll() },
  }
}
