/**
 * TanStack Query ownership for session transcript.
 *
 * Transport-page Query:
 * - Keys: transport, generation, directory, sessionID, limit, cursor.
 * - Cache holds immutable HTTP page snapshots only (no SSE/WS).
 * - Single-flight via QueryClient.fetchQuery (no page-loader / prefetch).
 * - Injected SessionMessagePageFetcher is called directly; result is validated
 *   and frozen before enter Query cache.
 * - Classified retry: network/timeout/502/503/504 up to 2 retries; 4xx/contract fail.
 *
 * Canonical InfiniteQuery:
 * - Keys: transport, generation, directory, sessionID.
 * - InfiniteData<TranscriptPage> is the sole transcript read model.
 */

import {
  InfiniteQueryObserver,
  type InfiniteData,
  type QueryClient,
  type QueryFunctionContext,
  type QueryKey,
} from "@tanstack/react-query"

import { queryClient as defaultQueryClient } from "@/lib/queryRuntime"
import {
  getRuntimeGeneration,
  getRuntimeTransportIdentity,
} from "@/lib/runtime-switch"

import {
  getHistorySessionTurnLimit,
  getInitialSessionTurnLimit,
} from "./session-message-policy"
import {
  freezeSessionTranscriptData,
  mergeSessionTranscript,
  shareSessionTranscriptData,
  transportPageToTranscriptPage,
  type SessionTranscriptData,
  type TranscriptPage,
} from "./transcript-merge"
import type { TranscriptTransportPage } from "./transcript-repository"

// ---------------------------------------------------------------------------
// Transport page types (existing + generation in key)
// ---------------------------------------------------------------------------

export type SessionMessagePageRecord = {
  readonly info: { readonly id: string; readonly [key: string]: unknown }
  readonly parts?: readonly unknown[]
}

/** Immutable HTTP page response held in the Query cache. */
export type SessionMessageHttpPage = {
  readonly records: readonly SessionMessagePageRecord[]
  readonly cursor?: string
  readonly complete: boolean
  readonly turnCount?: number
  readonly requestedTurnLimit?: number
}

export type SessionMessagePageParams = {
  directory: string
  sessionID: string
  limit: number
  /** Pagination cursor; omit or undefined means the live tail page. */
  before?: string
}

export type SessionMessagePageFetcher = (input: {
  directory: string
  sessionID: string
  limit: number
  before?: string
  signal: AbortSignal
}) => Promise<SessionMessageHttpPage>

export class SessionMessageRuntimeStaleError extends Error {
  readonly code = "runtime_stale" as const

  constructor(message = "runtime_stale") {
    super(message)
    this.name = "SessionMessageRuntimeStaleError"
  }
}

export class SessionMessagePageContractError extends Error {
  readonly code = "page_contract" as const

  constructor(message: string) {
    super(message)
    this.name = "SessionMessagePageContractError"
  }
}

export class SessionMessageHttpError extends Error {
  readonly code = "http_error" as const
  readonly status: number

  constructor(status: number, message?: string) {
    super(message ?? `session message page failed (${status})`)
    this.name = "SessionMessageHttpError"
    this.status = status
  }
}

const normalizeDirectory = (directory: string): string => directory.trim()

const cursorToken = (before?: string): string => {
  const value = before?.trim()
  return value ? value : "tail"
}

// ---------------------------------------------------------------------------
// Retry classification
// ---------------------------------------------------------------------------

const RETRYABLE_STATUS = new Set([502, 503, 504])

const TRANSIENT_MESSAGE_MARKERS = [
  "load failed",
  "network connection was lost",
  "network request failed",
  "failed to fetch",
  "econnreset",
  "econnrefused",
  "etimedout",
  "socket hang up",
  "signal timed out",
  "timed out",
  "timeout",
  "opencode api unavailable",
] as const

/**
 * Whether a transport-page failure is retryable.
 * Network / timeout / 502 / 503 / 504 → retry (max 2).
 * 4xx and contract errors → fail immediately.
 */
