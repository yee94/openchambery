/**
 * Query-backed TranscriptRepository adapter (Tickets 04 + 09).
 *
 * Holds canonical InfiniteData<TranscriptPage> in TanStack QueryCache.
 * HTTP pages flow through transport-page Query (dedupe + classified retry)
 * then merge into InfiniteQuery. SSE / optimistic / reset use setQueryData
 * + pure mergeSessionTranscript.
 *
 * Ticket 09: production SyncProvider binds this adapter as the sole transcript
 * authority. Controllers resolve transport/generation through live probes so
 * endpoint switches do not pin creation-time identity.
 *
 * Ticket 07: `materializeMessage` fills slim tool/reasoning/file/text parts through
 * exact `session.message` (single-flight, captured transport+generation).
 */

import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import type { QueryClient } from "@tanstack/react-query"

import { queryClient as defaultQueryClient } from "@/lib/queryRuntime"
import { opencodeClient } from "@/lib/opencode/client"
import {
  getRuntimeGeneration,
  getRuntimeTransportIdentity,
} from "@/lib/runtime-switch"

import {
  applySessionTranscriptMerge,
  createSessionTranscriptController,
  ensureSessionMessagePage,
  readSessionTranscriptData,
  SessionMessageRuntimeStaleError,
  sessionMessagePageQueryOptions,
  sessionTranscriptQueryKey,
  type SessionMessagePageFetcher,
  type SessionMessageRuntimeProbe,
  type SessionTranscriptController,
  type SessionTranscriptFetcher,
  type SessionTranscriptQueryKey,
} from "./session-message-query"
import type { TranscriptDurableStore } from "./transcript-durable-store"
import {
  createTranscriptDurableQueryQueue,
  toTranscriptDurableScope,
  transcriptDurableSseAction,
  transportPageFromHttpPage,
  type TranscriptDurableQueryQueue,
} from "./transcript-durable-store-query"
import {
  boundaryFromTranscriptData,
  projectFlatFromTranscriptData,
  type SessionTranscriptData,
} from "./transcript-merge"
import {
  createTranscriptActiveScopeRegistry,
  createTranscriptQueryCacheBudget,
  type TranscriptActiveScopeRegistry,
  type TranscriptCacheScope,
  type TranscriptQueryCacheBudget,
} from "./session-transcript-query-cache"
import { fetchExactSessionMessageRecord } from "./transcript-parent-recovery"
import {
  countTranscriptAuthoredUserTurns,
  evaluateTranscriptP0Satisfied,
  messageNeedsExactMaterialization,
  messageNeedsExactRevalidation,
  projectPagination,
  resolveTranscriptHydrationPhase,
  type TranscriptChangeListener,
  type TranscriptCommand,
  type TranscriptCommandResult,
  type TranscriptData,
  type TranscriptHydrationState,
  type TranscriptMessageMaterializationState,
  type TranscriptPagination,
  type TranscriptRepository,
  type TranscriptRequestState,
  type TranscriptScope,
  type TranscriptTransportPage,
} from "./transcript-repository"
import { getInitialSessionTurnLimit } from "./session-message-policy"
import { markSessionAuthorityRevalidated } from "./session-authority-revalidate"
import { isTranscriptAuthorityRefreshInFlight } from "./transcript-authority-refresh-flight"
import {
  recordTranscriptCommandDiagnostics,
  recordTranscriptDiagnostics,
  recordTranscriptDiff,
  snapshotTranscriptDiagnostics,
  tryCaptureTranscriptCanonicalSnapshot,
} from "./transcript-diagnostics-runtime"
import { UNKNOWN_SESSION_HISTORY_BOUNDARY } from "./types"
import { enqueueExactFill } from "./transcript-exact-fill-scheduler"

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export type TranscriptQueryAdapterDeps = {
  client?: QueryClient
  /** HTTP page fetcher (Host turn-page). Required for ensureInitial / fetchPreviousPage. */
  fetcher?: SessionTranscriptFetcher
  transport?: string
  generation?: number
  probe?: SessionMessageRuntimeProbe
  initialLimit?: number
  historyLimit?: number
  /**
   * Optional shared cache budget (Ticket 08). When omitted, the adapter creates
   * a private budget + active-scope registry for this repository instance.
   */
  cacheBudget?: TranscriptQueryCacheBudget
  /**
   * Optional shared active-scope registry. Ignored when `cacheBudget` is provided
   * (the budget owns its registry).
   */
  activeRegistry?: TranscriptActiveScopeRegistry
  /**
   * Optional optimistic shadow clear (production shadow maps).
   * Confirm/remove still update Query data independently.
   */
  clearOptimisticShadow?: (input: {
    directory: string
    sessionID: string
    messageID: string
  }) => void
  setOptimisticShadow?: (input: {
    directory: string
    sessionID: string
    message: Message
    parts: readonly Part[]
  }) => void
  /**
   * Optional settled-transcript cache. Absence or store failure leaves the
   * network path unchanged; durable data is only a first-paint continuity source.
   */
  durableStore?: TranscriptDurableStore
  /** Override the platform durable byte budget after a successful persist. */
  getDurableByteBudget?: () => number
  /**
    * Exact `session.message` fetch for on-demand tool/reasoning/file/text fill.
   * Tests inject this. Production omits it and uses the scoped Host SDK.
   */
  fetchMessage?: (input: {
    directory: string
    sessionID: string
    messageID: string
  }) => Promise<{ info: Message; parts?: readonly Part[] }>
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function normalizeDirectory(directory: string): string {
  return directory.trim()
}

function resolveScopeIdentity(
  scope: TranscriptScope,
  deps: TranscriptQueryAdapterDeps,
): { directory: string; sessionID: string; transport: string; generation: number } {
  const transport =
    scope.transport
    ?? deps.transport
    ?? (deps.probe?.getTransport ?? getRuntimeTransportIdentity)()
  const generation =
    scope.generation
    ?? deps.generation
    ?? (deps.probe?.getGeneration ?? getRuntimeGeneration)()
  return {
    directory: normalizeDirectory(scope.directory),
    sessionID: scope.sessionID,
    transport,
    generation,
  }
}

function scopeKey(identity: {
  directory: string
  sessionID: string
  transport: string
  generation: number
}): string {
  return `${identity.transport}\n${identity.generation}\n${identity.directory}\n${identity.sessionID}`
}

function emptyTranscript(sessionID: string): TranscriptData {
  return {
    sessionID,
    messageOrder: [],
    messagesByID: {},
    partsByMessageID: {},
    boundary: UNKNOWN_SESSION_HISTORY_BOUNDARY,
    liveRevision: 0,
  }
}

function toTranscriptData(
  data: SessionTranscriptData | undefined,
  sessionID: string,
): TranscriptData {
  if (!data || data.pages.length === 0) return emptyTranscript(sessionID)
  const flat = projectFlatFromTranscriptData(data, sessionID)
  return {
    sessionID,
    messageOrder: flat.messageOrder,
    messagesByID: flat.messagesByID,
    partsByMessageID: flat.partsByMessageID,
    boundary: flat.boundary,
    liveRevision: flat.liveRevision,
  }
}

function messageCreatedAt(message: Message | undefined): number | undefined {
  const created = message?.time?.created
  return typeof created === "number" && Number.isFinite(created) ? created : undefined
}

function hasUnconfirmedOptimisticPart(parts: readonly Part[] | undefined): boolean {
  return Boolean(
    parts?.some(
      (part) => (part as { __openchamberOptimistic?: unknown }).__openchamberOptimistic === true,
    ),
  )
}

/**
 * Tail-window deletions for user refresh. Anchor = oldest `time.created` on the
 * new page. Only messages strictly newer than that anchor, absent from the page,
 * and not unconfirmed optimistic rows are server-deleted. Older-than-anchor
 * history is outside the tail page and must stay.
 */
function collectAuthorityRefreshRemovals(
  transcript: TranscriptData,
  page: TranscriptTransportPage,
): string[] {
  if (page.records.length === 0) return []
  let anchor: number | undefined
  for (const record of page.records) {
    const created = messageCreatedAt(record.info)
    if (created === undefined) continue
    if (anchor === undefined || created < anchor) anchor = created
  }
  if (anchor === undefined) return []

  const pageIDs = new Set(page.records.map((record) => record.info.id))
  const removed: string[] = []
  for (const messageID of transcript.messageOrder) {
    if (pageIDs.has(messageID)) continue
    const created = messageCreatedAt(transcript.messagesByID[messageID])
    if (created === undefined || created <= anchor) continue
    if (hasUnconfirmedOptimisticPart(transcript.partsByMessageID[messageID])) continue
    removed.push(messageID)
  }
  return removed
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a Query-backed TranscriptRepository.
 *
 * Controllers are created lazily per scope when ensureInitial / fetchPreviousPage
 * is invoked. Command apply paths work without a controller via setQueryData.
 */
export type QueryTranscriptRepository = TranscriptRepository & {
  ensureInitial: (scope: TranscriptScope) => Promise<TranscriptData>
  fetchPreviousPage: (scope: TranscriptScope) => Promise<TranscriptData>
  getController: (scope: TranscriptScope) => SessionTranscriptController | undefined
  /** Ticket 08: QueryCache LRU + destructive reset budget. */
  getCacheBudget: () => TranscriptQueryCacheBudget
  /**
   * Destructive reset: purge all key families, ensure a fresh tail, keep only
   * the new chain. Ensure failure leaves an empty/failed state (no old restore).
   */
  destructiveReset: (scope: TranscriptScope) => Promise<TranscriptData>
  /**
   * User-triggered refresh: fetch a fresh tail, merge as reconcile-page, then
   * delete only in-range non-optimistic absences. Failure leaves prior data.
   */
  refreshFromAuthority: (scope: TranscriptScope) => Promise<TranscriptData>
  /** Evict one session's transcript key families (delete / ordinary eviction). */
  purgeSession: (scope: TranscriptScope) => void
  /** Purge all transcript families for a transport generation (runtime switch). */
  purgeGeneration: (transport: string, generation: number) => void
  /**
   * Fetch the exact Host snapshot for one message and merge it through
   * `materialize-snapshots`. Concurrent calls for the same identity share one flight.
   */
  materializeMessage: (scope: TranscriptScope, messageID: string) => Promise<TranscriptData>
  /** Read-only exact-message fill status for one message. */
  getMessageMaterializationState: (
    scope: TranscriptScope,
    messageID: string,
  ) => TranscriptMessageMaterializationState
  getHydrationState: (scope: TranscriptScope) => TranscriptHydrationState
  destroy: () => void
}

export function createQueryTranscriptRepository(
  deps: TranscriptQueryAdapterDeps = {},
): QueryTranscriptRepository {
  const client = deps.client ?? defaultQueryClient
  const cacheBudget =
    deps.cacheBudget
    ?? createTranscriptQueryCacheBudget({
      client,
      activeRegistry: deps.activeRegistry ?? createTranscriptActiveScopeRegistry(),
    })
  const activeRegistry = cacheBudget.activeRegistry
  const controllers = new Map<string, SessionTranscriptController>()
  const listeners = new Map<string, Set<TranscriptChangeListener>>()
  const cacheUnsubs = new Map<string, () => void>()
  /** Per-scope release for repository subscribe → active registry retain. */
  const listenerRetainReleases = new Map<string, () => void>()
  /** Narrow projection caches for reference stability. */
  const projectionCache = new Map<
    string,
    {
      transcript?: TranscriptData
      pagination?: TranscriptPagination
      messages: Map<string, Message | undefined>
      parts: Map<string, readonly Part[]>
    }
  >()
  const durableQueue: TranscriptDurableQueryQueue | undefined = deps.durableStore
    ? createTranscriptDurableQueryQueue(deps.durableStore, {
      getProtectScopes: () => activeRegistry.listRetained().map(toTranscriptDurableScope),
      getByteBudget: deps.getDurableByteBudget,
    })
    : undefined
  /**
   * Authority-tail flight started after a durable first paint. Observer status
   * does not see `ensureSessionMessagePage`, so request state is tracked here.
   */
  const authorityFlights = new Map<string, { status: "loading" | "error"; error?: string }>()
  /** Coalesce concurrent seed-path authority tails (ensureInitial + fetchPreviousPage). */
  const authorityTailInflight = new Map<string, Promise<TranscriptData>>()
  /** Per-message exact-fill status, keyed by scopeKey + messageID. */
  const messageStates = new Map<string, { status: "idle" | "loading" | "ready" | "error"; error?: string }>()
  /** In-flight exact-fill promises so repeat expands share one Host request. */
  const messageFlights = new Map<string, Promise<TranscriptData>>()
  /**
   * Durable-seeded message IDs still awaiting an exact `session.message`
   * fill (slim tool/reasoning/file, or full-but-open snapshot). Keyed by
   * scopeKey. Settled full rows never enter this set.
   */
  const durableSeededExact = new Map<string, Set<string>>()
  /**
   * Scopes whose canonical tail came only from a durable seed. The seed now
   * derives a conservative `has-more` boundary (hot-path entry), so without
   * this latch a cold start would skip the authority tail entirely and serve
   * arbitrarily stale durable content. Cleared once any http-page / SSE frame
   * lands for the scope.
   */
  const seededAuthorityPending = new Set<string>()
  /** Latched P0 so a later empty/stale read cannot reopen the skeleton. */
  const p0Latches = new Map<string, true>()
  /** First on-screen paint for a scope; one hydration event per latch. */
  const p0Painted = new Set<string>()
  /** In-flight older-history prepends (P1). */
  const prependFlights = new Set<string>()

  const recordHydrationPaint = (
    scope: TranscriptScope,
    identity: ReturnType<typeof resolveScopeIdentity>,
  ) => {
    const key = scopeKey(identity)
    if (p0Painted.has(key)) return
    const transcript = toTranscriptData(readData(scope), identity.sessionID)
    if (!evaluateTranscriptP0Satisfied(transcript) && !p0Latches.has(key)) return
    p0Painted.add(key)
    recordTranscriptDiagnostics(snapshotTranscriptDiagnostics({
      kind: "hydration",
      sessionID: identity.sessionID,
      directory: identity.directory,
      transport: identity.transport,
      generation: identity.generation,
      transcript,
      hydration: {
        sessionID: identity.sessionID,
        p0Satisfied: true,
        phase: "p0",
      },
    }))
  }
  let suppressDurableWrite = 0

  const getProjection = (key: string) => {
    let cache = projectionCache.get(key)
    if (!cache) {
      cache = { messages: new Map(), parts: new Map() }
      projectionCache.set(key, cache)
    }
    return cache
  }

  const readData = (scope: TranscriptScope): SessionTranscriptData | undefined => {
    const identity = resolveScopeIdentity(scope, deps)
    return readSessionTranscriptData(
      { directory: identity.directory, sessionID: identity.sessionID },
      client,
      identity.transport,
      identity.generation,
    )
  }

  const queryKeyFor = (scope: TranscriptScope): SessionTranscriptQueryKey => {
    const identity = resolveScopeIdentity(scope, deps)
    return sessionTranscriptQueryKey(
      { directory: identity.directory, sessionID: identity.sessionID },
      identity.transport,
      identity.generation,
    )
  }

  const toCacheScope = (scope: TranscriptScope): TranscriptCacheScope => {
    const identity = resolveScopeIdentity(scope, deps)
    return {
      transport: identity.transport,
      generation: identity.generation,
      directory: identity.directory,
      sessionID: identity.sessionID,
    }
  }

  const enforceBudgetAfterWrite = (scope: TranscriptScope) => {
    const cacheScope = toCacheScope(scope)
    cacheBudget.enforce({
      transport: cacheScope.transport,
      generation: cacheScope.generation,
      directory: cacheScope.directory,
      preserve: [cacheScope],
    })
  }

  const ensureController = (scope: TranscriptScope): SessionTranscriptController => {
    // Live probe: never pin fixed transport/generation from creation time so
    // runtime switches invalidate stale controllers via generation mismatch.
    const liveProbe: SessionMessageRuntimeProbe = deps.probe ?? {
      getTransport: getRuntimeTransportIdentity,
      getGeneration: getRuntimeGeneration,
    }
    const identity = resolveScopeIdentity(scope, {
      ...deps,
      transport: undefined,
      generation: undefined,
      probe: liveProbe,
    })
    const key = scopeKey(identity)
    const existing = controllers.get(key)
    if (existing) return existing
    if (!deps.fetcher) {
      throw new Error("Query transcript repository requires a fetcher for HTTP loads")
    }
    const controller = createSessionTranscriptController({
      directory: identity.directory,
      sessionID: identity.sessionID,
      fetcher: deps.fetcher,
      // Pass live probes; controller options capture generation at create for
      // assertRuntimeCurrent, re-created after purgeGeneration/runtime switch.
      transport: identity.transport,
      generation: identity.generation,
      probe: liveProbe,
      client,
      initialLimit: deps.initialLimit,
      historyLimit: deps.historyLimit,
    })
    controllers.set(key, controller)
    return controller
  }

  const notify = (scope: TranscriptScope) => {
    const identity = resolveScopeIdentity(scope, deps)
    const key = scopeKey(identity)
    // Invalidate projection cache so next read rebuilds with sharing.
    projectionCache.delete(key)
    const set = listeners.get(key)
    if (!set || set.size === 0) return
    for (const listener of set) listener(scope)
  }

  const ensureCacheSubscription = (scope: TranscriptScope) => {
    const identity = resolveScopeIdentity(scope, deps)
    const key = scopeKey(identity)
    if (cacheUnsubs.has(key)) return
    const queryKey = queryKeyFor(scope)
    const cache = client.getQueryCache()
    const unsubscribe = cache.subscribe((event) => {
      if (event.type !== "updated" && event.type !== "removed") return
      const eventKey = event.query.queryKey
      if (
        eventKey[0] !== queryKey[0]
        || eventKey[1] !== queryKey[1]
        || eventKey[2] !== queryKey[2]
        || eventKey[3] !== queryKey[3]
        || eventKey[4] !== queryKey[4]
      ) {
        return
      }
      notify(scope)
    })
    cacheUnsubs.set(key, unsubscribe)
  }

  const releaseIfIdle = (key: string) => {
    const set = listeners.get(key)
    if (set && set.size > 0) return
    const unsub = cacheUnsubs.get(key)
    if (unsub) {
      unsub()
      cacheUnsubs.delete(key)
    }
    listeners.delete(key)
  }

  const shareTranscript = (
    key: string,
    next: TranscriptData,
  ): TranscriptData => {
    const cache = getProjection(key)
    const prev = cache.transcript
    if (
      prev
      && prev.sessionID === next.sessionID
      && prev.liveRevision === next.liveRevision
      && prev.boundary === next.boundary
      && prev.messageOrder === next.messageOrder
      && prev.messagesByID === next.messagesByID
      && prev.partsByMessageID === next.partsByMessageID
    ) {
      return prev
    }
    // Field-level sharing for messageOrder / maps when contents equal by ref.
    if (
      prev
      && prev.messageOrder.length === next.messageOrder.length
      && prev.messageOrder.every((id, i) => id === next.messageOrder[i])
      && prev.boundary.kind === next.boundary.kind
      && prev.boundary.loadedTurns === next.boundary.loadedTurns
      && (
        prev.boundary.kind !== "has-more"
        || next.boundary.kind !== "has-more"
        || prev.boundary.cursor === next.boundary.cursor
      )
      && prev.liveRevision === next.liveRevision
    ) {
      let messagesSame = true
      let partsSame = true
      const messagesByID = { ...prev.messagesByID }
      const partsByMessageID = { ...prev.partsByMessageID }
      for (const id of next.messageOrder) {
        if (prev.messagesByID[id] !== next.messagesByID[id]) {
          messagesSame = false
          messagesByID[id] = next.messagesByID[id]!
        }
        if (prev.partsByMessageID[id] !== next.partsByMessageID[id]) {
          partsSame = false
          if (next.partsByMessageID[id]) {
            partsByMessageID[id] = next.partsByMessageID[id]!
          } else {
            delete partsByMessageID[id]
          }
        }
      }
      if (messagesSame && partsSame) {
        cache.transcript = prev
        return prev
      }
      const shared: TranscriptData = {
        sessionID: next.sessionID,
        messageOrder: prev.messageOrder,
        messagesByID: messagesSame ? prev.messagesByID : messagesByID,
        partsByMessageID: partsSame ? prev.partsByMessageID : partsByMessageID,
        boundary:
          prev.boundary.kind === next.boundary.kind
          && prev.boundary.loadedTurns === next.boundary.loadedTurns
            ? prev.boundary
            : next.boundary,
        liveRevision: next.liveRevision,
      }
      cache.transcript = shared
      return shared
    }
    cache.transcript = next
    return next
  }

  const sharePagination = (
    key: string,
    next: TranscriptPagination,
  ): TranscriptPagination => {
    const cache = getProjection(key)
    const prev = cache.pagination
    if (
      prev
      && prev.sessionID === next.sessionID
      && prev.hasPreviousPage === next.hasPreviousPage
      && prev.isComplete === next.isComplete
      && prev.cursor === next.cursor
      && prev.loadedTurns === next.loadedTurns
      && prev.boundary.kind === next.boundary.kind
      && prev.boundary.loadedTurns === next.boundary.loadedTurns
    ) {
      return prev
    }
    cache.pagination = next
    return next
  }

  const messageStateKey = (
    identity: ReturnType<typeof resolveScopeIdentity>,
    messageID: string,
  ): string => `${scopeKey(identity)}\n${messageID}`

  const clearDurableSeededExactMessage = (
    identity: ReturnType<typeof resolveScopeIdentity>,
    messageID: string,
  ) => {
    const key = scopeKey(identity)
    const pending = durableSeededExact.get(key)
    if (!pending) return
    pending.delete(messageID)
    if (pending.size === 0) durableSeededExact.delete(key)
  }

  const clearDurableSeededExact = (prefix: string) => {
    for (const key of durableSeededExact.keys()) {
      if (key === prefix || key.startsWith(prefix)) durableSeededExact.delete(key)
    }
  }

  const clearMessageMaterialization = (prefix: string) => {
    for (const key of messageStates.keys()) {
      if (key.startsWith(prefix)) messageStates.delete(key)
    }
    for (const key of messageFlights.keys()) {
      if (key.startsWith(prefix)) messageFlights.delete(key)
    }
  }

  const clearHydration = (prefix: string) => {
    for (const key of p0Latches.keys()) {
      if (key === prefix || key.startsWith(prefix)) p0Latches.delete(key)
    }
    for (const key of [...p0Painted]) {
      if (key === prefix || key.startsWith(prefix)) p0Painted.delete(key)
    }
    for (const key of prependFlights) {
      if (key === prefix || key.startsWith(prefix)) prependFlights.delete(key)
    }
  }

  const isMaterializeActive = (identity: ReturnType<typeof resolveScopeIdentity>): boolean => {
    const prefix = `${scopeKey(identity)}\n`
    for (const [key, state] of messageStates) {
      if (key.startsWith(prefix) && state.status === "loading") return true
    }
    for (const key of messageFlights.keys()) {
      if (key.startsWith(prefix)) return true
    }
    return false
  }

  const liveIdentityMatches = (captured: {
    directory: string
    sessionID: string
    transport: string
    generation: number
  }): boolean => {
    const live = resolveScopeIdentity(
      { directory: captured.directory, sessionID: captured.sessionID },
      deps,
    )
    return live.transport === captured.transport && live.generation === captured.generation
  }

  const persistSettledRecord = (
    identity: ReturnType<typeof resolveScopeIdentity>,
    info: Message,
    parts: readonly Part[] | undefined,
  ) => {
    if (!durableQueue) return
    void durableQueue.persistSettled(toTranscriptDurableScope(identity), info, parts ?? [])
  }

  const scheduleDurableAfterApply = (
    scope: TranscriptScope,
    identity: ReturnType<typeof resolveScopeIdentity>,
    command: TranscriptCommand,
    result: TranscriptCommandResult,
  ) => {
    if (!durableQueue || suppressDurableWrite > 0) return
    if (!result.applied || !result.changed) return
    const durableScope = toTranscriptDurableScope(identity)
    if (command.type === "remove-message") {
      void durableQueue.removeMessage(durableScope, command.messageID)
      return
    }
    if (command.type === "reset") {
      void durableQueue.clearSession(durableScope)
      if (command.page) {
        const transcript = toTranscriptData(readData(scope), identity.sessionID)
        for (const record of command.page.records) {
          const info = transcript.messagesByID[record.info.id] ?? record.info
          persistSettledRecord(
            identity,
            info,
            transcript.partsByMessageID[record.info.id] ?? record.parts,
          )
        }
      }
      return
    }
    if (
      command.type === "optimistic-add"
      || command.type === "optimistic-confirm"
      || command.type === "optimistic-remove"
    ) {
      return
    }
    if (command.type === "sse-event" || command.type === "sse-event-batch") {
      const events = command.type === "sse-event" ? [command.event] : command.events
      const transcript = toTranscriptData(readData(scope), identity.sessionID)
      for (const event of events) {
        const action = transcriptDurableSseAction(event)
        if (action.action === "remove") {
          void durableQueue.removeMessage(durableScope, action.messageID)
          continue
        }
        if (action.action === "skip") continue
        const info = transcript.messagesByID[action.messageID]
        if (!info) continue
        persistSettledRecord(identity, info, transcript.partsByMessageID[action.messageID])
      }
      return
    }
    if (command.type === "http-page" || command.type === "materialize-snapshots") {
      const transcript = toTranscriptData(readData(scope), identity.sessionID)
      const records = command.type === "http-page" ? command.page.records : command.records
      for (const record of records) {
        const info = transcript.messagesByID[record.info.id]
        if (!info) continue
        persistSettledRecord(identity, info, transcript.partsByMessageID[record.info.id])
      }
    }
  }

  const fetchAuthorityTail = async (
    identity: ReturnType<typeof resolveScopeIdentity>,
    options?: { fresh?: boolean },
  ): Promise<TranscriptTransportPage> => {
    if (!deps.fetcher) {
      throw new Error("Query transcript repository requires a fetcher for HTTP loads")
    }
    const pageFetcher: SessionMessagePageFetcher = async (args) => {
      const page = await deps.fetcher!({
        directory: args.directory,
        sessionID: args.sessionID,
        limit: args.limit,
        before: args.before,
        signal: args.signal,
      })
      return {
        records: page.records.map((record) => ({
          info: record.info,
          parts: record.parts,
        })),
        cursor: page.cursor,
        complete: page.complete,
        turnCount: page.turnCount,
        requestedTurnLimit: page.requestedTurnLimit,
      }
    }
    const probe: SessionMessageRuntimeProbe = deps.probe ?? {
      getTransport: getRuntimeTransportIdentity,
      getGeneration: getRuntimeGeneration,
    }
    const params = {
      directory: identity.directory,
      sessionID: identity.sessionID,
      limit: deps.initialLimit ?? getInitialSessionTurnLimit(),
    }
    // Hot enter-and-sync must not reuse the Infinity-staleTime transport page.
    const httpPage = options?.fresh
      ? await client.fetchQuery({
        ...sessionMessagePageQueryOptions(
          params,
          pageFetcher,
          identity.transport,
          probe,
          identity.generation,
        ),
        staleTime: 0,
      })
      : await ensureSessionMessagePage(
        params,
        pageFetcher,
        client,
        identity.transport,
        probe,
        identity.generation,
      )
    return transportPageFromHttpPage(httpPage)
  }

  /**
   * Background exact fills after an authority tail. Shares the process-wide
   * scheduler with UI `materializeTranscriptMessage` (concurrency ≤4).
   */
  const scheduleBoundedExactFills = (
    scope: TranscriptScope,
    messageIDs: readonly string[],
  ): void => {
    for (const id of messageIDs) {
      const key = `${scope.directory}\n${scope.sessionID}\n${id}`
      void enqueueExactFill(
        key,
        () => repository.materializeMessage(scope, id),
        { priority: "background" },
      ).catch(() => undefined)
    }
  }

  const runAuthorityInitial = (
    scope: TranscriptScope,
    captured: ReturnType<typeof resolveScopeIdentity>,
  ): Promise<TranscriptData> => {
    const flightKey = scopeKey(captured)
    const existing = authorityTailInflight.get(flightKey)
    if (existing) return existing
    const run = (async () => {
      const startedAt = Date.now()
      authorityFlights.set(flightKey, { status: "loading" })
      try {
        const page = await fetchAuthorityTail(captured)
        if (!liveIdentityMatches(captured)) {
          authorityFlights.delete(flightKey)
          return repository.getTranscript(scope)
        }
        repository.apply(scope, { type: "http-page", purpose: "initial", page })
        markSessionAuthorityRevalidated(captured.directory, captured.sessionID, {
          transport: captured.transport,
          generation: captured.generation,
        })
        // Durable-seeded tool/reasoning/file parts that still need exact fill
        // (slim, or full-but-open) queue a bounded background materialize.
        // Settled full parts are dropped from the pending set as ready.
        const pending = durableSeededExact.get(flightKey)
        if (pending && pending.size > 0) {
          const toFill: string[] = []
          let markedReady = 0
          for (const record of page.records) {
            const id = record.info.id
            if (!id || !pending.has(id)) continue
            const storeParts = repository.getParts(scope, id)
            const storeInfo = repository.getMessage(scope, id) ?? record.info
            if (!messageNeedsExactRevalidation(storeParts, storeInfo)) {
              clearDurableSeededExactMessage(captured, id)
              messageStates.set(messageStateKey(captured, id), { status: "ready" })
              markedReady += 1
              continue
            }
            toFill.push(id)
          }
          if (markedReady > 0) notify(scope)
          scheduleBoundedExactFills(scope, toFill)
        }
        authorityFlights.delete(flightKey)
        cacheBudget.noteScopeObserved(toCacheScope(scope))
        enforceBudgetAfterWrite(scope)
        return repository.getTranscript(scope)
      } catch (error) {
        if (error instanceof SessionMessageRuntimeStaleError || !liveIdentityMatches(captured)) {
          authorityFlights.delete(flightKey)
          return repository.getTranscript(scope)
        }
        authorityFlights.set(flightKey, {
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        })
        recordTranscriptDiagnostics(snapshotTranscriptDiagnostics({
          kind: "request-error",
          sessionID: captured.sessionID,
          directory: captured.directory,
          transport: captured.transport,
          generation: captured.generation,
          source: "network",
          purpose: "initial",
          durationMs: Date.now() - startedAt,
          transcript: toTranscriptData(readData(scope), captured.sessionID),
          request: repository.getRequestState?.(scope),
          hydration: repository.getHydrationState?.(scope),
          error,
        }))
        throw error
      } finally {
        authorityTailInflight.delete(flightKey)
      }
    })()
    authorityTailInflight.set(flightKey, run)
    return run
  }

  const runAuthorityHotRevalidate = (
    scope: TranscriptScope,
    captured: ReturnType<typeof resolveScopeIdentity>,
  ): Promise<TranscriptData> => {
    const flightKey = scopeKey(captured)
    const existing = authorityTailInflight.get(flightKey)
    if (existing) return existing
    const run = (async () => {
      const startedAt = Date.now()
      const capturedLiveRevision = repository.getTranscript(scope).liveRevision
      authorityFlights.set(flightKey, { status: "loading" })
      try {
        const page = await fetchAuthorityTail(captured, { fresh: true })
        if (!liveIdentityMatches(captured)) {
          authorityFlights.delete(flightKey)
          return repository.getTranscript(scope)
        }
        const liveRevision = repository.getTranscript(scope).liveRevision
        // An in-flight user refresh (or a writer that dropped liveRevision
        // below the capture) must not lose to a lagging hot page.
        if (
          liveRevision < capturedLiveRevision
          || isTranscriptAuthorityRefreshInFlight(captured.sessionID, captured.directory)
        ) {
          authorityFlights.delete(flightKey)
          return repository.getTranscript(scope)
        }
        repository.apply(scope, {
          type: "http-page",
          purpose: "reconcile-page",
          page: {
            records: page.records.map((record) => ({
              info: record.info,
              parts: record.parts,
            })),
            complete: false,
            cursor: undefined,
            turnCount: 0,
          },
          capturedLiveRevision,
          liveRevision,
        })
        markSessionAuthorityRevalidated(captured.directory, captured.sessionID, {
          transport: captured.transport,
          generation: captured.generation,
        })
        authorityFlights.delete(flightKey)
        cacheBudget.noteScopeObserved(toCacheScope(scope))
        enforceBudgetAfterWrite(scope)
        return repository.getTranscript(scope)
      } catch (error) {
        authorityFlights.delete(flightKey)
        if (error instanceof SessionMessageRuntimeStaleError || !liveIdentityMatches(captured)) {
          return repository.getTranscript(scope)
        }
        recordTranscriptDiagnostics(snapshotTranscriptDiagnostics({
          kind: "request-error",
          sessionID: captured.sessionID,
          directory: captured.directory,
          transport: captured.transport,
          generation: captured.generation,
          source: "network",
          purpose: "reconcile-page",
          durationMs: Date.now() - startedAt,
          transcript: toTranscriptData(readData(scope), captured.sessionID),
          request: repository.getRequestState?.(scope),
          hydration: repository.getHydrationState?.(scope),
          error,
        }))
        // Failure Is Not Empty: keep the prior transcript and do not stamp the window.
        return repository.getTranscript(scope)
      } finally {
        authorityTailInflight.delete(flightKey)
      }
    })()
    authorityTailInflight.set(flightKey, run)
    return run
  }

  const needsAuthorityTail = (scope: TranscriptScope): boolean => {
    const data = readData(scope)
    if (!data || data.pages.length === 0) return true
    if (seededAuthorityPending.has(scopeKey(resolveScopeIdentity(scope, deps)))) return true
    return boundaryFromTranscriptData(data).kind === "unknown"
  }

  const repository: QueryTranscriptRepository = {
    getTranscript(scope) {
      const identity = resolveScopeIdentity(scope, deps)
      const key = scopeKey(identity)
      const data = toTranscriptData(readData(scope), identity.sessionID)
      return shareTranscript(key, data)
    },

    getPagination(scope) {
      const identity = resolveScopeIdentity(scope, deps)
      const key = scopeKey(identity)
      const transcript = repository.getTranscript(scope)
      return sharePagination(key, projectPagination(identity.sessionID, transcript.boundary))
    },

    getRequestState(scope): TranscriptRequestState {
      const identity = resolveScopeIdentity(scope, deps)
      const flight = authorityFlights.get(scopeKey(identity))
      if (flight?.status === "loading") {
        return { sessionID: identity.sessionID, status: "loading" }
      }
      if (flight?.status === "error") {
        return { sessionID: identity.sessionID, status: "error", error: flight.error }
      }
      const controller = controllers.get(scopeKey(identity))
      if (!controller) {
        const data = readData(scope)
        if (data && data.pages.length > 0) {
          return { sessionID: identity.sessionID, status: "ready" }
        }
        return { sessionID: identity.sessionID, status: "idle" }
      }
      const result = controller.observer.getCurrentResult()
      if (result.isLoading || result.isFetching) {
        return { sessionID: identity.sessionID, status: "loading" }
      }
      if (result.isError && result.error) {
        return {
          sessionID: identity.sessionID,
          status: "error",
          error: result.error instanceof Error ? result.error.message : String(result.error),
        }
      }
      if (result.data && (result.data as SessionTranscriptData).pages.length > 0) {
        return { sessionID: identity.sessionID, status: "ready" }
      }
      return { sessionID: identity.sessionID, status: "idle" }
    },

    getHydrationState(scope): TranscriptHydrationState {
      const identity = resolveScopeIdentity(scope, deps)
      const key = scopeKey(identity)
      const transcript = repository.getTranscript(scope)
      if (evaluateTranscriptP0Satisfied(transcript)) {
        p0Latches.set(key, true)
      }
      const p0Satisfied = p0Latches.has(key)
      return {
        sessionID: identity.sessionID,
        p0Satisfied,
        phase: resolveTranscriptHydrationPhase({
          p0Satisfied,
          prependActive: prependFlights.has(key),
          materializeActive: isMaterializeActive(identity),
          earlierHistoryLoaded: countTranscriptAuthoredUserTurns(transcript) > 1,
        }),
      }
    },

    /**
     * Resolved when the canonical Query holds a data entry for this scope.
     * Includes a successfully loaded empty tail (pages present, zero messages).
     * False when the query is absent (unknown / after reset remove / purge).
     */
    hasSession(scope) {
      // Presence of InfiniteData (including empty-record pages) marks resolved.
      // getQueryData is undefined only when no successful canonical entry exists.
      return readData(scope) !== undefined
    },

    getMessage(scope, messageID) {
      const identity = resolveScopeIdentity(scope, deps)
      const key = scopeKey(identity)
      const cache = getProjection(key)
      const transcript = repository.getTranscript(scope)
      const next = transcript.messagesByID[messageID]
      if (cache.messages.has(messageID) && cache.messages.get(messageID) === next) {
        return cache.messages.get(messageID)
      }
      cache.messages.set(messageID, next)
      return next
    },

    getParts(scope, messageID) {
      const identity = resolveScopeIdentity(scope, deps)
      const key = scopeKey(identity)
      const cache = getProjection(key)
      const transcript = repository.getTranscript(scope)
      const next = transcript.partsByMessageID[messageID] ?? EMPTY_PARTS
      const prev = cache.parts.get(messageID)
      if (prev === next || (prev && next && prev.length === next.length && prev.every((p, i) => p === next[i]))) {
        return prev ?? next
      }
      cache.parts.set(messageID, next)
      return next
    },

    getMessageMaterializationState(scope, messageID): TranscriptMessageMaterializationState {
      const identity = resolveScopeIdentity(scope, deps)
      const stored = messageStates.get(messageStateKey(identity, messageID))
      if (stored) {
        return {
          sessionID: identity.sessionID,
          messageID,
          status: stored.status,
          ...(stored.error !== undefined ? { error: stored.error } : {}),
        }
      }
      if (!repository.getMessage(scope, messageID)) {
        return { sessionID: identity.sessionID, messageID, status: "idle" }
      }
      if (durableSeededExact.get(scopeKey(identity))?.has(messageID)) {
        return { sessionID: identity.sessionID, messageID, status: "idle" }
      }
      if (messageNeedsExactMaterialization(repository.getParts(scope, messageID))) {
        return { sessionID: identity.sessionID, messageID, status: "idle" }
      }
      return { sessionID: identity.sessionID, messageID, status: "ready" }
    },

    async materializeMessage(scope, messageID) {
      const captured = resolveScopeIdentity(scope, deps)
      const flightKey = messageStateKey(captured, messageID)
      const materializeDiffBefore = tryCaptureTranscriptCanonicalSnapshot(() =>
        repository.getTranscript(scope),
      )
      const recordMaterializeDiff = (readAfter: () => TranscriptData) => {
        try {
          const after = tryCaptureTranscriptCanonicalSnapshot(readAfter)
          if (!materializeDiffBefore || !after) return
          recordTranscriptDiff({
            trigger: "materialize",
            sessionID: captured.sessionID,
            directory: captured.directory,
            transport: captured.transport,
            generation: captured.generation,
            purpose: "exact",
            before: materializeDiffBefore,
            after,
          })
        } catch {
          // Diagnostics must never affect materialize.
        }
      }
      const existing = messageFlights.get(flightKey)
      if (existing) {
        void existing.then((data) => recordMaterializeDiff(() => data)).catch(() => undefined)
        return existing
      }

      const run = (async (): Promise<TranscriptData> => {
        try {
          const info = repository.getMessage(scope, messageID)
          if (!info) {
            messageStates.set(flightKey, { status: "idle" })
            return repository.getTranscript(scope)
          }
          if (
            !messageNeedsExactMaterialization(repository.getParts(scope, messageID))
            && !durableSeededExact.get(scopeKey(captured))?.has(messageID)
          ) {
            messageStates.set(flightKey, { status: "ready" })
            return repository.getTranscript(scope)
          }

          messageStates.set(flightKey, { status: "loading" })
          notify(scope)
          try {
            const record = await fetchExactSessionMessageRecord({
              transport: captured.transport,
              generation: captured.generation,
              directory: captured.directory,
              sessionID: captured.sessionID,
              messageID,
              request: async () => {
                if (deps.fetchMessage) {
                  const next = await deps.fetchMessage({
                    directory: captured.directory,
                    sessionID: captured.sessionID,
                    messageID,
                  })
                  return { data: { info: next.info, parts: [...(next.parts ?? [])] } }
                }
                const scoped = opencodeClient.getScopedSdkClient(captured.directory)
                return scoped.session.message({
                  sessionID: captured.sessionID,
                  messageID,
                  directory: captured.directory,
                })
              },
            })
            if (!liveIdentityMatches(captured)) {
              messageStates.delete(flightKey)
              return repository.getTranscript(scope)
            }
            repository.apply(scope, {
              type: "materialize-snapshots",
              records: [{ info: record.info, parts: record.parts ?? [] }],
            })
            if (messageNeedsExactMaterialization(repository.getParts(scope, messageID))) {
              messageStates.set(flightKey, {
                status: "error",
                error: "session.message failed: slim parts remain",
              })
            } else {
              messageStates.set(flightKey, { status: "ready" })
            }
            notify(scope)
            return repository.getTranscript(scope)
          } catch (error) {
            if (!liveIdentityMatches(captured)) {
              messageStates.delete(flightKey)
              return repository.getTranscript(scope)
            }
            const message = error instanceof Error ? error.message : "session.message failed"
            messageStates.set(flightKey, { status: "error", error: message })
            notify(scope)
            return repository.getTranscript(scope)
          }
        } finally {
          clearDurableSeededExactMessage(captured, messageID)
        }
      })()

      messageFlights.set(flightKey, run)
      void run.then((data) => recordMaterializeDiff(() => data)).catch(() => undefined)
      void run.finally(() => {
        if (messageFlights.get(flightKey) === run) messageFlights.delete(flightKey)
      })
      return run
    },

    apply(scope, command: TranscriptCommand): TranscriptCommandResult {
      const identity = resolveScopeIdentity(scope, deps)
      const queryKey = queryKeyFor(scope)
      const result = ((): TranscriptCommandResult => {
      switch (command.type) {
        case "http-page": {
          const merge = applySessionTranscriptMerge(
            client,
            queryKey,
            identity.sessionID,
            {
              type: "http-page",
              purpose: command.purpose,
              page: command.page,
              capturedLiveRevision: command.capturedLiveRevision,
              liveRevision: command.liveRevision,
              skipPartTypes: command.skipPartTypes,
              optimistic: command.optimistic,
            },
          )
          if (merge.result.applied) seededAuthorityPending.delete(scopeKey(identity))
          if (merge.result.changed) {
            notify(scope)
            enforceBudgetAfterWrite(scope)
          }
          return merge.result
        }
        case "sse-event": {
          const merge = applySessionTranscriptMerge(
            client,
            queryKey,
            identity.sessionID,
            { type: "sse-event", event: command.event },
          )
          if (merge.result.applied) seededAuthorityPending.delete(scopeKey(identity))
          if (merge.result.changed) notify(scope)
          return merge.result
        }
        case "sse-event-batch": {
          const merge = applySessionTranscriptMerge(
            client,
            queryKey,
            identity.sessionID,
            { type: "sse-event-batch", events: command.events },
          )
          if (merge.result.applied) seededAuthorityPending.delete(scopeKey(identity))
          if (merge.result.changed) notify(scope)
          return merge.result
        }
        case "optimistic-add": {
          deps.setOptimisticShadow?.({
            directory: identity.directory,
            sessionID: identity.sessionID,
            message: command.message,
            parts: command.parts,
          })
          const merge = applySessionTranscriptMerge(
            client,
            queryKey,
            identity.sessionID,
            {
              type: "optimistic-add",
              message: command.message,
              parts: command.parts,
            },
          )
          if (merge.result.changed) notify(scope)
          return merge.result
        }
        case "optimistic-confirm": {
          deps.clearOptimisticShadow?.({
            directory: identity.directory,
            sessionID: identity.sessionID,
            messageID: command.messageID,
          })
          const merge = applySessionTranscriptMerge(
            client,
            queryKey,
            identity.sessionID,
            { type: "optimistic-confirm", messageID: command.messageID },
          )
          return merge.result
        }
        case "optimistic-remove": {
          deps.clearOptimisticShadow?.({
            directory: identity.directory,
            sessionID: identity.sessionID,
            messageID: command.messageID,
          })
          const merge = applySessionTranscriptMerge(
            client,
            queryKey,
            identity.sessionID,
            { type: "optimistic-remove", messageID: command.messageID },
          )
          if (merge.result.changed) notify(scope)
          return merge.result
        }
        case "reset": {
          prependFlights.delete(scopeKey(identity))
          durableSeededExact.delete(scopeKey(identity))
          seededAuthorityPending.delete(scopeKey(identity))
          // Clear reserved task/checkpoint/transport families alongside the
          // canonical reset so old cursor chains cannot survive.
          cacheBudget.purgeSession(toCacheScope(scope))
          if (!command.page) {
            notify(scope)
            return { applied: true, changed: true }
          }
          const merge = applySessionTranscriptMerge(
            client,
            queryKey,
            identity.sessionID,
            {
              type: "reset",
              page: command.page,
              capturedLiveRevision: command.capturedLiveRevision,
              liveRevision: command.liveRevision,
              skipPartTypes: command.skipPartTypes,
            },
          )
          if (merge.result.changed || merge.result.applied) {
            notify(scope)
            enforceBudgetAfterWrite(scope)
          }
          return merge.result
        }
        case "materialize-snapshots": {
          return applyMaterializeSnapshots(
            client,
            queryKey,
            identity.sessionID,
            command,
            () => notify(scope),
          )
        }
        case "remove-message": {
          const merge = applySessionTranscriptMerge(
            client,
            queryKey,
            identity.sessionID,
            { type: "optimistic-remove", messageID: command.messageID },
          )
          if (merge.result.changed) notify(scope)
          return merge.result
        }
        default: {
          const _exhaustive: never = command
          void _exhaustive
          return { applied: false, changed: false }
        }
      }
      })()
      scheduleDurableAfterApply(scope, identity, command, result)
      if (result.applied) {
        recordTranscriptCommandDiagnostics({
          directory: identity.directory,
          sessionID: identity.sessionID,
          transport: identity.transport,
          generation: identity.generation,
          command,
          transcript: toTranscriptData(readData(scope), identity.sessionID),
          request: repository.getRequestState?.(scope),
          hydration: repository.getHydrationState?.(scope),
          error: result.error,
          changed: result.changed,
        })
        recordHydrationPaint(scope, identity)
      }
      return result
    },

    subscribe(scope, listener) {
      const identity = resolveScopeIdentity(scope, deps)
      const key = scopeKey(identity)
      let set = listeners.get(key)
      if (!set) {
        set = new Set()
        listeners.set(key, set)
        // First listener for this scope → retain as active (repository
        // listeners do not increment Query observer counts).
        const cacheScope = toCacheScope(scope)
        listenerRetainReleases.set(key, activeRegistry.retain(cacheScope))
        cacheBudget.noteScopeObserved(cacheScope)
      }
      set.add(listener)
      ensureCacheSubscription(scope)
      return () => {
        const current = listeners.get(key)
        if (!current) return
        current.delete(listener)
        if (current.size === 0) {
          const releaseRetain = listenerRetainReleases.get(key)
          if (releaseRetain) {
            releaseRetain()
            listenerRetainReleases.delete(key)
          }
        }
        releaseIfIdle(key)
      }
    },

    async ensureInitial(scope) {
      const captured = resolveScopeIdentity(scope, deps)
      const flightKey = scopeKey(captured)
      if (durableQueue) await durableQueue.wait(toTranscriptDurableScope(captured))

      const canonicalEmpty = readData(scope) === undefined
      if (canonicalEmpty && deps.durableStore) {
        try {
          const session = await deps.durableStore.readSession(toTranscriptDurableScope(captured))
          if (liveIdentityMatches(captured) && readData(scope) === undefined && session.records.length > 0) {
            suppressDurableWrite += 1
            try {
              repository.apply(scope, {
                type: "materialize-snapshots",
                records: session.records.map((record) => ({
                  info: record.info,
                  parts: [...record.parts],
                })),
              })
              const pending = new Set<string>()
              for (const record of session.records) {
                if (!messageNeedsExactRevalidation(record.parts, record.info)) continue
                pending.add(record.info.id)
              }
              if (pending.size > 0) durableSeededExact.set(flightKey, pending)
              // Seeded tail still owes one authority fetch: clear only after an
              // http-page / SSE frame lands (see apply below). Independent of
              // whether any message still needs exact revalidation.
              seededAuthorityPending.add(flightKey)
            } finally {
              suppressDurableWrite -= 1
            }
          }
        } catch (error) {
          recordTranscriptDiagnostics(snapshotTranscriptDiagnostics({
            kind: "request-error",
            sessionID: captured.sessionID,
            directory: captured.directory,
            transport: captured.transport,
            generation: captured.generation,
            source: "durable-cache",
            purpose: "durable-seed",
            error,
          }))
        }
      }

      // Seeded (or still-unknown) canonical must not go through the InfiniteQuery
      // controller — pages.length > 0 would skip the authority tail.
      if (needsAuthorityTail(scope) && readData(scope) !== undefined) {
        const startedAt = Date.now()
        const transcript = await runAuthorityInitial(scope, captured)
        recordTranscriptDiagnostics(snapshotTranscriptDiagnostics({
          kind: "ensure-initial",
          sessionID: captured.sessionID,
          directory: captured.directory,
          transport: captured.transport,
          generation: captured.generation,
          source: "network",
          durationMs: Date.now() - startedAt,
          transcript,
          request: repository.getRequestState?.(scope),
          hydration: repository.getHydrationState?.(scope),
        }))
        recordHydrationPaint(scope, captured)
        return transcript
      }

      // Enter-and-sync: a known hot cache still does one light authority check.
      // Active retain means the UI is already subscribed and SSE owns the tail.
      const canonical = readData(scope)
      if (
        canonical
        && canonical.pages.length > 0
        && !needsAuthorityTail(scope)
        && deps.fetcher
        && !activeRegistry.isRetained(toCacheScope(scope))
      ) {
        const startedAt = Date.now()
        const transcript = await runAuthorityHotRevalidate(scope, captured)
        recordTranscriptDiagnostics(snapshotTranscriptDiagnostics({
          kind: "ensure-initial",
          sessionID: captured.sessionID,
          directory: captured.directory,
          transport: captured.transport,
          generation: captured.generation,
          source: "network",
          durationMs: Date.now() - startedAt,
          transcript,
          request: repository.getRequestState?.(scope),
          hydration: repository.getHydrationState?.(scope),
        }))
        recordHydrationPaint(scope, captured)
        return transcript
      }

      const controller = ensureController(scope)
      const startedAt = Date.now()
      const hadCanonical = readData(scope) !== undefined
      // Drop a stale authority error so observer status can become ready.
      authorityFlights.delete(flightKey)
      try {
        await controller.ensureInitial()
      } catch (error) {
        recordTranscriptDiagnostics(snapshotTranscriptDiagnostics({
          kind: "request-error",
          sessionID: captured.sessionID,
          directory: captured.directory,
          transport: captured.transport,
          generation: captured.generation,
          source: hadCanonical ? "query-cache" : "network",
          purpose: "initial",
          durationMs: Date.now() - startedAt,
          transcript: toTranscriptData(readData(scope), captured.sessionID),
          request: repository.getRequestState?.(scope),
          hydration: repository.getHydrationState?.(scope),
          error,
        }))
        throw error
      }
      authorityFlights.delete(flightKey)
      if (!hadCanonical) {
        markSessionAuthorityRevalidated(captured.directory, captured.sessionID, {
          transport: captured.transport,
          generation: captured.generation,
        })
      }
      // Start min-residency from this ensure so immediate enforce cannot evict.
      cacheBudget.noteScopeObserved(toCacheScope(scope))
      enforceBudgetAfterWrite(scope)
      const transcript = repository.getTranscript(scope)
      recordTranscriptDiagnostics(snapshotTranscriptDiagnostics({
        kind: "ensure-initial",
        sessionID: captured.sessionID,
        directory: captured.directory,
        transport: captured.transport,
        generation: captured.generation,
        source: hadCanonical ? "query-cache" : "network",
        durationMs: Date.now() - startedAt,
        transcript,
        request: repository.getRequestState?.(scope),
        hydration: repository.getHydrationState?.(scope),
      }))
      recordHydrationPaint(scope, captured)
      return transcript
    },

    async fetchPreviousPage(scope) {
      if (needsAuthorityTail(scope)) {
        await repository.ensureInitial(scope)
      }
      const boundary = boundaryFromTranscriptData(readData(scope))
      if (boundary.kind !== "has-more") {
        return repository.getTranscript(scope)
      }
      const captured = resolveScopeIdentity(scope, deps)
      const flightKey = scopeKey(captured)
      prependFlights.add(flightKey)
      notify(scope)
      const startedAt = Date.now()
      try {
        const controller = ensureController(scope)
        await controller.fetchPreviousPage()
        // Active transcript retains all pages; enforce only bounds inactive peers.
        enforceBudgetAfterWrite(scope)
        const transcript = repository.getTranscript(scope)
        recordTranscriptDiagnostics(snapshotTranscriptDiagnostics({
          kind: "http-page",
          sessionID: captured.sessionID,
          directory: captured.directory,
          transport: captured.transport,
          generation: captured.generation,
          source: "network",
          durationMs: Date.now() - startedAt,
          purpose: "prepend",
          command: "http-page",
          transcript,
          request: repository.getRequestState?.(scope),
          hydration: repository.getHydrationState?.(scope),
        }))
        return transcript
      } catch (error) {
        recordTranscriptDiagnostics(snapshotTranscriptDiagnostics({
          kind: "request-error",
          sessionID: captured.sessionID,
          directory: captured.directory,
          transport: captured.transport,
          generation: captured.generation,
          source: "network",
          durationMs: Date.now() - startedAt,
          purpose: "prepend",
          error,
        }))
        throw error
      } finally {
        prependFlights.delete(flightKey)
        notify(scope)
      }
    },

    getController(scope) {
      const identity = resolveScopeIdentity(scope, deps)
      return controllers.get(scopeKey(identity))
    },

    getCacheBudget() {
      return cacheBudget
    },

    async refreshFromAuthority(scope) {
      if (!deps.fetcher) {
        throw new Error(
          "Query transcript repository requires a fetcher for refreshFromAuthority",
        )
      }
      const identity = resolveScopeIdentity(scope, deps)
      const refreshDiffBefore = tryCaptureTranscriptCanonicalSnapshot(() =>
        repository.getTranscript(scope),
      )
      const capturedLiveRevision = repository.getTranscript(scope).liveRevision
      const page = await deps.fetcher({
        directory: identity.directory,
        sessionID: identity.sessionID,
        limit: deps.initialLimit ?? getInitialSessionTurnLimit(),
        signal: new AbortController().signal,
      })
      const liveRevision = repository.getTranscript(scope).liveRevision
      repository.apply(scope, {
        type: "http-page",
        purpose: "reconcile-page",
        page: {
          records: page.records.map((record) => ({
            info: record.info,
            parts: record.parts,
          })),
          complete: false,
          cursor: undefined,
          turnCount: 0,
        },
        capturedLiveRevision,
        liveRevision,
      })
      // Stale tail is not evidence the server deleted in-range rows.
      if (liveRevision <= capturedLiveRevision) {
        const removals = collectAuthorityRefreshRemovals(
          repository.getTranscript(scope),
          page,
        )
        for (const messageID of removals) {
          repository.apply(scope, { type: "remove-message", messageID })
          deps.clearOptimisticShadow?.({
            directory: identity.directory,
            sessionID: identity.sessionID,
            messageID,
          })
        }
      }
      const next = repository.getTranscript(scope)
      cacheBudget.noteScopeObserved(toCacheScope(scope))
      try {
        const refreshDiffAfter = tryCaptureTranscriptCanonicalSnapshot(() => next)
        if (refreshDiffBefore && refreshDiffAfter) {
          recordTranscriptDiff({
            trigger: "user-refresh",
            sessionID: identity.sessionID,
            directory: identity.directory,
            transport: identity.transport,
            generation: identity.generation,
            purpose: "refresh-from-authority",
            before: refreshDiffBefore,
            after: refreshDiffAfter,
          })
        }
      } catch {
        // Diagnostics must never affect authority refresh.
      }
      return next
    },

    async destructiveReset(scope) {
      const resetDiffBefore = tryCaptureTranscriptCanonicalSnapshot(() =>
        repository.getTranscript(scope),
      )
      const cacheScope = toCacheScope(scope)
      if (durableQueue) {
        await durableQueue.clearSession(toTranscriptDurableScope(resolveScopeIdentity(scope, deps)))
      }
      return cacheBudget.destructiveReset(cacheScope, async () => {
        // Destroy any stale controller so the next ensure builds a fresh chain.
        const identity = resolveScopeIdentity(scope, deps)
        const key = scopeKey(identity)
        const existing = controllers.get(key)
        if (existing) {
          existing.destroy()
          controllers.delete(key)
        }
        projectionCache.delete(key)
        clearHydration(key)
        if (!deps.fetcher) {
          throw new Error(
            "Query transcript repository requires a fetcher for destructiveReset ensure",
          )
        }
        const next = await repository.ensureInitial(scope)
        try {
          const resetDiffAfter = tryCaptureTranscriptCanonicalSnapshot(() => next)
          if (resetDiffBefore && resetDiffAfter) {
            recordTranscriptDiff({
              trigger: "destructive-reset",
              sessionID: identity.sessionID,
              directory: identity.directory,
              transport: identity.transport,
              generation: identity.generation,
              before: resetDiffBefore,
              after: resetDiffAfter,
            })
          }
        } catch {
          // Diagnostics must never affect destructiveReset.
        }
        return next
      })
    },

    purgeSession(scope) {
      const identity = resolveScopeIdentity(scope, deps)
      const key = scopeKey(identity)
      const existing = controllers.get(key)
      if (existing) {
        existing.destroy()
        controllers.delete(key)
      }
      projectionCache.delete(key)
      clearMessageMaterialization(`${key}\n`)
      durableSeededExact.delete(key)
      clearHydration(key)
      cacheBudget.purgeSession(toCacheScope(scope))
      notify(scope)
    },

    /** Purge every transcript family under a transport generation (runtime switch). */
    purgeGeneration(transport: string, generation: number) {
      // Drop controllers pinned to the old generation so stale flights cannot
      // re-seed the cache after purge.
      for (const [key, controller] of controllers) {
        if (key.startsWith(`${transport}\n${generation}\n`)) {
          controller.destroy()
          controllers.delete(key)
          projectionCache.delete(key)
          const release = listenerRetainReleases.get(key)
          if (release) {
            release()
            listenerRetainReleases.delete(key)
          }
          const unsub = cacheUnsubs.get(key)
          if (unsub) {
            unsub()
            cacheUnsubs.delete(key)
          }
          listeners.delete(key)
        }
      }
      clearMessageMaterialization(`${transport}\n${generation}\n`)
      clearDurableSeededExact(`${transport}\n${generation}\n`)
      clearHydration(`${transport}\n${generation}\n`)
      cacheBudget.purgeGeneration(transport, generation)
      if (durableQueue) {
        void durableQueue.clearGeneration({ transport, generation })
      }
    },

    destroy() {
      for (const controller of controllers.values()) controller.destroy()
      controllers.clear()
      for (const unsub of cacheUnsubs.values()) unsub()
      cacheUnsubs.clear()
      for (const release of listenerRetainReleases.values()) release()
      listenerRetainReleases.clear()
      listeners.clear()
      projectionCache.clear()
      authorityFlights.clear()
      authorityTailInflight.clear()
      messageStates.clear()
      messageFlights.clear()
      durableSeededExact.clear()
      p0Latches.clear()
      p0Painted.clear()
      prependFlights.clear()
      cacheBudget.dispose()
    },
  }

  return repository
}

const EMPTY_PARTS: readonly Part[] = Object.freeze([])

function applyMaterializeSnapshots(
  client: QueryClient,
  queryKey: SessionTranscriptQueryKey,
  sessionID: string,
  command: Extract<TranscriptCommand, { type: "materialize-snapshots" }>,
  onChanged: () => void,
): TranscriptCommandResult {
  if (command.records.length === 0) {
    return { applied: false, changed: false }
  }

  const merge = applySessionTranscriptMerge(client, queryKey, sessionID, {
    type: "durable-seed",
    records: command.records,
    skipPartTypes: command.skipPartTypes,
    merge: command.merge,
  })
  if (merge.result.changed) onChanged()
  return merge.result
}
