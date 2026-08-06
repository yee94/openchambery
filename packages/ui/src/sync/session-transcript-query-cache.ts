/**
 * QueryCache transcript lifecycle (Ticket 08).
 *
 * - Active transcripts (TanStack observers OR repository listener scopes)
 *   retain every loaded page.
 * - Inactive canonical sessions are bounded per transport / generation /
 *   directory by the platform capacity target (VS Code 4 / mobile 12 /
 *   default 40), ordered by canonical `dataUpdatedAt` LRU.
 * - Purge cancels then removes canonical, transport-page, and reserved
 *   tail / reconcile / checkpoint key families.
 * - Destructive reset clears the old cursor/task/checkpoint chain, ensures a
 *   fresh authoritative tail, and never restores old data after a failed ensure.
 *
 * Key-family shapes are centralized here for Ticket 07 recovery tasks.
 */

import type { Query, QueryClient, QueryKey } from "@tanstack/react-query"

import {
  sessionMessagePageQueryKey,
  sessionTranscriptQueryKey,
  type SessionTranscriptQueryKey,
} from "./session-message-query"
import { getEffectiveSessionCacheLimit } from "./session-cache-limits"

// ---------------------------------------------------------------------------
// Scope identity
// ---------------------------------------------------------------------------

export type TranscriptCacheScope = {
  readonly transport: string
  readonly generation: number
  readonly directory: string
  readonly sessionID: string
}

const normalizeDirectory = (directory: string): string => directory.trim()

export function normalizeTranscriptCacheScope(
  scope: TranscriptCacheScope,
): TranscriptCacheScope {
  return {
    transport: scope.transport,
    generation: scope.generation,
    directory: normalizeDirectory(scope.directory),
    sessionID: scope.sessionID,
  }
}

export function transcriptCacheScopeKey(scope: TranscriptCacheScope): string {
  const n = normalizeTranscriptCacheScope(scope)
  return `${n.transport}\n${n.generation}\n${n.directory}\n${n.sessionID}`
}

function transcriptCacheDirectoryBucketKey(
  scope: Pick<TranscriptCacheScope, "transport" | "generation" | "directory">,
): string {
  return `${scope.transport}\n${scope.generation}\n${normalizeDirectory(scope.directory)}`
}

// ---------------------------------------------------------------------------
// Key family shapes (canonical + transport + reserved Ticket 07 families)
// ---------------------------------------------------------------------------

/** Domain tokens for transcript Query key families. */
const TRANSCRIPT_QUERY_KEY_DOMAINS = {
  canonical: "session-transcript",
  transportPageRoot: "sessionMessages",
  transportPageKind: "page",
  taskRoot: "session-transcript-task",
  tailTaskKind: "tail",
  reconcileTaskKind: "reconcile",
  checkpoint: "session-transcript-checkpoint",
} as const

export type SessionTranscriptTailTaskQueryKey = readonly [
  string,
  number,
  typeof TRANSCRIPT_QUERY_KEY_DOMAINS.taskRoot,
  typeof TRANSCRIPT_QUERY_KEY_DOMAINS.tailTaskKind,
  string,
  string,
  string,
]

export type SessionTranscriptReconcileTaskQueryKey = readonly [
  string,
  number,
  typeof TRANSCRIPT_QUERY_KEY_DOMAINS.taskRoot,
  typeof TRANSCRIPT_QUERY_KEY_DOMAINS.reconcileTaskKind,
  string,
  string,
  string,
]

export type SessionTranscriptCheckpointQueryKey = readonly [
  string,
  number,
  typeof TRANSCRIPT_QUERY_KEY_DOMAINS.checkpoint,
  string,
  string,
]

/** Reserved: recovery/materialize tail orchestration (Ticket 07). */
export function sessionTranscriptTailTaskQueryKey(
  params: {
    directory: string
    sessionID: string
    purpose: string
  },
  transport: string,
  generation: number,
): SessionTranscriptTailTaskQueryKey {
  return [
    transport,
    generation,
    TRANSCRIPT_QUERY_KEY_DOMAINS.taskRoot,
    TRANSCRIPT_QUERY_KEY_DOMAINS.tailTaskKind,
    normalizeDirectory(params.directory),
    params.sessionID,
    params.purpose,
  ]
}