export function isRetryableSessionMessagePageError(error: unknown): boolean {
  if (!error) return false
  if (error instanceof SessionMessageRuntimeStaleError) return false
  if (error instanceof SessionMessagePageContractError) return false
  if (error instanceof SessionMessageHttpError) {
    if (error.status >= 400 && error.status < 500) return false
    return RETRYABLE_STATUS.has(error.status) || (error.status >= 500 && error.status < 600)
  }
  const status = (error as { status?: number })?.status
  if (typeof status === "number") {
    if (status >= 400 && status < 500) return false
    if (RETRYABLE_STATUS.has(status) || (status >= 500 && status < 600)) return true
  }
  const message = String(error instanceof Error ? error.message : error).toLowerCase()
  // Explicit 4xx in message (e.g. "failed (404)") — not retryable.
  const statusMatch = message.match(/\((\d{3})\)/)
  if (statusMatch) {
    const code = Number(statusMatch[1])
    if (code >= 400 && code < 500) return false
    if (RETRYABLE_STATUS.has(code) || (code >= 500 && code < 600)) return true
  }
  if (message.includes("page contract") || message.includes("malformed json") || message.includes("contract")) {
    return false
  }
  return TRANSIENT_MESSAGE_MARKERS.some((marker) => message.includes(marker))
}

/** TanStack retry: failureCount is 0-based attempts already made. Max 2 retries. */
export function sessionMessagePageRetry(
  failureCount: number,
  error: unknown,
): boolean {
  if (failureCount >= 2) return false
  return isRetryableSessionMessagePageError(error)
}

// ---------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------

export type SessionMessagePageQueryKey = readonly [
  string,
  number,
  "sessionMessages",
  "page",
  string,
  string,
  number,
  string,
]

export type SessionTranscriptQueryKey = readonly [
  string,
  number,
  "session-transcript",
  string,
  string,
]

export const sessionMessagePageQueryKey = (
  params: SessionMessagePageParams,
  transport = getRuntimeTransportIdentity(),
  generation = getRuntimeGeneration(),
): SessionMessagePageQueryKey => [
  transport,
  generation,
  "sessionMessages",
  "page",
  normalizeDirectory(params.directory),
  params.sessionID,
  params.limit,
  cursorToken(params.before),
]

export const sessionTranscriptQueryKey = (
  params: { directory: string; sessionID: string },
  transport = getRuntimeTransportIdentity(),
  generation = getRuntimeGeneration(),
): SessionTranscriptQueryKey => [
  transport,
  generation,
  "session-transcript",
  normalizeDirectory(params.directory),
  params.sessionID,
]

// ---------------------------------------------------------------------------
// Transport page freeze / options
// ---------------------------------------------------------------------------

/**
 * Validate transport-page shape before freeze. Contract failures are not retryable.
 */
export function validateSessionMessageHttpPage(page: unknown): SessionMessageHttpPage {
  if (!page || typeof page !== "object") {
    throw new SessionMessagePageContractError("session message page: expected object")
  }
  const candidate = page as {
    records?: unknown
    cursor?: unknown
    complete?: unknown
    turnCount?: unknown
    requestedTurnLimit?: unknown
  }
  if (!Array.isArray(candidate.records)) {
    throw new SessionMessagePageContractError("session message page: records must be an array")
  }
  if (typeof candidate.complete !== "boolean") {
    throw new SessionMessagePageContractError("session message page: complete must be boolean")
  }
  for (const record of candidate.records) {
    if (!record || typeof record !== "object") {
      throw new SessionMessagePageContractError("session message page: invalid record")
    }
    const info = (record as { info?: unknown }).info
    if (!info || typeof info !== "object" || typeof (info as { id?: unknown }).id !== "string") {
      throw new SessionMessagePageContractError("session message page: record.info.id required")
    }
  }
  if (
    candidate.cursor !== undefined
    && candidate.cursor !== null
    && typeof candidate.cursor !== "string"
  ) {
    throw new SessionMessagePageContractError("session message page: cursor must be string when set")
  }
  return page as SessionMessageHttpPage
}

const freezePage = (page: SessionMessageHttpPage): SessionMessageHttpPage => {
  const records = page.records.map((record) =>
    Object.freeze({
      info: Object.freeze({ ...record.info }),
      parts: record.parts === undefined ? undefined : Object.freeze([...record.parts]),
    }),
  )
  return Object.freeze({
    records: Object.freeze(records),
    cursor: page.cursor,
    complete: page.complete,
    ...(typeof page.turnCount === "number" ? { turnCount: page.turnCount } : {}),
    ...(typeof page.requestedTurnLimit === "number"
      ? { requestedTurnLimit: page.requestedTurnLimit }
      : {}),
  })
}

