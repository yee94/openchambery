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
 */

import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import type { QueryClient } from "@tanstack/react-query"

import { queryClient as defaultQueryClient } from "@/lib/queryRuntime"
import {
  getRuntimeGeneration,
  getRuntimeTransportIdentity,
} from "@/lib/runtime-switch"

import {
  applySessionTranscriptMerge,
  createSessionTranscriptController,
  readSessionTranscriptData,
  sessionTranscriptQueryKey,
  type SessionMessageRuntimeProbe,
  type SessionTranscriptController,
  type SessionTranscriptFetcher,
  type SessionTranscriptQueryKey,
} from "./session-message-query"
import { materializeSessionSnapshots } from "./materialization"
import {
  boundaryFromTranscriptData,
  flattenTranscriptData,
  freezeSessionTranscriptData,
  mergeSessionTranscript,
  projectFlatFromTranscriptData,
  type SessionTranscriptData,
  type TranscriptPage,
} from "./transcript-merge"
import type { ReduceSessionMessagePageResult } from "./session-message-reducer"
import {
  createTranscriptActiveScopeRegistry,
  createTranscriptQueryCacheBudget,
  type TranscriptActiveScopeRegistry,
  type TranscriptCacheScope,
  type TranscriptQueryCacheBudget,
} from "./session-transcript-query-cache"
import {
  projectPagination,
  type TranscriptChangeListener,
  type TranscriptCommand,
  type TranscriptCommandResult,
  type TranscriptData,
  type TranscriptPagination,
  type TranscriptRepository,
  type TranscriptRequestState,
  type TranscriptScope,
} from "./transcript-repository"
import { UNKNOWN_SESSION_HISTORY_BOUNDARY } from "./types"

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
  /** Evict one session's transcript key families (delete / ordinary eviction). */
  purgeSession: (scope: TranscriptScope) => void
  /** Purge all transcript families for a transport generation (runtime switch). */
  purgeGeneration: (transport: string, generation: number) => void
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

    apply(scope, command: TranscriptCommand): TranscriptCommandResult {
      const identity = resolveScopeIdentity(scope, deps)
      const queryKey = queryKeyFor(scope)

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
      const controller = ensureController(scope)
      await controller.ensureInitial()
      // Start min-residency from this ensure so immediate enforce cannot evict.
      cacheBudget.noteScopeObserved(toCacheScope(scope))
      enforceBudgetAfterWrite(scope)
      return repository.getTranscript(scope)
    },

    async fetchPreviousPage(scope) {
      const controller = ensureController(scope)
      // Ensure we have a tail first.
      if (!controller.getData() || controller.getData()!.pages.length === 0) {
        await controller.ensureInitial()
        cacheBudget.noteScopeObserved(toCacheScope(scope))
      }
      await controller.fetchPreviousPage()
      // Active transcript retains all pages; enforce only bounds inactive peers.
      enforceBudgetAfterWrite(scope)
      return repository.getTranscript(scope)
    },

    getController(scope) {
      const identity = resolveScopeIdentity(scope, deps)
      return controllers.get(scopeKey(identity))
    },

    getCacheBudget() {
      return cacheBudget
    },

    async destructiveReset(scope) {
      const cacheScope = toCacheScope(scope)
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
        if (!deps.fetcher) {
          throw new Error(
            "Query transcript repository requires a fetcher for destructiveReset ensure",
          )
        }
        return repository.ensureInitial(scope)
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
      cacheBudget.purgeGeneration(transport, generation)
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

  let result: TranscriptCommandResult = { applied: true, changed: false }
  client.setQueryData<SessionTranscriptData>(queryKey, (previous) => {
    const flat = flattenTranscriptData(previous, sessionID)
    const materialized = materializeSessionSnapshots(
      { message: flat.message, part: flat.part },
      sessionID,
      command.records.map((record) => ({
        info: record.info,
        parts: record.parts ? [...record.parts] : [],
      })),
      {
        skipPartTypes: command.skipPartTypes,
        merge: command.merge,
      },
    )
    if (!materialized.messagesChanged && !materialized.partsChanged) {
      return previous
    }
    result = { applied: true, changed: true }
    const previousBoundary = boundaryFromTranscriptData(previous)
    const merge = mergeSessionTranscript(previous, sessionID, {
      type: "http-page",
      purpose: "materialize",
      page: {
        records: materialized.messages.map((info) => ({
          info,
          parts: materialized.part[info.id] ?? [],
        })),
        complete: previousBoundary.kind === "exhausted",
        cursor:
          previousBoundary.kind === "has-more"
            ? previousBoundary.cursor
            : undefined,
        turnCount: 0,
      },
      liveRevision:
        previous?.pages[previous.pages.length - 1]?.sync.liveRevision ?? 0,
    })
    return merge.data ?? previous
  })
  if (result.changed) onChanged()
  return result
}