/** Reserved: multi-page anchor reconcile task (Ticket 07). */
export function sessionTranscriptReconcileTaskQueryKey(
  params: {
    directory: string
    sessionID: string
    checkpoint: string
  },
  transport: string,
  generation: number,
): SessionTranscriptReconcileTaskQueryKey {
  return [
    transport,
    generation,
    TRANSCRIPT_QUERY_KEY_DOMAINS.taskRoot,
    TRANSCRIPT_QUERY_KEY_DOMAINS.reconcileTaskKind,
    normalizeDirectory(params.directory),
    params.sessionID,
    params.checkpoint,
  ]
}

/** Reserved: disconnect/visibility recovery checkpoint (Ticket 07). */
export function sessionTranscriptCheckpointQueryKey(
  params: { directory: string; sessionID: string },
  transport: string,
  generation: number,
): SessionTranscriptCheckpointQueryKey {
  return [
    transport,
    generation,
    TRANSCRIPT_QUERY_KEY_DOMAINS.checkpoint,
    normalizeDirectory(params.directory),
    params.sessionID,
  ]
}

export type TranscriptKeyFamily =
  | "canonical"
  | "transport-page"
  | "tail-task"
  | "reconcile-task"
  | "checkpoint"

/**
 * Predicate: does this query key belong to a transcript key family for the
 * given session scope (or any session when sessionID is omitted)?
 */
export function isTranscriptSessionQueryKey(
  queryKey: readonly unknown[],
  scope: {
    transport: string
    generation: number
    directory?: string
    sessionID?: string
  },
  family?: TranscriptKeyFamily | "any",
): boolean {
  if (!Array.isArray(queryKey) || queryKey.length < 3) return false
  if (queryKey[0] !== scope.transport) return false
  if (queryKey[1] !== scope.generation) return false

  const directory =
    scope.directory === undefined ? undefined : normalizeDirectory(scope.directory)
  const domain = queryKey[2]

  const matchSession = (dirIndex: number, sessionIndex: number): boolean => {
    if (directory !== undefined && queryKey[dirIndex] !== directory) return false
    if (scope.sessionID !== undefined && queryKey[sessionIndex] !== scope.sessionID) {
      return false
    }
    return true
  }

  const want = family ?? "any"

  if (
    (want === "any" || want === "canonical")
    && domain === TRANSCRIPT_QUERY_KEY_DOMAINS.canonical
    && queryKey.length >= 5
    && matchSession(3, 4)
  ) {
    return true
  }

  if (
    (want === "any" || want === "transport-page")
    && domain === TRANSCRIPT_QUERY_KEY_DOMAINS.transportPageRoot
    && queryKey[3] === TRANSCRIPT_QUERY_KEY_DOMAINS.transportPageKind
    && queryKey.length >= 6
    && matchSession(4, 5)
  ) {
    return true
  }

  if (
    domain === TRANSCRIPT_QUERY_KEY_DOMAINS.taskRoot
    && queryKey.length >= 7
  ) {
    if (
      (want === "any" || want === "tail-task")
      && queryKey[3] === TRANSCRIPT_QUERY_KEY_DOMAINS.tailTaskKind
      && matchSession(4, 5)
    ) {
      return true
    }
    if (
      (want === "any" || want === "reconcile-task")
      && queryKey[3] === TRANSCRIPT_QUERY_KEY_DOMAINS.reconcileTaskKind
      && matchSession(4, 5)
    ) {
      return true
    }
  }

  if (
    (want === "any" || want === "checkpoint")
    && domain === TRANSCRIPT_QUERY_KEY_DOMAINS.checkpoint
    && queryKey.length >= 5
    && matchSession(3, 4)
  ) {
    return true
  }

  return false
}