export type SessionMessageRuntimeProbe = {
  getTransport?: () => string
  getGeneration?: () => number
}

const assertRuntimeCurrent = (
  transport: string,
  generation: number,
  probe: SessionMessageRuntimeProbe,
): void => {
  const currentTransport = (probe.getTransport ?? getRuntimeTransportIdentity)()
  const currentGeneration = (probe.getGeneration ?? getRuntimeGeneration)()
  if (currentTransport !== transport || currentGeneration !== generation) {
    throw new SessionMessageRuntimeStaleError()
  }
}

export const sessionMessagePageQueryOptions = (
  params: SessionMessagePageParams,
  fetcher: SessionMessagePageFetcher,
  transport = getRuntimeTransportIdentity(),
  probe: SessionMessageRuntimeProbe = {},
  generation = (probe.getGeneration ?? getRuntimeGeneration)(),
) => {
  const directory = normalizeDirectory(params.directory)
  const sessionID = params.sessionID
  const limit = params.limit
  const before = params.before?.trim() || undefined

  return {
    queryKey: sessionMessagePageQueryKey(
      { directory, sessionID, limit, before },
      transport,
      generation,
    ),
    queryFn: async ({ signal }: { signal: AbortSignal }): Promise<SessionMessageHttpPage> => {
      assertRuntimeCurrent(transport, generation, probe)
      // Direct fetcher — no page-loader, reducer, or prefetch lifecycle.
      const raw = await fetcher({ directory, sessionID, limit, before, signal })
      assertRuntimeCurrent(transport, generation, probe)
      return freezePage(validateSessionMessageHttpPage(raw))
    },
    staleTime: Infinity,
    gcTime: 5 * 60_000,
    retry: sessionMessagePageRetry,
    retryDelay: (attemptIndex: number) => Math.min(500 * 2 ** attemptIndex, 4_000),
  }
}

/** Imperative ensure: concurrent callers share one QueryClient flight. */
export const ensureSessionMessagePage = (
  params: SessionMessagePageParams,
  fetcher: SessionMessagePageFetcher,
  client: Pick<QueryClient, "fetchQuery"> = defaultQueryClient,
  transport = getRuntimeTransportIdentity(),
  probe: SessionMessageRuntimeProbe = {},
  generation = (probe.getGeneration ?? getRuntimeGeneration)(),
): Promise<SessionMessageHttpPage> =>
  client.fetchQuery(
    sessionMessagePageQueryOptions(params, fetcher, transport, probe, generation),
  )

export const readSessionMessagePage = (
  params: SessionMessagePageParams,
  client: Pick<QueryClient, "getQueryData"> = defaultQueryClient,
  transport = getRuntimeTransportIdentity(),
  generation = getRuntimeGeneration(),
): SessionMessageHttpPage | undefined =>
  client.getQueryData<SessionMessageHttpPage>(
    sessionMessagePageQueryKey(params, transport, generation),
  )

// ---------------------------------------------------------------------------
// Canonical InfiniteQuery
// ---------------------------------------------------------------------------

export type SessionTranscriptFetcher = (input: {
  directory: string
  sessionID: string
  limit: number
  before?: string
  signal: AbortSignal
}) => Promise<TranscriptTransportPage>

export type SessionTranscriptQueryParams = {
  directory: string
  sessionID: string
  /** Initial tail turn budget. Defaults to product initial limit. */
  initialLimit?: number
  /** History prepend turn budget. Defaults to product history limit. */
  historyLimit?: number
}

function httpPageToTransport(page: SessionMessageHttpPage): TranscriptTransportPage {
  return {
    records: page.records.map((record) => ({
      info: record.info as TranscriptTransportPage["records"][number]["info"],
      parts: record.parts as TranscriptTransportPage["records"][number]["parts"],
    })),
    cursor: page.cursor,
    complete: page.complete,
    turnCount: page.turnCount,
    requestedTurnLimit: page.requestedTurnLimit,
  }
}

function transportToHttpPage(page: TranscriptTransportPage): SessionMessageHttpPage {
  return freezePage({
    records: page.records.map((record) => ({
      info: record.info as SessionMessagePageRecord["info"],
      parts: record.parts,
    })),
    cursor: page.cursor,
    complete: page.complete,
    turnCount: page.turnCount,
    requestedTurnLimit: page.requestedTurnLimit,
  })
}

/**
 * getPreviousPageParam: complete closes hasPreviousPage; otherwise use cursor.
 */
