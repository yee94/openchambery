/**
 * Host anchor-reconcile HTTP client (Ticket 07).
 *
 * GET /api/openchamber/sessions/:sessionID/messages/reconcile
 * with exactly one of `anchor` or `continuation`.
 *
 * - runtimeFetch + AbortSignal + independent timeout race
 * - Strict response validation (contract errors fail immediately)
 * - Retry: network / timeout / 502 / 503 / 504 up to 2 retries
 * - 4xx and contract errors fail immediately
 * - Never logs message bodies, parts, or auth material
 */

import type { Message, Part } from "@opencode-ai/sdk/v2/client"

import { runtimeFetch } from "../lib/runtime-fetch"
import {
  isRetryableSessionMessagePageError,
  SessionMessageHttpError,
  SessionMessagePageContractError,
  SessionMessageRuntimeStaleError,
} from "./session-message-query"
import { raceWithSessionTurnPageTimeout } from "./session-turn-page-api"

/** Independent bound for one reconcile HTTP flight (matches turn-page). */
const SESSION_TRANSCRIPT_RECONCILE_TIMEOUT_MS = 30_000

/** Max retries after the first attempt (network / 502 / 503 / 504). */
const SESSION_TRANSCRIPT_RECONCILE_MAX_RETRIES = 2

export type SessionTranscriptReconcileRecord = {
  readonly info: Message
  readonly parts?: readonly Part[]
}

/**
 * Host reconcile page response (Ticket 05 contract).
 * `complete` ends one compensation round only — never older-history exhaustion.
 */
export type SessionTranscriptReconcilePage = {
  readonly records: readonly SessionTranscriptReconcileRecord[]
  readonly anchorFound: boolean
  readonly capturedHeadMessageID: string | null
  readonly latestHeadMessageID: string | null
  readonly continuation: string | null
  readonly complete: boolean
  readonly resetRequired: boolean
  readonly scannedRecords: number
  readonly responseBytes: number
}

export type FetchSessionTranscriptReconcileInput = {
  readonly sessionID: string
  readonly directory: string
  /** Exactly one of anchor / continuation is required. */
  readonly anchor?: string
  readonly continuation?: string
  readonly signal?: AbortSignal
  /**
   * Independent timer-race bound (default {@link SESSION_TRANSCRIPT_RECONCILE_TIMEOUT_MS}).
   * Injectable for tests; production callers should omit this.
   */
  readonly timeoutMs?: number
  /**
   * Max retries after first attempt (default {@link SESSION_TRANSCRIPT_RECONCILE_MAX_RETRIES}).
   * Injectable for tests.
   */
  readonly maxRetries?: number
  /**
   * Optional sleep between retries (tests inject zero-delay).
   */
  readonly sleep?: (ms: number) => Promise<void>
}

const withTimeoutSignal = (signal: AbortSignal | undefined, timeoutMs: number): AbortSignal => {
  if (!signal) return AbortSignal.timeout(timeoutMs)
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
  }
  return signal
}

const isJsonContentType = (value: string | null): boolean => {
  if (!value) return false
  return value.toLowerCase().includes("application/json")
}

