/**
 * Official OpenCode v2 session_message projection page.
 *
 * SDK gap: `@opencode-ai/sdk@1.18.4` is not the v2 authority, and
 * `@opencode/client` is not approved for this cut. GET goes through the
 * existing Host shallow proxy + `runtimeFetch`. Host must not interpret body.
 *
 * First paint: limit=20, order=desc. Older history uses the response cursor.
 */

import type { FilePart, Message, Part, ToolPart } from '@/lib/opencode/v2-types'

import { runtimeFetch } from "../lib/runtime-fetch"
import type { TranscriptTransportPage } from "./transcript-repository"

/** Official GUI first-paint page size. */
export const SESSION_PROJECTION_PAGE_LIMIT = 20

/** Official GUI first-paint / history order. */
export const SESSION_PROJECTION_PAGE_ORDER = "desc"

export const SESSION_COMPACTION_STATUSES = ["running", "completed", "failed"] as const
export type SessionCompactionStatus = (typeof SESSION_COMPACTION_STATUSES)[number]
export type SessionCompactionReason = "auto" | "manual"

export type SessionCompactionPart = {
  id: string
  sessionID: string
  messageID: string
  type: "compaction"
  status: SessionCompactionStatus
  reason: SessionCompactionReason
  summary?: string
  recent?: string
  error?: { type: string; message: string }
}

export function isSessionCompactionCard(part: unknown): part is SessionCompactionPart {
  if (!record(part)) return false
  if (part.type !== "compaction") return false
  return part.status === "running" || part.status === "completed" || part.status === "failed"
}

export function getSessionCompactionCard(
  parts: readonly unknown[] | undefined,
): SessionCompactionPart | undefined {
  if (!parts) return undefined
  return parts.find(isSessionCompactionCard)
}

export type FetchSessionProjectionPageInput = {
  sessionID: string
  directory: string
  cursor?: string
  signal?: AbortSignal
  limit?: number
  order?: "asc" | "desc"
}

const isJsonContentType = (value: string | null): boolean => {
  if (!value) return false
  return value.toLowerCase().includes("application/json")
}