export function getPreviousTranscriptPageParam(
  firstPage: TranscriptPage,
): string | undefined {
  if (firstPage.complete) return undefined
  if (typeof firstPage.cursor === "string" && firstPage.cursor.length > 0) {
    return firstPage.cursor
  }
  return undefined
}

export type SessionTranscriptQueryOptionsInput = SessionTranscriptQueryParams & {
  fetcher: SessionTranscriptFetcher
  transport?: string
  generation?: number
  probe?: SessionMessageRuntimeProbe
  client?: QueryClient
}

function sessionTranscriptInfiniteQueryOptions(
  input: SessionTranscriptQueryOptionsInput,
) {
  const directory = normalizeDirectory(input.directory)
  const sessionID = input.sessionID
  const transport = input.transport ?? getRuntimeTransportIdentity()
  const probe = input.probe ?? {}
  const generation = input.generation ?? (probe.getGeneration ?? getRuntimeGeneration)()
  const initialLimit = input.initialLimit ?? getInitialSessionTurnLimit()
  const historyLimit = input.historyLimit ?? getHistorySessionTurnLimit()
  const client = input.client ?? defaultQueryClient
  const queryKey = sessionTranscriptQueryKey({ directory, sessionID }, transport, generation)

  const pageFetcher: SessionMessagePageFetcher = async (args) => {
    const page = await input.fetcher({
      directory: args.directory,
      sessionID: args.sessionID,
      limit: args.limit,
      before: args.before,
      signal: args.signal,
    })
    return transportToHttpPage(page)
  }

  return {
    queryKey,
    queryFn: async (
      context: QueryFunctionContext<SessionTranscriptQueryKey, string | null>,
    ): Promise<TranscriptPage> => {
      assertRuntimeCurrent(transport, generation, probe)
      const before = context.pageParam?.trim() || undefined
      const limit = before ? historyLimit : initialLimit
      const purpose = before ? "prepend" : "initial"
      const httpPage = await ensureSessionMessagePage(
        { directory, sessionID, limit, before },
        pageFetcher,
        client,
        transport,
        probe,
        generation,
      )
      assertRuntimeCurrent(transport, generation, probe)
      const transportPage = httpPageToTransport(httpPage)
      const kind = purpose === "prepend" ? "history" : "tail"
      return transportPageToTranscriptPage(transportPage, kind, {
        liveRevision: 0,
        confirmedHeadMessageID:
          transportPage.records[transportPage.records.length - 1]?.info.id ?? null,
      })
    },
    initialPageParam: null as string | null,
    getPreviousPageParam: getPreviousTranscriptPageParam,
    getNextPageParam: () => undefined,
    staleTime: Infinity,
    gcTime: 5 * 60_000,
    retry: sessionMessagePageRetry,
    retryDelay: (attemptIndex: number) => Math.min(500 * 2 ** attemptIndex, 4_000),
    maxPages: undefined,
    structuralSharing: (
      oldData: unknown,
      newData: unknown,
    ): unknown =>
      shareSessionTranscriptData(
        oldData as SessionTranscriptData | undefined,
        newData as SessionTranscriptData | undefined,
        sessionID,
      ),
  }
}

// ---------------------------------------------------------------------------
// Imperative controller / observers (no React)
// ---------------------------------------------------------------------------

export type SessionTranscriptController = {
  readonly queryKey: SessionTranscriptQueryKey
  /** Imperative InfiniteQueryObserver for initial/previous-page control. */
  readonly observer: InfiniteQueryObserver<TranscriptPage>
  ensureInitial: () => Promise<SessionTranscriptData>
  fetchPreviousPage: () => Promise<SessionTranscriptData>
  getData: () => SessionTranscriptData | undefined
  subscribe: (
    listener: (data: SessionTranscriptData | undefined) => void,
  ) => () => void
  destroy: () => void
}