const isHtmlContentType = (value: string | null): boolean => {
  if (!value) return false
  return value.toLowerCase().includes("text/html")
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

function assertNullableMessageID(value: unknown, field: string): string | null {
  if (value == null) return null
  if (typeof value !== "string" || value.length === 0) {
    throw new SessionMessagePageContractError(
      `session transcript reconcile: ${field} must be string or null`,
    )
  }
  return value
}

/**
 * Strict Host reconcile response validation.
 * Throws SessionMessagePageContractError on shape violations.
 */
export function assertSessionTranscriptReconcilePage(
  payload: unknown,
): SessionTranscriptReconcilePage {
  if (!payload || typeof payload !== "object") {
    throw new SessionMessagePageContractError(
      "session transcript reconcile: expected JSON object",
    )
  }
  const body = payload as Record<string, unknown>

  if (!Array.isArray(body.records)) {
    throw new SessionMessagePageContractError(
      "session transcript reconcile: records must be an array",
    )
  }
  if (typeof body.anchorFound !== "boolean") {
    throw new SessionMessagePageContractError(
      "session transcript reconcile: anchorFound must be a boolean",
    )
  }
  if (typeof body.complete !== "boolean") {
    throw new SessionMessagePageContractError(
      "session transcript reconcile: complete must be a boolean",
    )
  }
  if (typeof body.resetRequired !== "boolean") {
    throw new SessionMessagePageContractError(
      "session transcript reconcile: resetRequired must be a boolean",
    )
  }
  if (
    typeof body.scannedRecords !== "number"
    || !Number.isFinite(body.scannedRecords)
    || !Number.isInteger(body.scannedRecords)
    || body.scannedRecords < 0
  ) {
    throw new SessionMessagePageContractError(
      "session transcript reconcile: scannedRecords must be a non-negative integer",
    )
  }
  if (
    typeof body.responseBytes !== "number"
    || !Number.isFinite(body.responseBytes)
    || !Number.isInteger(body.responseBytes)
    || body.responseBytes < 0
  ) {
    throw new SessionMessagePageContractError(
      "session transcript reconcile: responseBytes must be a non-negative integer",
    )
  }

  const capturedHeadMessageID = assertNullableMessageID(
    body.capturedHeadMessageID,
    "capturedHeadMessageID",
  )
  const latestHeadMessageID = assertNullableMessageID(
    body.latestHeadMessageID,
    "latestHeadMessageID",
  )
  const continuation = assertNullableMessageID(body.continuation, "continuation")

  if (body.complete === true && continuation != null) {
    throw new SessionMessagePageContractError(
      "session transcript reconcile: complete=true requires continuation=null",
    )
  }
  // Non-terminal incomplete pages must carry a non-empty continuation so the
  // client can continue the serial scan. Terminal rebuild responses use
  // resetRequired=true with complete=true instead.
  if (body.complete === false && body.resetRequired !== true && continuation == null) {
    throw new SessionMessagePageContractError(
      "session transcript reconcile: complete=false requires non-empty continuation",
    )
  }
  // Host promotes budget/miss rebuilds to a terminal page.
  if (body.resetRequired === true) {
    if (body.complete !== true) {
      throw new SessionMessagePageContractError(
        "session transcript reconcile: resetRequired=true requires complete=true",
      )
    }
    if (continuation != null) {
      throw new SessionMessagePageContractError(
        "session transcript reconcile: resetRequired=true requires continuation=null",
      )
    }
  }

  const records: SessionTranscriptReconcileRecord[] = []
  for (let i = 0; i < body.records.length; i += 1) {
    const entry = body.records[i]
    if (!entry || typeof entry !== "object") {
      throw new SessionMessagePageContractError(
        `session transcript reconcile: records[${i}] must be an object`,
      )
    }
    const record = entry as Record<string, unknown>
    const info = record.info
    if (!info || typeof info !== "object") {
      throw new SessionMessagePageContractError(
        `session transcript reconcile: records[${i}].info must be an object`,
      )
    }
    const id = (info as Record<string, unknown>).id
    if (typeof id !== "string" || id.length === 0) {
      throw new SessionMessagePageContractError(
        `session transcript reconcile: records[${i}].info.id must be a non-empty string`,
      )
    }
    if ("parts" in record && record.parts !== undefined && !Array.isArray(record.parts)) {
      throw new SessionMessagePageContractError(
        `session transcript reconcile: records[${i}].parts must be an array when present`,
      )
    }
    records.push({
      info: info as Message,
      ...(record.parts !== undefined ? { parts: record.parts as Part[] } : {}),
    })
  }

  return {
    records: Object.freeze(records) as readonly SessionTranscriptReconcileRecord[],
    anchorFound: body.anchorFound,
    capturedHeadMessageID,
    latestHeadMessageID,
    continuation,
    complete: body.complete,
    resetRequired: body.resetRequired,
    scannedRecords: body.scannedRecords,
    responseBytes: body.responseBytes,
  }
}

function validateReconcileParams(input: FetchSessionTranscriptReconcileInput): {
  anchor?: string
  continuation?: string
} {
  const anchor =
    typeof input.anchor === "string" && input.anchor.length > 0 ? input.anchor : undefined
  const continuation =
    typeof input.continuation === "string" && input.continuation.length > 0
      ? input.continuation
      : undefined
  if (Boolean(anchor) === Boolean(continuation)) {
    throw new SessionMessagePageContractError(
      "session transcript reconcile: provide exactly one of anchor or continuation",
    )
  }
  return { anchor, continuation }
}

async function fetchOnce(
  input: FetchSessionTranscriptReconcileInput,
  params: { anchor?: string; continuation?: string },
  timeoutMs: number,
): Promise<SessionTranscriptReconcilePage> {
  const path = `/api/openchamber/sessions/${encodeURIComponent(input.sessionID)}/messages/reconcile`
  const query: Record<string, string> = {
    directory: input.directory,
  }
  if (params.anchor) query.anchor = params.anchor
  if (params.continuation) query.continuation = params.continuation

  return raceWithSessionTurnPageTimeout(
    (async (): Promise<SessionTranscriptReconcilePage> => {
      let response: Response
      try {
        response = await runtimeFetch(path, {
          method: "GET",
          query,
          signal: withTimeoutSignal(input.signal, timeoutMs),
        })
      } catch (error) {
        if (error instanceof SessionMessageRuntimeStaleError) throw error
        if (error instanceof SessionMessagePageContractError) throw error
        if (error instanceof SessionMessageHttpError) throw error
        // Network / abort / timeout from fetch — surface as Error for retry class.
        throw error instanceof Error ? error : new Error(String(error))
      }

      if (!response.ok) {
        throw new SessionMessageHttpError(
          response.status,
          `session transcript reconcile failed (${response.status})`,
        )
      }

      const contentType = response.headers.get("content-type")
      if (isHtmlContentType(contentType)) {
        throw new SessionMessagePageContractError(
          "session transcript reconcile: unexpected HTML response",
        )
      }
      void isJsonContentType // content-type optional; many runtimes omit it

      let payload: unknown
      try {
        payload = await response.json()
      } catch {
        throw new SessionMessagePageContractError(
          "session transcript reconcile: malformed JSON",
        )
      }

      return assertSessionTranscriptReconcilePage(payload)
    })(),
    timeoutMs,
  )
}

/**
 * Fetch one Host reconcile page with classified retry.
 * Does not log request/response bodies or auth headers.
 */
export async function fetchSessionTranscriptReconcile(
  input: FetchSessionTranscriptReconcileInput,
): Promise<SessionTranscriptReconcilePage> {
  const params = validateReconcileParams(input)
  const timeoutMs =
    typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0
      ? input.timeoutMs
      : SESSION_TRANSCRIPT_RECONCILE_TIMEOUT_MS
  const maxRetries =
    typeof input.maxRetries === "number" && Number.isFinite(input.maxRetries)
      ? Math.max(0, Math.floor(input.maxRetries))
      : SESSION_TRANSCRIPT_RECONCILE_MAX_RETRIES
  const sleep = input.sleep ?? defaultSleep

  let attempt = 0
  // attempt 0 = first try; retries while attempt < maxRetries after a retryable failure
  for (;;) {
    if (input.signal?.aborted) {
      throw new DOMException("The operation was aborted.", "AbortError")
    }
    try {
      return await fetchOnce(input, params, timeoutMs)
    } catch (error) {
      if (error instanceof SessionMessageRuntimeStaleError) throw error
      if (error instanceof SessionMessagePageContractError) throw error
      if (error instanceof SessionMessageHttpError) {
        if (error.status >= 400 && error.status < 500) throw error
      }
      const name = error instanceof Error ? error.name : ""
      if (name === "AbortError" && input.signal?.aborted) throw error

      if (attempt >= maxRetries || !isRetryableSessionMessagePageError(error)) {
        throw error
      }
      attempt += 1
      const delayMs = Math.min(500 * 2 ** (attempt - 1), 4_000)
      await sleep(delayMs)
    }
  }
}