/** Prefix filters covering every transcript key family for one session. */
export function transcriptSessionKeyFamilyFilters(
  scope: TranscriptCacheScope,
): readonly { queryKey: QueryKey; exact?: boolean }[] {
  const n = normalizeTranscriptCacheScope(scope)
  return [
    {
      queryKey: sessionTranscriptQueryKey(
        { directory: n.directory, sessionID: n.sessionID },
        n.transport,
        n.generation,
      ),
      exact: true,
    },
    {
      // All transport pages for this session (any limit/cursor).
      queryKey: [
        n.transport,
        n.generation,
        TRANSCRIPT_QUERY_KEY_DOMAINS.transportPageRoot,
        TRANSCRIPT_QUERY_KEY_DOMAINS.transportPageKind,
        n.directory,
        n.sessionID,
      ],
    },
    {
      // Tail tasks: [transport, gen, taskRoot, "tail", dir, session, purpose]
      queryKey: [
        n.transport,
        n.generation,
        TRANSCRIPT_QUERY_KEY_DOMAINS.taskRoot,
        TRANSCRIPT_QUERY_KEY_DOMAINS.tailTaskKind,
        n.directory,
        n.sessionID,
      ],
    },
    {
      // Reconcile tasks: [transport, gen, taskRoot, "reconcile", dir, session, checkpoint]
      queryKey: [
        n.transport,
        n.generation,
        TRANSCRIPT_QUERY_KEY_DOMAINS.taskRoot,
        TRANSCRIPT_QUERY_KEY_DOMAINS.reconcileTaskKind,
        n.directory,
        n.sessionID,
      ],
    },
    {
      queryKey: sessionTranscriptCheckpointQueryKey(
        { directory: n.directory, sessionID: n.sessionID },
        n.transport,
        n.generation,
      ),
      exact: true,
    },
  ]
}

// ---------------------------------------------------------------------------
// Active-scope registry (repository listeners + external retain)
// ---------------------------------------------------------------------------

/**
 * Explicit active-scope registry.
 *
 * Repository `subscribe` listeners do not increment TanStack Query observer
 * counts, so active retain must consult this registry in addition to
 * `query.getObserversCount()`.
 */
export type TranscriptActiveScopeRegistry = {
  /** Increment retain count; returns a release function. */
  retain: (scope: TranscriptCacheScope) => () => void
  /** True when retain count > 0 for the normalized scope. */
  isRetained: (scope: TranscriptCacheScope) => boolean
  /** Snapshot of scopes with retain count > 0. */
  listRetained: () => TranscriptCacheScope[]
  /** Test/diagnostic: current retain count. */
  retainCount: (scope: TranscriptCacheScope) => number
  clear: () => void
}

export function createTranscriptActiveScopeRegistry(): TranscriptActiveScopeRegistry {
  const counts = new Map<string, { scope: TranscriptCacheScope; count: number }>()

  return {
    retain(scope) {
      const n = normalizeTranscriptCacheScope(scope)
      const key = transcriptCacheScopeKey(n)
      const existing = counts.get(key)
      if (existing) {
        existing.count += 1
      } else {
        counts.set(key, { scope: n, count: 1 })
      }
      let released = false
      return () => {
        if (released) return
        released = true
        const entry = counts.get(key)
        if (!entry) return
        entry.count -= 1
        if (entry.count <= 0) counts.delete(key)
      }
    },
    isRetained(scope) {
      return (counts.get(transcriptCacheScopeKey(scope))?.count ?? 0) > 0
    },
    listRetained() {
      return Array.from(counts.values()).map((entry) => entry.scope)
    },
    retainCount(scope) {
      return counts.get(transcriptCacheScopeKey(scope))?.count ?? 0
    },
    clear() {
      counts.clear()
    },
  }
}

// ---------------------------------------------------------------------------
// Operation counters (tests + diagnostics)
// ---------------------------------------------------------------------------

export type TranscriptCacheOpCounters = {
  cancel: number
  remove: number
  enforce: number
  purgeSession: number
  purgeGeneration: number
  destructiveReset: number
  evictedSessions: number
}

export function createTranscriptCacheOpCounters(): TranscriptCacheOpCounters {
  return {
    cancel: 0,
    remove: 0,
    enforce: 0,
    purgeSession: 0,
    purgeGeneration: 0,
    destructiveReset: 0,
    evictedSessions: 0,
  }
}

// ---------------------------------------------------------------------------
// Budget / LRU / purge / destructive reset
// ---------------------------------------------------------------------------

export type CanonicalTranscriptCacheEntry = {
  readonly scope: TranscriptCacheScope
  readonly queryKey: SessionTranscriptQueryKey
  readonly dataUpdatedAt: number
  readonly observerCount: number
  readonly retained: boolean
  readonly active: boolean
  readonly pageCount: number
}

