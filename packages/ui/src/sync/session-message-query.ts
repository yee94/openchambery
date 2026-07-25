/**
 * TanStack Query ownership for HTTP session-message page pulls.
 *
 * - Query keys carry transport identity, directory, sessionID, limit, cursor.
 * - Cache entries store immutable HTTP page snapshots only (no SSE/WS).
 * - Transport single-flight reuses `loadSessionMessagePage` so imperative and
 *   Query paths share the exact in-flight promise.
 * - UI transcript selectors must keep reading the directory child store; this
 *   module never projects pages into UI state.
 * - Commit captures bind a child-store identity plus runtime generation so a
 *   remounted store or runtime switch cannot apply a stale page.
 */

import type { QueryClient } from "@tanstack/react-query"

import { queryClient as defaultQueryClient } from "@/lib/queryRuntime"
import { getRuntimeGeneration, getRuntimeKey, getRuntimeTransportIdentity } from "@/lib/runtime-switch"

import { loadSessionMessagePage } from "./session-message-loader"

export type SessionMessagePageRecord = {
  readonly info: { readonly id: string; readonly [key: string]: unknown }
  readonly parts?: readonly unknown[]
}

/** Immutable HTTP page response held in the Query cache. */
export type SessionMessageHttpPage = {
  readonly records: readonly SessionMessagePageRecord[]
  readonly cursor?: string
  readonly complete: boolean
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

export type SessionMessagePageCommitCapture = {
  readonly store: object
  readonly transport: string
  readonly generation: number
}

export class SessionMessageRuntimeStaleError extends Error {
  readonly code = "runtime_stale" as const

  constructor(message = "runtime_stale") {
    super(message)
    this.name = "SessionMessageRuntimeStaleError"
  }
}

const normalizeDirectory = (directory: string): string => directory.trim()

const cursorToken = (before?: string): string => {
  const value = before?.trim()
  return value ? value : "tail"
}

export const sessionMessagePageQueryKey = (
  params: SessionMessagePageParams,
  transport = getRuntimeTransportIdentity(),
): readonly [string, "sessionMessages", "page", string, string, number, string] => [
  transport,
  "sessionMessages",
  "page",
  normalizeDirectory(params.directory),
  params.sessionID,
  params.limit,
  cursorToken(params.before),
]

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
  runtimeKey = getRuntimeKey(),
  probe: SessionMessageRuntimeProbe = {},
) => {
  const directory = normalizeDirectory(params.directory)
  const sessionID = params.sessionID
  const limit = params.limit
  const before = params.before?.trim() || undefined
  const getGeneration = probe.getGeneration ?? getRuntimeGeneration
  const generationAtCreate = getGeneration()

  return {
    queryKey: sessionMessagePageQueryKey({ directory, sessionID, limit, before }, transport),
    queryFn: async ({ signal }: { signal: AbortSignal }): Promise<SessionMessageHttpPage> => {
      assertRuntimeCurrent(transport, generationAtCreate, probe)
      const page = await loadSessionMessagePage({
        runtimeKey,
        directory,
        sessionID,
        limit,
        before,
        request: () => fetcher({ directory, sessionID, limit, before, signal }),
      })
      assertRuntimeCurrent(transport, generationAtCreate, probe)
      return freezePage(page)
    },
    staleTime: Infinity,
    gcTime: 5 * 60_000,
    retry: false,
  }
}

/** Imperative ensure: concurrent callers share one Query flight (and loader single-flight). */
export const ensureSessionMessagePage = (
  params: SessionMessagePageParams,
  fetcher: SessionMessagePageFetcher,
  client: Pick<QueryClient, "fetchQuery"> = defaultQueryClient,
  transport = getRuntimeTransportIdentity(),
  runtimeKey = getRuntimeKey(),
  probe: SessionMessageRuntimeProbe = {},
): Promise<SessionMessageHttpPage> =>
  client.fetchQuery(sessionMessagePageQueryOptions(params, fetcher, transport, runtimeKey, probe))

export const readSessionMessagePage = (
  params: SessionMessagePageParams,
  client: Pick<QueryClient, "getQueryData"> = defaultQueryClient,
  transport = getRuntimeTransportIdentity(),
): SessionMessageHttpPage | undefined =>
  client.getQueryData<SessionMessageHttpPage>(sessionMessagePageQueryKey(params, transport))

/** Capture child-store + runtime identity before applying a page to the directory store. */
export const captureSessionMessagePageCommit = (
  store: object,
  transport = getRuntimeTransportIdentity(),
  probe: SessionMessageRuntimeProbe = {},
): SessionMessagePageCommitCapture => ({
  store,
  transport,
  generation: (probe.getGeneration ?? getRuntimeGeneration)(),
})

/**
 * Validate a capture immediately before committing into a child store.
 * Mismatched store identity, transport, or generation means the page is stale.
 */
export const isSessionMessagePageCommitCurrent = (
  capture: SessionMessagePageCommitCapture,
  store: object,
  transport = getRuntimeTransportIdentity(),
  probe: SessionMessageRuntimeProbe = {},
): boolean =>
  capture.store === store
  && capture.transport === transport
  && capture.generation === (probe.getGeneration ?? getRuntimeGeneration)()
