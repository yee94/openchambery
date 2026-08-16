/**
 * HTTP TranscriptDurableStore over the local OpenChamber transcript-cache route.
 *
 * Only the Electron local sidecar enables SQLite. 501 means the cache is
 * disabled for this runtime (treat as miss / no-op). Any other failure throws
 * so Query `ensureInitial` can keep the network path.
 */

import { runtimeFetch, type RuntimeFetchOptions } from "@/lib/runtime-fetch"
import type { Message, Part } from "@opencode-ai/sdk/v2"

import type {
  TranscriptDurableGeneration,
  TranscriptDurableRecord,
  TranscriptDurableScope,
  TranscriptDurableSession,
  TranscriptDurableStore,
  TranscriptEvictResult,
  TranscriptEvictToBytesOptions,
  TranscriptPartCompleteness,
  TranscriptRecordCompleteness,
  TranscriptUpsertResult,
  TranscriptUpsertSkipReason,
} from "./transcript-durable-store"
import { cloneTranscriptScope } from "./transcript-durable-store"

export const TRANSCRIPT_CACHE_ROUTE_PREFIX = "/api/openchamber/transcript-cache"

export type TranscriptDurableHttpFetch = (
  path: string,
  init?: RuntimeFetchOptions,
) => Promise<Response>

export type HttpTranscriptDurableStoreOptions = {
  fetch?: TranscriptDurableHttpFetch
}

const SKIP_REASONS = new Set<TranscriptUpsertSkipReason>([
  "unchanged",
  "not-settled",
  "slim-downgrade",
])

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