export type TranscriptQueryCacheBudget = {
  readonly client: QueryClient
  readonly activeRegistry: TranscriptActiveScopeRegistry
  readonly counters: TranscriptCacheOpCounters
  /** Resolve platform capacity (injectable for tests). */
  getLimit: () => number
  /** Whether a scope is active (observers OR registry retain). */
  isActive: (scope: TranscriptCacheScope) => boolean
  /** List canonical transcript entries, optionally filtered. */
  listCanonical: (filter?: {
    transport?: string
    generation?: number
    directory?: string
  }) => CanonicalTranscriptCacheEntry[]
  /**
   * Cancel then remove every key family for one session.
   * Does not re-ensure a tail (delete / eviction path).
   */
  purgeSession: (scope: TranscriptCacheScope) => void
  /** Cancel + remove all transcript key families for a runtime generation. */
  purgeGeneration: (transport: string, generation: number) => void
  /**
   * Enforce inactive capacity within each transport/generation/directory bucket.
   * Active scopes and `preserve` scopes are never evicted.
   */
  enforce: (options?: {
    transport?: string
    generation?: number
    directory?: string
    /** Extra scopes to keep even when inactive (e.g. just-touched session). */
    preserve?: Iterable<TranscriptCacheScope>
    limit?: number
  }) => { readonly evicted: readonly TranscriptCacheScope[] }
  /**
   * Destructive reset: purge old chain, ensure new authoritative tail.
   * On ensure failure the cache stays empty of the old chain and the error
   * propagates — old authoritative data is never restored.
   */
  destructiveReset: <T>(
    scope: TranscriptCacheScope,
    ensureTail: () => Promise<T>,
  ) => Promise<T>
  /**
   * Mark a scope as freshly observed/ensured so min-residency protects it from
   * immediate inactive LRU eviction (Oracle F4).
   */
  noteScopeObserved: (scope: TranscriptCacheScope) => void
}

/** Minimum residency after first observe/ensure before inactive LRU may evict (Oracle F4). */
const TRANSCRIPT_CACHE_MIN_RESIDENCY_MS = 30_000

export type CreateTranscriptQueryCacheBudgetInput = {
  client: QueryClient
  activeRegistry?: TranscriptActiveScopeRegistry
  getLimit?: () => number
  counters?: TranscriptCacheOpCounters
  /** Injectable clock for residency tests. */
  now?: () => number
  /** Override minimum residency (tests). */
  minResidencyMs?: number
}

function readCanonicalPageCount(data: unknown): number {
  if (
    data
    && typeof data === "object"
    && "pages" in data
    && Array.isArray((data as { pages: unknown }).pages)
  ) {
    return (data as { pages: unknown[] }).pages.length
  }
  return 0
}

function parseCanonicalScope(queryKey: readonly unknown[]): TranscriptCacheScope | null {
  if (
    !Array.isArray(queryKey)
    || queryKey.length < 5
    || queryKey[2] !== TRANSCRIPT_QUERY_KEY_DOMAINS.canonical
    || typeof queryKey[0] !== "string"
    || typeof queryKey[1] !== "number"
    || typeof queryKey[3] !== "string"
    || typeof queryKey[4] !== "string"
  ) {
    return null
  }
  return {
    transport: queryKey[0],
    generation: queryKey[1],
    directory: queryKey[3],
    sessionID: queryKey[4],
  }
}