export function createSessionTranscriptController(
  input: SessionTranscriptQueryOptionsInput,
): SessionTranscriptController {
  const client = input.client ?? defaultQueryClient
  const options = sessionTranscriptInfiniteQueryOptions({ ...input, client })
  const observer = new InfiniteQueryObserver(client, {
    ...options,
    structuralSharing: (
      oldData: unknown,
      newData: unknown,
    ): unknown =>
      shareSessionTranscriptData(
        oldData as SessionTranscriptData | undefined,
        newData as SessionTranscriptData | undefined,
        input.sessionID,
      ),
  })

  const ensureInitial = async (): Promise<SessionTranscriptData> => {
    const result = await observer.fetchNextPage()
    // initialPageParam is null and we only use fetchPreviousPage for history;
    // first ensure uses refetch / fetch when empty.
    const data = result.data as SessionTranscriptData | undefined
    if (data && data.pages.length > 0) {
      return freezeSessionTranscriptData(data)
    }
    await observer.refetch()
    const after = observer.getCurrentResult().data as SessionTranscriptData | undefined
    if (!after) {
      throw observer.getCurrentResult().error ?? new Error("transcript initial fetch failed")
    }
    return freezeSessionTranscriptData(after)
  }

  const fetchPreviousPage = async (): Promise<SessionTranscriptData> => {
    const prior = observer.getCurrentResult().data as SessionTranscriptData | undefined
    try {
      const result = await observer.fetchPreviousPage({ cancelRefetch: false })
      const currentResult = observer.getCurrentResult()
      const data = (result.data ?? currentResult.data ?? prior) as SessionTranscriptData | undefined
      if (result.isError || currentResult.isFetchPreviousPageError) {
        const error =
          result.error
          ?? currentResult.error
          ?? new Error("transcript previous page fetch failed")
        // Preserve pages: rethrow only after confirming cache still holds prior data.
        if (data && data.pages.length > 0) {
          throw Object.assign(
            error instanceof Error ? error : new Error(String(error)),
            { retainedPages: freezeSessionTranscriptData(data) },
          )
        }
        throw error
      }
      if (!data) {
        throw new Error("transcript previous page fetch failed")
      }
      return freezeSessionTranscriptData(data)
    } catch (error) {
      // Query may reject the promise; still retain prior pages for the caller.
      const retained =
        (observer.getCurrentResult().data as SessionTranscriptData | undefined)
        ?? prior
      if (retained && retained.pages.length > 0) {
        throw Object.assign(
          error instanceof Error ? error : new Error(String(error)),
          { retainedPages: freezeSessionTranscriptData(retained) },
        )
      }
      throw error
    }
  }

  return {
    queryKey: options.queryKey,
    observer: observer as unknown as InfiniteQueryObserver<TranscriptPage>,
    ensureInitial,
    fetchPreviousPage,
    getData: () =>
      observer.getCurrentResult().data as SessionTranscriptData | undefined,
    subscribe: (listener) => {
      return observer.subscribe((result) => {
        listener(result.data as SessionTranscriptData | undefined)
      })
    },
    destroy: () => {
      observer.destroy()
    },
  }
}

/**
 * Apply a pure merge into the canonical transcript Query via setQueryData.
 * Used by SSE / optimistic / reset / recovery commands.
 */
export function applySessionTranscriptMerge(
  client: Pick<QueryClient, "setQueryData" | "getQueryData" | "removeQueries">,
  key: SessionTranscriptQueryKey,
  sessionID: string,
  input: Parameters<typeof mergeSessionTranscript>[2],
): ReturnType<typeof mergeSessionTranscript> {
  const previous = client.getQueryData<SessionTranscriptData>(key)
  const mergeResult = mergeSessionTranscript(previous, sessionID, input)
  if (!mergeResult.result.applied) {
    return mergeResult
  }
  if (mergeResult.data === undefined) {
    // Reset-to-empty: remove the canonical query so reads see absence.
    if ("removeQueries" in client && typeof client.removeQueries === "function") {
      client.removeQueries({ queryKey: key, exact: true })
    } else {
      client.setQueryData(key, undefined)
    }
    return mergeResult
  }
  if (!mergeResult.result.changed && mergeResult.data === previous) {
    return mergeResult
  }
  client.setQueryData<SessionTranscriptData>(key, mergeResult.data)
  return mergeResult
}

export function readSessionTranscriptData(
  params: { directory: string; sessionID: string },
  client: Pick<QueryClient, "getQueryData"> = defaultQueryClient,
  transport = getRuntimeTransportIdentity(),
  generation = getRuntimeGeneration(),
): SessionTranscriptData | undefined {
  return client.getQueryData<SessionTranscriptData>(
    sessionTranscriptQueryKey(params, transport, generation),
  )
}

// Re-export merge types for consumers / tests.
export type { SessionTranscriptData, TranscriptPage } from "./transcript-merge"
export type { QueryKey }