const requiredString = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid transcript cache ${label}`)
  }
  return value
}

const requiredInteger = (value: unknown, label: string): number => {
  if (typeof value === "number" && Number.isInteger(value)) return value
  throw new Error(`Invalid transcript cache ${label}`)
}

const parseScope = (value: unknown): TranscriptDurableScope => {
  if (!isPlainObject(value)) throw new Error("Invalid transcript cache scope")
  return {
    transport: requiredString(value.transport, "scope"),
    generation: requiredInteger(value.generation, "scope"),
    directory: requiredString(value.directory, "scope"),
    sessionID: requiredString(value.sessionID, "scope"),
  }
}

const parseCompleteness = (value: unknown, label: string): TranscriptRecordCompleteness => {
  if (value === "slim" || value === "full") return value
  throw new Error(`Invalid transcript cache ${label}`)
}

const parseRecord = (value: unknown): TranscriptDurableRecord => {
  if (!isPlainObject(value)) throw new Error("Invalid transcript cache record")
  if (!isPlainObject(value.info)) throw new Error("Invalid transcript cache record")
  if (!Array.isArray(value.parts)) throw new Error("Invalid transcript cache record")
  if (!Array.isArray(value.partCompleteness)) throw new Error("Invalid transcript cache record")
  if (!isPlainObject(value.sortKey)) throw new Error("Invalid transcript cache record")
  return {
    scope: parseScope(value.scope),
    messageID: requiredString(value.messageID, "message ID"),
    info: value.info as Message,
    parts: value.parts as Part[],
    partCompleteness: value.partCompleteness.map((item) => parseCompleteness(item, "part completeness")) as TranscriptPartCompleteness[],
    completeness: parseCompleteness(value.completeness, "completeness"),
    contentHash: requiredString(value.contentHash, "content hash"),
    byteSize: requiredInteger(value.byteSize, "byte size"),
    lastAccessedAt: requiredInteger(value.lastAccessedAt, "lastAccessedAt"),
    sortKey: {
      created: requiredInteger(value.sortKey.created, "sort key"),
      messageID: requiredString(value.sortKey.messageID, "sort key"),
    },
  }
}

const parseSession = (value: unknown, fallback: TranscriptDurableScope): TranscriptDurableSession => {
  if (!isPlainObject(value)) throw new Error("Invalid transcript cache session")
  if (!Array.isArray(value.records)) throw new Error("Invalid transcript cache session")
  const records = value.records.map(parseRecord)
  return {
    scope: value.scope === undefined ? cloneTranscriptScope(fallback) : parseScope(value.scope),
    records,
    byteSize: typeof value.byteSize === "number" && Number.isFinite(value.byteSize)
      ? value.byteSize
      : records.reduce((sum, record) => sum + record.byteSize, 0),
  }
}

const parseUpsert = (value: unknown): TranscriptUpsertResult => {
  if (!isPlainObject(value)) throw new Error("Invalid transcript cache upsert")
  if (value.status === "written") {
    return { status: "written", record: parseRecord(value.record) }
  }
  if (value.status === "skipped") {
    if (typeof value.reason !== "string" || !SKIP_REASONS.has(value.reason as TranscriptUpsertSkipReason)) {
      throw new Error("Invalid transcript cache upsert")
    }
    return {
      status: "skipped",
      reason: value.reason as TranscriptUpsertSkipReason,
      ...(value.record === undefined ? {} : { record: parseRecord(value.record) }),
    }
  }
  throw new Error("Invalid transcript cache upsert")
}

const parseEvict = (value: unknown): TranscriptEvictResult => {
  if (!isPlainObject(value)) throw new Error("Invalid transcript cache evict")
  return {
    evicted: requiredInteger(value.evicted, "evict"),
    freedBytes: requiredInteger(value.freedBytes, "evict"),
    remainingBytes: requiredInteger(value.remainingBytes, "evict"),
  }
}

const emptySession = (scope: TranscriptDurableScope): TranscriptDurableSession => ({
  scope: cloneTranscriptScope(scope),
  records: [],
  byteSize: 0,
})

const errorMessage = (payload: unknown, fallback: string): string => {
  if (isPlainObject(payload) && typeof payload.error === "string" && payload.error.length > 0) {
    return payload.error
  }
  return fallback
}

const readPayload = async (response: Response): Promise<unknown> => {
  if (response.status === 204) return undefined
  const text = await response.text()
  if (!text) return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error("Invalid transcript cache payload")
  }
}

type CacheOutcome =
  | { kind: "ok"; payload: unknown }
  | { kind: "not-found" }
  | { kind: "disabled" }

const requestCache = async (
  fetchFn: TranscriptDurableHttpFetch,
  path: string,
  init?: RuntimeFetchOptions,
): Promise<CacheOutcome> => {
  const response = await fetchFn(path, init)
  if (response.status === 501) return { kind: "disabled" }
  if (response.status === 404) return { kind: "not-found" }
  if (response.ok) return { kind: "ok", payload: await readPayload(response) }
  const payload = await readPayload(response).catch(() => undefined)
  throw new Error(errorMessage(payload, `Transcript cache request failed (${response.status})`))
}

const scopeQuery = (scope: TranscriptDurableScope) => ({
  transport: scope.transport,
  generation: String(scope.generation),
  directory: scope.directory,
  sessionID: scope.sessionID,
})

const jsonInit = (method: string, body: unknown): RuntimeFetchOptions => ({
  method,
  headers: { Accept: "application/json", "Content-Type": "application/json" },
  body: JSON.stringify(body),
})

/**
 * HTTP adapter for the local `/api/openchamber/transcript-cache` route.
 *
 * Inject `fetch` in tests. Production uses `runtimeFetch` so auth and the
 * active local origin stay on the existing runtime helpers.
 */
export function createHttpTranscriptDurableStore(
  options: HttpTranscriptDurableStoreOptions = {},
): TranscriptDurableStore {
  const fetchFn = options.fetch ?? runtimeFetch

  return {
    async readSession(scope) {
      const outcome = await requestCache(fetchFn, `${TRANSCRIPT_CACHE_ROUTE_PREFIX}/session`, {
        method: "GET",
        query: scopeQuery(scope),
      })
      if (outcome.kind === "disabled" || outcome.kind === "not-found") return emptySession(scope)
      return parseSession(outcome.payload, scope)
    },

    async readMessage(scope, messageID) {
      const outcome = await requestCache(fetchFn, `${TRANSCRIPT_CACHE_ROUTE_PREFIX}/message`, {
        method: "GET",
        query: { ...scopeQuery(scope), messageID },
      })
      if (outcome.kind === "disabled" || outcome.kind === "not-found") return undefined
      if (!isPlainObject(outcome.payload)) throw new Error("Invalid transcript cache record")
      return parseRecord(outcome.payload.record ?? outcome.payload)
    },

    async upsertSettled(scope, info, parts) {
      const outcome = await requestCache(
        fetchFn,
        `${TRANSCRIPT_CACHE_ROUTE_PREFIX}/message`,
        jsonInit("PUT", { scope, info, parts }),
      )
      if (outcome.kind === "disabled") return { status: "skipped", reason: "unchanged" }
      if (outcome.kind === "not-found") {
        throw new Error("Transcript cache request failed (404)")
      }
      return parseUpsert(outcome.payload)
    },

    async removeMessage(scope, messageID) {
      const outcome = await requestCache(
        fetchFn,
        `${TRANSCRIPT_CACHE_ROUTE_PREFIX}/message`,
        jsonInit("DELETE", { scope, messageID }),
      )
      if (outcome.kind === "disabled" || outcome.kind === "ok") return
      throw new Error("Transcript cache request failed (404)")
    },

    async clearSession(scope) {
      const outcome = await requestCache(
        fetchFn,
        `${TRANSCRIPT_CACHE_ROUTE_PREFIX}/session`,
        jsonInit("DELETE", { scope }),
      )
      if (outcome.kind === "disabled" || outcome.kind === "ok") return
      throw new Error("Transcript cache request failed (404)")
    },

    async clearGeneration(generation: TranscriptDurableGeneration) {
      const outcome = await requestCache(
        fetchFn,
        `${TRANSCRIPT_CACHE_ROUTE_PREFIX}/generation`,
        jsonInit("DELETE", generation),
      )
      if (outcome.kind === "disabled" || outcome.kind === "ok") return
      throw new Error("Transcript cache request failed (404)")
    },

    async evictToBytes(maxBytes, options?: TranscriptEvictToBytesOptions) {
      const outcome = await requestCache(
        fetchFn,
        `${TRANSCRIPT_CACHE_ROUTE_PREFIX}/evict`,
        jsonInit("POST", { maxBytes, ...(options?.protect ? { protect: options.protect } : {}) }),
      )
      if (outcome.kind === "disabled") {
        return { evicted: 0, freedBytes: 0, remainingBytes: 0 }
      }
      if (outcome.kind === "not-found") {
        throw new Error("Transcript cache request failed (404)")
      }
      return parseEvict(outcome.payload)
    },

    async clearAll() {
      const outcome = await requestCache(
        fetchFn,
        `${TRANSCRIPT_CACHE_ROUTE_PREFIX}/all`,
        { method: "DELETE", headers: { Accept: "application/json" } },
      )
      if (outcome.kind === "disabled" || outcome.kind === "ok") return
      throw new Error("Transcript cache request failed (404)")
    },

    async destroy() {
      // HTTP destroy must not wipe the user's SQLite cache.
    },
  }
}