export function createTranscriptQueryCacheBudget(
  input: CreateTranscriptQueryCacheBudgetInput,
): TranscriptQueryCacheBudget {
  const client = input.client
  const activeRegistry = input.activeRegistry ?? createTranscriptActiveScopeRegistry()
  const counters = input.counters ?? createTranscriptCacheOpCounters()
  const getLimit = input.getLimit ?? getEffectiveSessionCacheLimit
  const now = input.now ?? Date.now
  const minResidencyMs = input.minResidencyMs ?? TRANSCRIPT_CACHE_MIN_RESIDENCY_MS
  /** First observe/ensure timestamp per scope key (Oracle F4 minimum residency). */
  const firstSeenAt = new Map<string, number>()

  const markSeen = (scope: TranscriptCacheScope, at?: number) => {
    const key = transcriptCacheScopeKey(normalizeTranscriptCacheScope(scope))
    if (!firstSeenAt.has(key)) firstSeenAt.set(key, at ?? now())
  }

  /** Call after ensureInitial / first subscribe so residency starts now. */
  const noteScopeObserved = (scope: TranscriptCacheScope) => {
    const key = transcriptCacheScopeKey(normalizeTranscriptCacheScope(scope))
    // Force residency window from this observe moment (overwrite seed).
    firstSeenAt.set(key, now())
  }

  const isWithinMinResidency = (scope: TranscriptCacheScope): boolean => {
    const key = transcriptCacheScopeKey(normalizeTranscriptCacheScope(scope))
    const seen = firstSeenAt.get(key)
    if (seen === undefined) return false
    return now() - seen < minResidencyMs
  }

  const isActive = (scope: TranscriptCacheScope): boolean => {
    const n = normalizeTranscriptCacheScope(scope)
    if (activeRegistry.isRetained(n)) return true
    const key = sessionTranscriptQueryKey(
      { directory: n.directory, sessionID: n.sessionID },
      n.transport,
      n.generation,
    )
    const query = client.getQueryCache().find({ queryKey: key, exact: true })
    return (query?.getObserversCount() ?? 0) > 0
  }

  const listCanonical = (filter?: {
    transport?: string
    generation?: number
    directory?: string
  }): CanonicalTranscriptCacheEntry[] => {
    const directory =
      filter?.directory === undefined
        ? undefined
        : normalizeDirectory(filter.directory)
    const entries: CanonicalTranscriptCacheEntry[] = []
    for (const query of client.getQueryCache().getAll()) {
      const scope = parseCanonicalScope(query.queryKey)
      if (!scope) continue
      if (filter?.transport !== undefined && scope.transport !== filter.transport) continue
      if (filter?.generation !== undefined && scope.generation !== filter.generation) continue
      if (directory !== undefined && scope.directory !== directory) continue
      const observerCount = query.getObserversCount()
      const retained = activeRegistry.isRetained(scope)
      entries.push({
        scope,
        queryKey: query.queryKey as SessionTranscriptQueryKey,
        dataUpdatedAt: query.state.dataUpdatedAt,
        observerCount,
        retained,
        active: retained || observerCount > 0,
        pageCount: readCanonicalPageCount(query.state.data),
      })
    }
    return entries
  }

  const cancelAndRemoveFilter = (filter: {
    queryKey: QueryKey
    exact?: boolean
  }) => {
    void client.cancelQueries(filter)
    counters.cancel += 1
    client.removeQueries(filter)
    counters.remove += 1
  }

  const purgeSession = (scope: TranscriptCacheScope) => {
    counters.purgeSession += 1
    firstSeenAt.delete(transcriptCacheScopeKey(normalizeTranscriptCacheScope(scope)))
    for (const filter of transcriptSessionKeyFamilyFilters(scope)) {
      cancelAndRemoveFilter(filter)
    }
  }

  const purgeGeneration = (transport: string, generation: number) => {
    counters.purgeGeneration += 1
    // Broad cancel/remove for every transcript family under this generation.
    const roots: QueryKey[] = [
      [transport, generation, TRANSCRIPT_QUERY_KEY_DOMAINS.canonical],
      [
        transport,
        generation,
        TRANSCRIPT_QUERY_KEY_DOMAINS.transportPageRoot,
        TRANSCRIPT_QUERY_KEY_DOMAINS.transportPageKind,
      ],
      [transport, generation, TRANSCRIPT_QUERY_KEY_DOMAINS.taskRoot],
      [transport, generation, TRANSCRIPT_QUERY_KEY_DOMAINS.checkpoint],
    ]
    for (const queryKey of roots) {
      cancelAndRemoveFilter({ queryKey })
    }
  }

  const enforce = (options?: {
    transport?: string
    generation?: number
    directory?: string
    preserve?: Iterable<TranscriptCacheScope>
    limit?: number
  }): { readonly evicted: readonly TranscriptCacheScope[] } => {
    counters.enforce += 1
    const limit = options?.limit ?? getLimit()
    const preserveKeys = new Set(
      Array.from(options?.preserve ?? []).map((scope) =>
        transcriptCacheScopeKey(normalizeTranscriptCacheScope(scope)),
      ),
    )

    const candidates = listCanonical({
      transport: options?.transport,
      generation: options?.generation,
      directory: options?.directory,
    })

    // Bucket by transport / generation / directory.
    const buckets = new Map<string, CanonicalTranscriptCacheEntry[]>()
    for (const entry of candidates) {
      const bucketKey = transcriptCacheDirectoryBucketKey(entry.scope)
      let list = buckets.get(bucketKey)
      if (!list) {
        list = []
        buckets.set(bucketKey, list)
      }
      list.push(entry)
    }

    const evicted: TranscriptCacheScope[] = []

    for (const list of buckets.values()) {
      // Seed first-seen from dataUpdatedAt when unknown so pre-existing cache
      // entries are not all treated as "just observed" (which would block LRU).
      // Explicit markSeen on retain/ensure still starts residency at wall-clock now.
      for (const entry of list) {
        const key = transcriptCacheScopeKey(entry.scope)
        if (!firstSeenAt.has(key)) {
          firstSeenAt.set(key, entry.dataUpdatedAt || now())
        }
      }

      // Inactive only; active (observers or retain), preserve, and min-residency stay.
      const inactive = list.filter((entry) => {
        if (entry.active) return false
        if (preserveKeys.has(transcriptCacheScopeKey(entry.scope))) return false
        // Oracle F4: newly ensured/observed scopes are not immediately evicted.
        if (isWithinMinResidency(entry.scope)) return false
        return true
      })
      // LRU: oldest dataUpdatedAt first.
      inactive.sort((a, b) => {
        if (a.dataUpdatedAt !== b.dataUpdatedAt) {
          return a.dataUpdatedAt - b.dataUpdatedAt
        }
        // Stable tie-break by sessionID for deterministic tests.
        return a.scope.sessionID < b.scope.sessionID
          ? -1
          : a.scope.sessionID > b.scope.sessionID
            ? 1
            : 0
      })

      const protectedCount = list.length - inactive.length
      // Capacity counts total retained sessions in the bucket (active + inactive kept).
      // Evict oldest inactive until total <= limit.
      let total = list.length
      let index = 0
      while (total > limit && index < inactive.length) {
        // Never drop below active/preserved/residency-protected count.
        if (total - 1 < protectedCount) break
        const victim = inactive[index]!
        index += 1
        purgeSession(victim.scope)
        evicted.push(victim.scope)
        counters.evictedSessions += 1
        total -= 1
      }
    }

    return { evicted }
  }

  const destructiveReset = async <T>(
    scope: TranscriptCacheScope,
    ensureTail: () => Promise<T>,
  ): Promise<T> => {
    counters.destructiveReset += 1
    // Clear old cursor / task / checkpoint / canonical chain first.
    purgeSession(scope)
    try {
      const result = await ensureTail()
      // Successful ensure owns the new chain only; enforce capacity after.
      enforce({
        transport: scope.transport,
        generation: scope.generation,
        directory: scope.directory,
        preserve: [scope],
      })
      return result
    } catch (error) {
      // Ensure failed: keep the empty/failed state. Do not restore old data.
      // Any partial writes from a failed ensure that left garbage are purged again.
      purgeSession(scope)
      throw error
    }
  }

  return {
    client,
    activeRegistry,
    counters,
    getLimit,
    isActive,
    listCanonical,
    purgeSession,
    purgeGeneration,
    enforce,
    destructiveReset,
    noteScopeObserved,
  }
}

