/**
 * OpenChamber Host turn-page API for session message windows.
 *
 * Used for initial/recovery/materialize tails (no `before`) and for
 * prepend/loadMore (`before` + purpose prepend). One Host request returns up
 * to `turns` authored user boundaries.
 *
 * Upstream OpenCode message `scanLimit` is a **Host-local** concern (server
 * calls OpenCode on loopback). Clients omit it by default; the Host applies
 * `_inner_scanLimit` (env `OPENCHAMBER_SESSION_TURN_SCAN_LIMIT` or 100).
 * Optional `scanLimit` remains an explicit client override only.
 */

import type { Message, Part } from "@opencode-ai/sdk/v2/client"

import { runtimeFetch } from "../lib/runtime-fetch"
import {
  getHistorySessionTurnLimit,
  getInitialSessionTurnLimit,
} from "./session-message-policy"

/** Default Host turn budget for prepend (desktop history window). */
export const SESSION_TURN_PAGE_TURNS = 3

/**
 * Bound a single Host turn-page HTTP flight. Over the Relay tunnel a stuck
 * upstream `session.messages` scan otherwise leaves the request pending
 * forever: prefetch status stays `loading`, the mobile "load older" button
 * spins, and the page never settles. Timeout is retryable (transient), and a
 * final failure settles prefetch as `error` so the UI can recover.
 */
const SESSION_TURN_PAGE_TIMEOUT_MS = 30_000

const withTimeoutSignal = (signal: AbortSignal | undefined, timeoutMs: number): AbortSignal => {
  if (!signal) return AbortSignal.timeout(timeoutMs)
  // Caller signal wins for cancellation; timeout only bounds the flight.
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
  }
  return signal
}

export type SessionTurnPageRecord = {
  info: Message
  parts?: Part[]
}

export type SessionTurnPage = {
  records: SessionTurnPageRecord[]
  cursor: string | null
  complete: boolean
  turnCount: number
}

export type FetchSessionTurnPageInput = {
  sessionID: string
  directory: string
  before?: string
  signal?: AbortSignal
  turns?: number
  /**
   * Optional override for Host→OpenCode message page size.
   * Default path must omit this so the server uses `_inner_scanLimit`.
   */
  scanLimit?: number
}

const isJsonContentType = (value: string | null): boolean => {
  if (!value) return false
  return value.toLowerCase().includes("application/json")
}

const isHtmlContentType = (value: string | null): boolean => {
  if (!value) return false
  return value.toLowerCase().includes("text/html")
}

function assertSessionTurnPage(payload: unknown, requestedTurns: number): SessionTurnPage {
  if (!payload || typeof payload !== "object") {
    throw new Error("session turn page: expected JSON object")
  }
  const body = payload as Record<string, unknown>
  if (body.partial === true) {
    throw new Error("session turn page: partial responses are not accepted")
  }
  if (!Array.isArray(body.records)) {
    throw new Error("session turn page: records must be an array")
  }
  if (!("complete" in body) || typeof body.complete !== "boolean") {
    throw new Error("session turn page: complete must be a boolean")
  }
  if (typeof body.turnCount !== "number" || !Number.isFinite(body.turnCount)) {
    throw new Error("session turn page: turnCount must be a number")
  }
  if (!Number.isInteger(body.turnCount) || body.turnCount < 0 || body.turnCount > requestedTurns) {
    throw new Error(
      `session turn page: turnCount must be an integer in 0..${requestedTurns}`,
    )
  }
  if (body.cursor != null && typeof body.cursor !== "string") {
    throw new Error("session turn page: cursor must be string or null")
  }
  if (typeof body.cursor === "string" && body.cursor.length === 0) {
    throw new Error("session turn page: cursor must not be empty string")
  }
  if (body.complete === true && body.cursor != null) {
    throw new Error("session turn page: complete=true requires cursor=null")
  }
  if (body.complete === false && (body.cursor == null || typeof body.cursor !== "string")) {
    throw new Error("session turn page: complete=false requires non-empty cursor")
  }

  const records: SessionTurnPageRecord[] = []
  for (let i = 0; i < body.records.length; i++) {
    const entry = body.records[i]
    if (!entry || typeof entry !== "object") {
      throw new Error(`session turn page: records[${i}] must be an object`)
    }
    const record = entry as Record<string, unknown>
    const info = record.info
    if (!info || typeof info !== "object") {
      throw new Error(`session turn page: records[${i}].info must be an object`)
    }
    const id = (info as Record<string, unknown>).id
    if (typeof id !== "string" || id.length === 0) {
      throw new Error(`session turn page: records[${i}].info.id must be a non-empty string`)
    }
    if ("parts" in record && record.parts !== undefined && !Array.isArray(record.parts)) {
      throw new Error(`session turn page: records[${i}].parts must be an array when present`)
    }
    records.push({
      info: info as Message,
      ...(record.parts !== undefined ? { parts: record.parts as Part[] } : {}),
    })
  }

  return {
    records,
    cursor: body.cursor == null ? null : (body.cursor as string),
    complete: body.complete,
    turnCount: body.turnCount,
  }
}

/**
 * GET `/api/openchamber/sessions/:sessionID/messages`
 * query: directory, turns, before?, scanLimit? (optional override only)
 */
export async function fetchSessionTurnPage(
  input: FetchSessionTurnPageInput,
): Promise<SessionTurnPage> {
  const turns = input.turns ?? getHistorySessionTurnLimit()
  const path = `/api/openchamber/sessions/${encodeURIComponent(input.sessionID)}/messages`
  const query: Record<string, string> = {
    directory: input.directory,
    turns: String(turns),
  }
  if (input.before) {
    query.before = input.before
  }
  // Host-local OpenCode scan chunk: omit by default (server `_inner_scanLimit`).
  // Only send when the caller explicitly overrides.
  if (typeof input.scanLimit === "number" && Number.isFinite(input.scanLimit)) {
    query.scanLimit = String(Math.floor(input.scanLimit))
  }

  const response = await runtimeFetch(path, {
    method: "GET",
    query,
    signal: withTimeoutSignal(input.signal, SESSION_TURN_PAGE_TIMEOUT_MS),
  })

  if (!response.ok) {
    throw new Error(`session turn page failed (${response.status})`)
  }

  const contentType = response.headers.get("content-type")
  if (isHtmlContentType(contentType)) {
    throw new Error("session turn page: unexpected HTML response")
  }
  if (!isJsonContentType(contentType)) {
    // Still attempt JSON parse; many runtimes omit content-type. Reject HTML above.
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new Error("session turn page: malformed JSON")
  }

  return assertSessionTurnPage(payload, turns)
}

/**
 * Purpose-aware Host turn window for tail (initial/recovery/materialize) and
 * prepend history. Callers map records into the sync store; this function only
 * owns the HTTP contract.
 */
export async function fetchHostSessionTurnPageForPurpose(input: {
  sessionID: string
  directory: string
  purpose: "initial" | "prepend" | "recovery" | "materialize"
  before?: string
  signal?: AbortSignal
}): Promise<SessionTurnPage> {
  const isHistory = input.purpose === "prepend" && Boolean(input.before)
  const turns = isHistory ? getHistorySessionTurnLimit() : getInitialSessionTurnLimit()
  // Never pass scanLimit here — Host owns `_inner_scanLimit` for local OpenCode.
  return fetchSessionTurnPage({
    sessionID: input.sessionID,
    directory: input.directory,
    turns,
    ...(input.before ? { before: input.before } : {}),
    signal: input.signal,
  })
}