const isHtmlContentType = (value: string | null): boolean => {
  if (!value) return false
  return value.toLowerCase().includes("text/html")
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

/**
 * Wire JSON object after a non-empty id is known.
 * Object spread of `Record<string, unknown>` otherwise collapses to `{ id: string }`.
 */
type SessionProjectionRecord = Record<string, unknown> & { id: string }

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function asProjectionRecord(value: unknown): SessionProjectionRecord | null {
  if (!record(value)) return null
  const id = asString(value.id)
  if (!id) return null
  return { ...value, id }
}

function partID(messageID: string, type: string, ordinal: number): string {
  return `${messageID}:${type}:${ordinal}`
}

function textPart(
  sessionID: string,
  messageID: string,
  ordinal: number,
  text: string,
  type: "text" | "reasoning" = "text",
  options?: { synthetic?: boolean },
): Part {
  if (type === "reasoning") {
    return {
      id: partID(messageID, type, ordinal),
      sessionID,
      messageID,
      type: "reasoning",
      text,
    }
  }
  return {
    id: partID(messageID, type, ordinal),
    sessionID,
    messageID,
    type: "text",
    text,
    ...(options?.synthetic === true ? { synthetic: true } : {}),
  }
}

/**
 * Official v2 synthetic / control rows project as user-shaped messages for the
 * existing Message+Part view model. Native kind lives on `nativeType`; text
 * parts carry `synthetic: true` so turn/recovery consumers share one rule.
 */
export function isNativeSyntheticMessage(info: Message | undefined): boolean {
  if (!info) return false
  const nativeType = (info as { nativeType?: unknown }).nativeType
  if (nativeType === "synthetic") return true
  const type = (info as { type?: unknown }).type
  return type === "synthetic"
}

/**
 * Authored user turn boundary: real user input, not native synthetic / shell /
 * control rows. Shared by projection turnCount, recovery anchors, and hydration.
 */
export function isAuthoredUserTurnRecord(
  info: Message | undefined,
  parts: readonly Part[] | undefined,
): boolean {
  if (!info?.id) return false
  if (isNativeSyntheticMessage(info)) return false
  const role = (info as { clientRole?: unknown; role?: unknown }).clientRole ?? info.role
  if (role !== "user") return false
  if (!Array.isArray(parts) || parts.length === 0) return true
  if (parts.some((part) => part.type === "subtask" || part.type === "compaction")) return false
  if (parts.every((part) => Boolean((part as { synthetic?: boolean }).synthetic))) return false
  return true
}

/** SDK / solid client: durable event id → message id (`evt_` → `msg_`). */
export function messageIDFromEventID(eventID: string | undefined): string | undefined {
  if (typeof eventID !== "string" || eventID.length === 0) return undefined
  return eventID.replace(/^evt_/, "msg_")
}

function toolOutput(state: Record<string, unknown>): string | undefined {
  const content = state.content
  if (!Array.isArray(content)) {
    return typeof state.output === "string" ? state.output : undefined
  }
  return content
    .flatMap((item) => (record(item) && item.type === "text" && typeof item.text === "string" ? [item.text] : []))
    .join("\n")
}

function toolPart(sessionID: string, messageID: string, tool: Record<string, unknown>): ToolPart {
  const id = asString(tool.id) ?? `${messageID}:tool`
  const name = asString(tool.name) ?? "tool"
  const state = record(tool.state) ? tool.state : {}
  const status = asString(state.status) ?? "completed"
  const mappedStatus = status === "streaming" ? "pending" : status
  return {
    id,
    sessionID,
    messageID,
    type: "tool",
    tool: name,
    callID: id,
    state: {
      status: mappedStatus,
      input: state.input ?? {},
      output: toolOutput(state),
      error: record(state.error) ? asString(state.error.message) : asString(state.error),
      metadata: record(state.metadata) ? state.metadata : {},
    },
  }
}

function messageTime(value: unknown): Message["time"] {
  if (!record(value)) return { created: 0 }
  return {
    created: typeof value.created === "number" ? value.created : 0,
    ...(typeof value.streamed === "number" ? { streamed: value.streamed } : {}),
    ...(typeof value.completed === "number" ? { completed: value.completed } : {}),
    ...(typeof value.start === "number" ? { start: value.start } : {}),
    ...(typeof value.end === "number" ? { end: value.end } : {}),
  }
}

/**
 * Map official TokenUsageInfo onto Message.tokens for TPS / settle chrome.
 * Partial records are kept when any recognized count is present.
 */
function projectionTokens(value: unknown): Message["tokens"] | undefined {
  if (!record(value)) return undefined
  const cache = record(value.cache)
    ? {
      ...(typeof value.cache.read === "number" ? { read: value.cache.read } : {}),
      ...(typeof value.cache.write === "number" ? { write: value.cache.write } : {}),
    }
    : undefined
  const tokens: NonNullable<Message["tokens"]> = {
    ...(typeof value.input === "number" ? { input: value.input } : {}),
    ...(typeof value.output === "number" ? { output: value.output } : {}),
    ...(typeof value.reasoning === "number" ? { reasoning: value.reasoning } : {}),
    ...(cache && (cache.read !== undefined || cache.write !== undefined) ? { cache } : {}),
  }
  return Object.keys(tokens).length > 0 ? tokens : undefined
}

function baseMessage(
  sessionID: string,
  item: SessionProjectionRecord,
  role: "user" | "assistant",
): Message {
  return {
    id: item.id,
    sessionID,
    role,
    time: messageTime(item.time),
  }
}

/**
 * Normalize one SessionMessage.Info into the existing Message+Part render model.
 * Unknown variants become a renderable placeholder; they must not drop the page.
 */
export function normalizeSessionProjectionMessage(
  sessionID: string,
  raw: unknown,
): { info: Message; parts: Part[] } | null {
  const item = asProjectionRecord(raw)
  if (!item) return null
  const id = item.id
  const type = asString(item.type) ?? "unknown"

  // 2.0.12 emits session-lifecycle / control rows in the message list. They are
  // not chat turns. Without this drop they land as empty Assistant headers
  // (deriveMessageRole defaults unknown roles to assistant; role:"idle" still
  // paints a non-user MessageHeader with no identity).
  const roleHint = asString(item.role) ?? asString(item.clientRole)
  if (
    type === "idle"
    || type === "model-switched"
    || type === "agent-selected"
    || type === "agent-switched"
    || type === "location-switched"
    || roleHint === "idle"
  ) {
    return null
  }

  if (type === "user") {
    const info = baseMessage(sessionID, item, "user")
    const parts: Part[] = []
    const text = asString(item.text)
    if (text) parts.push(textPart(sessionID, id, 0, text))
    const files = item.files
    if (Array.isArray(files)) {
      files.forEach((file: unknown, index: number) => {
        if (!record(file)) return
        const mime = asString(file.mime) ?? "application/octet-stream"
        const source = record(file.source) ? file.source : {}
        const uri = source.type === "uri" ? asString(source.uri) : undefined
        const data = asString(file.data)
        const url = uri ? uri : data ? `data:${mime};base64,${data}` : ""
        const part: FilePart = {
          id: `${id}:file:${index}`,
          sessionID,
          messageID: id,
          type: "file",
          mime,
          filename: asString(file.name),
          url,
        }
        parts.push(part)
      })
    }
    return { info, parts }
  }

  if (type === "assistant") {
    const info = baseMessage(sessionID, item, "assistant")
    if (record(item.model)) {
      // Wire uses model.id; domain Message.model uses modelID.
      info.modelID = asString(item.model.id) ?? asString(item.model.modelID) ?? asString(item.modelID)
      info.providerID = asString(item.model.providerID) ?? asString(item.providerID)
      const variant = asString(item.model.variant) ?? asString(item.variant)
      if (info.modelID || info.providerID || variant) {
        info.model = {
          ...(info.providerID ? { providerID: info.providerID } : {}),
          ...(info.modelID ? { modelID: info.modelID } : {}),
          ...(variant ? { variant } : {}),
        }
      }
    } else {
      // Top-level identity when model object is omitted.
      const modelID = asString(item.modelID)
      const providerID = asString(item.providerID)
      const variant = asString(item.variant)
      if (modelID) info.modelID = modelID
      if (providerID) info.providerID = providerID
      if (modelID || providerID || variant) {
        info.model = {
          ...(providerID ? { providerID } : {}),
          ...(modelID ? { modelID } : {}),
          ...(variant ? { variant } : {}),
        }
      }
    }
    const agent = asString(item.agent)
    if (agent) {
      info.agent = agent
    }
    // Failed turns (e.g. provider.auth 401) carry no content parts; keep
    // finish/error on the info so the transcript can still render the failure
    // instead of dropping it or inventing a successful empty assistant.
    const finish = asString(item.finish) ?? asString(item.rawFinish)
    if (finish) {
      info.finish = finish
    }
    if (record(item.error)) {
      info.error = {
        type: asString(item.error.type) ?? "error",
        message: asString(item.error.message) ?? "",
        ...(typeof item.error.status === "number" ? { status: item.error.status } : {}),
      }
    }
    // Official SessionMessage.Assistant carries usage for TPS / cost chrome.
    // Dropping these blanks assistant settle metadata after GET reconcile.
    if (typeof item.cost === "number" && Number.isFinite(item.cost)) {
      info.cost = item.cost
    }
    const tokens = projectionTokens(item.tokens)
    if (tokens) {
      info.tokens = tokens
    }
    const parts: Part[] = []
    const content: unknown[] = Array.isArray(item.content) ? item.content : []
    let textOrdinal = 0
    let reasoningOrdinal = 0
    for (const entry of content) {
      if (!record(entry)) continue
      const entryType = asString(entry.type)
      if (entryType === "text" && typeof entry.text === "string") {
        parts.push(textPart(sessionID, id, textOrdinal++, entry.text))
        continue
      }
      if (entryType === "reasoning" && typeof entry.text === "string") {
        parts.push(textPart(sessionID, id, reasoningOrdinal++, entry.text, "reasoning"))
        continue
      }
      if (entryType === "tool") {
        parts.push(toolPart(sessionID, id, entry))
      }
    }
    return { info, parts }
  }

  if (type === "shell") {
    const info = baseMessage(sessionID, item, "user")
    const command = asString(item.command) ?? ""
    const output = record(item.output) && typeof item.output.output === "string" ? item.output.output : ""
    const status = item.status === "running" ? "running"
      : item.status === "exited" && item.exit === 0 ? "completed" : "error"
    return {
      info,
      parts: [{
        id: partID(id, "text", 0), sessionID, messageID: id, type: "text", text: command,
        shellAction: { command, output, status, shellID: asString(item.shellID) },
      }],
    }
  }

  if (type === "synthetic") {
    // Preserve native synthetic identity for turn/recovery consumers while
    // keeping the existing user-shaped Message/Part view model.
    const info: Message = {
      ...baseMessage(sessionID, item, "user"),
      nativeType: "synthetic",
    }
    const description = asString(item.description)
    if (description) info.description = description
    if (record(item.metadata)) info.metadata = item.metadata
    // Shell / subagent association ids when present on the wire row.
    const shellID = asString(item.shellID)
    if (shellID) info.shellID = shellID
    const childSessionID = asString(item.sessionID) && item.sessionID !== sessionID
      ? asString(item.sessionID)
      : asString(item.childSessionID) ?? asString(item.taskSessionID)
    if (childSessionID) info.childSessionID = childSessionID
    const text = asString(item.text) ?? description ?? ""
    return {
      info,
      parts: text
        ? [textPart(sessionID, id, 0, text, "text", { synthetic: true })]
        : [{
          id: partID(id, "text", 0),
          sessionID,
          messageID: id,
          type: "text",
          text: "",
          synthetic: true,
        }],
    }
  }

  if (type === "system") {
    // System rows carry model instructions, including Code Mode catalog updates.
    // Keep them outside the shared transcript projection for every consumer.
    return null
  }

  if (type === "compaction") {
    const status: SessionCompactionStatus =
      item.status === "failed" ? "failed" : item.status === "completed" ? "completed" : "running"
    const info: Message = {
      ...baseMessage(sessionID, item, "assistant"),
      clientRole: "compaction",
    }
    const error = record(item.error)
      ? {
        type: asString(item.error.type) ?? "error",
        message: asString(item.error.message) ?? "",
      }
      : undefined
    const parts: Part[] = [{
      id: `${id}:compaction`,
      sessionID,
      messageID: id,
      type: "compaction",
      status,
      reason: item.reason === "auto" ? "auto" : "manual",
      ...(typeof item.summary === "string" ? { summary: item.summary } : {}),
      ...(typeof item.recent === "string" ? { recent: item.recent } : {}),
      ...(error ? { error } : {}),
    }]
    return { info, parts }
  }

  const info = baseMessage(sessionID, item, "assistant")
  const placeholder = asString(item.text) ?? `[${type}]`
  return { info, parts: [textPart(sessionID, id, 0, placeholder)] }
}

/**
 * Normalize a projection payload into transport records + cursor/complete.
 * `order=desc` pages are reversed so the existing window stays oldest→newest.
 */
export function normalizeSessionProjectionPage(
  payload: unknown,
  sessionID: string,
  order: "asc" | "desc" = SESSION_PROJECTION_PAGE_ORDER,
): TranscriptTransportPage {
  if (!record(payload)) {
    throw new Error("session projection: expected JSON object")
  }
  if (!Array.isArray(payload.data)) {
    throw new Error("session projection: data must be an array")
  }

  const records: TranscriptTransportPage["records"][number][] = []
  for (const item of payload.data) {
    const normalized = normalizeSessionProjectionMessage(sessionID, item)
    if (!normalized) continue
    records.push(normalized)
  }
  if (order === "desc") records.reverse()

  // OpenCode 2.x message.list cursor contract (client 2.0.12):
  // - order=desc first/older pages advance via `cursor.next`
  // - order=asc advances via `cursor.previous`
  // A bare string cursor is treated as the continuation token for either order.
  const cursorObject = record(payload.cursor) ? payload.cursor : undefined
  const continuation = cursorObject
    ? asString(order === "asc" ? cursorObject.previous : cursorObject.next)
    : asString(payload.cursor)
  const complete = !continuation
  const turnCount = records.filter((entry) => isAuthoredUserTurnRecord(entry.info, entry.parts)).length

  return {
    records,
    cursor: continuation,
    complete,
    turnCount,
  }
}

/**
 * GET `/api/session/:sessionID/message`
 * query: directory, limit, and either first-page order or an upstream cursor.
 */
export async function fetchSessionProjectionPage(
  input: FetchSessionProjectionPageInput,
): Promise<TranscriptTransportPage> {
  const limit = input.limit ?? SESSION_PROJECTION_PAGE_LIMIT
  const order = input.order ?? SESSION_PROJECTION_PAGE_ORDER
  const path = `/api/session/${encodeURIComponent(input.sessionID)}/message`
  const query: Record<string, string> = {
    directory: input.directory,
    limit: String(limit),
  }
  if (input.cursor) {
    query.cursor = input.cursor
  } else {
    query.order = order
  }

  const response = await runtimeFetch(path, {
    method: "GET",
    query,
    signal: input.signal,
  })

  if (!response.ok) {
    throw new Error(`session projection failed (${response.status})`)
  }

  const contentType = response.headers.get("content-type")
  if (isHtmlContentType(contentType)) {
    throw new Error("session projection: unexpected HTML response")
  }
  if (!isJsonContentType(contentType)) {
    // Still attempt JSON parse; many runtimes omit content-type. Reject HTML above.
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new Error("session projection: malformed JSON")
  }

  return normalizeSessionProjectionPage(payload, input.sessionID, order)
}

export type FetchSessionContextInput = {
  sessionID: string
  directory: string
  signal?: AbortSignal
}

/**
 * Normalize GET `/context` — messages after the last compaction checkpoint.
 * Context is already oldest → newest; do not reverse a desc projection page.
 */
export function normalizeSessionContextPage(
  payload: unknown,
  sessionID: string,
): TranscriptTransportPage {
  if (!record(payload)) {
    throw new Error("session context: expected JSON object")
  }
  if (!Array.isArray(payload.data)) {
    throw new Error("session context: data must be an array")
  }

  const records: TranscriptTransportPage["records"][number][] = []
  for (const item of payload.data) {
    const normalized = normalizeSessionProjectionMessage(sessionID, item)
    if (!normalized) continue
    records.push(normalized)
  }

  return {
    records,
    cursor: undefined,
    complete: false,
    turnCount: records.filter((entry) => isAuthoredUserTurnRecord(entry.info, entry.parts)).length,
  }
}

/**
 * GET `/api/session/:sessionID/context`
 * query: directory
 * Success is the post-checkpoint window. Failure must not become [].
 */
export async function fetchSessionContext(
  input: FetchSessionContextInput,
): Promise<TranscriptTransportPage> {
  const path = `/api/session/${encodeURIComponent(input.sessionID)}/context`
  const response = await runtimeFetch(path, {
    method: "GET",
    query: { directory: input.directory },
    signal: input.signal,
  })

  if (!response.ok) {
    throw new Error(`session context failed (${response.status})`)
  }

  const contentType = response.headers.get("content-type")
  if (isHtmlContentType(contentType)) {
    throw new Error("session context: unexpected HTML response")
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new Error("session context: malformed JSON")
  }

  return normalizeSessionContextPage(payload, input.sessionID)
}

export type ReconcileFetchedRecord = {
  info: Message
  parts: Part[]
}

export type ReconcileFetchedInput = {
  /** This GET page, already oldest → newest. */
  fetched: readonly ReconcileFetchedRecord[]
  /** Visible transcript before the GET settled. */
  previous: readonly ReconcileFetchedRecord[]
  /** Message ids SSE changed while this GET was in flight. */
  touched?: ReadonlySet<string>
  /**
   * True when the GET is the entire session (no older cursor).
   * Complete tails take the GET id set as authority; incomplete pages keep
   * earlier local rows the GET did not return.
   */
  completeTail: boolean
}

/**
 * Official GUI reconcileFetched: fetched is the base, touched ids keep the
 * local row, and an incomplete page keeps earlier unfetched rows.
 */
export function reconcileFetched(input: ReconcileFetchedInput): ReconcileFetchedRecord[] {
  const fetched = input.fetched.filter((record) => Boolean(record.info?.id))
  const previous = input.previous.filter((record) => Boolean(record.info?.id))
  const touched = input.touched ?? new Set<string>()
  const result = new Map(fetched.map((record) => [record.info.id, record]))
  const live = new Map(previous.map((record) => [record.info.id, record]))
  const fetchedIDs = new Set(fetched.map((record) => record.info.id))
  const firstFetchedIndex = previous.findIndex((record) => fetchedIDs.has(record.info.id))

  if (!input.completeTail) {
    for (const [index, record] of previous.entries()) {
      if (result.has(record.info.id)) continue
      const earlier = firstFetchedIndex === -1 || index < firstFetchedIndex
      if (earlier) result.set(record.info.id, record)
    }
  }

  for (const id of touched) {
    const item = live.get(id)
    if (item) result.set(id, item)
    else result.delete(id)
  }

  const order: string[] = []
  const seen = new Set<string>()
  for (const record of previous) {
    if (!result.has(record.info.id) || seen.has(record.info.id)) continue
    order.push(record.info.id)
    seen.add(record.info.id)
  }
  for (const record of fetched) {
    if (!result.has(record.info.id) || seen.has(record.info.id)) continue
    order.push(record.info.id)
    seen.add(record.info.id)
  }
  for (const id of result.keys()) {
    if (seen.has(id)) continue
    order.push(id)
  }
  return order.map((id) => result.get(id)!)
}