// ---------------------------------------------------------------------------
// Helpers for seeding / tests
// ---------------------------------------------------------------------------

/** Write a minimal canonical InfiniteData marker for cache-budget tests. */
export function seedCanonicalTranscriptQuery(
  client: Pick<QueryClient, "setQueryData">,
  scope: TranscriptCacheScope,
  data: unknown,
  dataUpdatedAt?: number,
): SessionTranscriptQueryKey {
  const n = normalizeTranscriptCacheScope(scope)
  const key = sessionTranscriptQueryKey(
    { directory: n.directory, sessionID: n.sessionID },
    n.transport,
    n.generation,
  )
  client.setQueryData(key, data)
  if (typeof dataUpdatedAt === "number") {
    const full = client as QueryClient
    const query = full.getQueryCache?.().find?.({ queryKey: key, exact: true }) as
      | Query
      | undefined
    if (query) {
      // TanStack Query does not expose a public setter; assign for test control.
      ;(query.state as { dataUpdatedAt: number }).dataUpdatedAt = dataUpdatedAt
    }
  }
  return key
}

export function seedTransportPageQuery(
  client: Pick<QueryClient, "setQueryData">,
  scope: TranscriptCacheScope,
  limit: number,
  before: string | undefined,
  data: unknown,
): void {
  const n = normalizeTranscriptCacheScope(scope)
  client.setQueryData(
    sessionMessagePageQueryKey(
      {
        directory: n.directory,
        sessionID: n.sessionID,
        limit,
        before,
      },
      n.transport,
      n.generation,
    ),
    data,
  )
}
