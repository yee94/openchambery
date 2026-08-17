/**
 * Official OpenCode v2 idle prompt + interrupt.
 *
 * SDK gap: `@opencode-ai/sdk@1.18.4` is not the v2 authority, and
 * `@opencode-ai/client` is not approved for this cut. POST goes through the
 * existing Host shallow proxy + `runtimeFetch`. Host must not interpret body.
 *
 * Idle send: POST `/api/session/:sessionID/prompt` with `delivery: "steer"`.
 * Busy send: same path with `delivery: "queue"`. Success is an inbox item —
 * not a transcript row.
 * Inbox: GET `/inbox`, POST `/inbox/:id/steer|queue`, DELETE `/inbox/:id`.
 * Interrupt: POST `/api/session/:sessionID/interrupt`.
 */

import { runtimeFetch } from "../lib/runtime-fetch"
import {
  forgetUnpromotedInbox,
  replaceInboxOverlayFromAuthority as replaceOverlayFromAuthority,
  useSessionInboxOverlayStore,
} from "./session-inbox-overlay"
import {
  parseSessionInboxCompactionList,
  syncCompactionBarrierFromInbox,
} from "./session-compaction-api"

export type SessionInboxDelivery = "steer" | "queue"

export type SessionInboxUser = {
  id: string
  sessionID: string
  timeCreated: number
  type: "user"
  delivery: SessionInboxDelivery
  payload: {
    text: string
    files?: unknown
    agents?: unknown
    skills?: unknown
    metadata?: Record<string, unknown>
  }
}

export type PostIdleSessionPromptInput = {
  sessionID: string
  directory: string
  messageID: string
  text: string
  files?: Array<{ uri: string; name?: string }>
  agents?: Array<{ name: string }>
  skills?: Array<{ id: string }>
  metadata?: Record<string, unknown>
  signal?: AbortSignal
}

export type PostSessionPromptInput = PostIdleSessionPromptInput & {
  delivery?: SessionInboxDelivery
}

export type PostSessionInterruptInput = {
  sessionID: string
  directory?: string | null
  signal?: AbortSignal
}

export type SessionInboxMutationInput = {
  sessionID: string
  inboxID: string
  directory?: string | null
  signal?: AbortSignal
}

export type FetchSessionInboxInput = {
  sessionID: string
  directory?: string | null
  signal?: AbortSignal
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

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function throwHttp(label: string, status: number, detail?: string): never {
  const suffix = detail ? `: ${detail}` : ""
  const error = new Error(`${label} (${status})${suffix}`) as Error & { status?: number }
  error.status = status
  throw error
}

async function readFailedDetail(response: Response): Promise<string> {
  try {
    return (await response.text()).trim()
  } catch {
    return ""
  }
}

function directoryQuery(directory?: string | null): Record<string, string> {
  return directory ? { directory } : {}
}

function inboxPath(sessionID: string, inboxID?: string, action?: "steer" | "queue"): string {
  const session = `/api/session/${encodeURIComponent(sessionID)}/inbox`
  if (!inboxID) return session
  const item = `${session}/${encodeURIComponent(inboxID)}`
  return action ? `${item}/${action}` : item
}

async function parseJsonBody(response: Response, label: string): Promise<unknown> {
  const contentType = response.headers.get("content-type")
  if (isHtmlContentType(contentType)) {
    throw new Error(`${label}: unexpected HTML response`)
  }
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new Error(`${label}: malformed JSON`)
  }
  if (!isJsonContentType(contentType) && payload == null) {
    throw new Error(`${label}: empty response`)
  }
  return payload
}

export function parseSessionInboxUser(payload: unknown): SessionInboxUser {
  const root = record(payload) ? payload : null
  const item = root && record(root.data) ? root.data : root
  if (!item) {
    throw new Error("session prompt: expected inbox item")
  }
  const id = asString(item.id)
  const sessionID = asString(item.sessionID)
  if (!id || !sessionID) {
    throw new Error("session prompt: inbox item missing id")
  }
  const payloadRecord = record(item.payload) ? item.payload : {}
  const delivery = item.delivery === "queue" ? "queue" : "steer"
  return {
    id,
    sessionID,
    timeCreated: asNumber(item.timeCreated) ?? Date.now(),
    type: "user",
    delivery,
    payload: {
      text: asString(payloadRecord.text) ?? asString(item.text) ?? "",
      ...(payloadRecord.files !== undefined ? { files: payloadRecord.files } : {}),
      ...(payloadRecord.agents !== undefined ? { agents: payloadRecord.agents } : {}),
      ...(payloadRecord.skills !== undefined ? { skills: payloadRecord.skills } : {}),
      ...(record(payloadRecord.metadata) ? { metadata: payloadRecord.metadata } : {}),
    },
  }
}

export function parseSessionInboxList(payload: unknown): SessionInboxUser[] {
  const root = record(payload) ? payload : null
  const list = root && Array.isArray(root.data) ? root.data : Array.isArray(payload) ? payload : null
  if (!list) {
    throw new Error("session inbox: expected list")
  }
  const items: SessionInboxUser[] = []
  for (const entry of list) {
    if (!record(entry)) continue
    if (entry.type && entry.type !== "user") continue
    items.push(parseSessionInboxUser(entry))
  }
  return items
}

/**
 * Unpromoted inbox items are not transcript rows. Callers show them near the
 * composer; promote + projection owns the user line.
 */
export function transcriptRowsFromIdlePromptResponse(_payload: unknown): [] {
  return []
}

export async function postSessionPrompt(
  input: PostSessionPromptInput,
): Promise<SessionInboxUser> {
  const path = `/api/session/${encodeURIComponent(input.sessionID)}/prompt`
  const body: Record<string, unknown> = {
    id: input.messageID,
    text: input.text,
    delivery: input.delivery === "queue" ? "queue" : "steer",
  }
  if (input.files?.length) body.files = input.files
  if (input.agents?.length) body.agents = input.agents
  if (input.skills?.length) body.skills = input.skills
  if (input.metadata) body.metadata = input.metadata

  const response = await runtimeFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    query: { directory: input.directory },
    body: JSON.stringify(body),
    signal: input.signal,
  })

  if (!response.ok) {
    const detail = await readFailedDetail(response)
    throwHttp("Failed to send message", response.status, detail)
  }

  return parseSessionInboxUser(await parseJsonBody(response, "session prompt"))
}

export async function postIdleSessionPrompt(
  input: PostIdleSessionPromptInput,
): Promise<SessionInboxUser> {
  return postSessionPrompt({ ...input, delivery: "steer" })
}

export async function fetchSessionInbox(input: FetchSessionInboxInput): Promise<SessionInboxUser[]> {
  const response = await runtimeFetch(inboxPath(input.sessionID), {
    method: "GET",
    query: directoryQuery(input.directory),
    signal: input.signal,
  })
  if (!response.ok) {
    throwHttp("session inbox", response.status, await readFailedDetail(response))
  }
  const payload = await parseJsonBody(response, "session inbox")
  const users = parseSessionInboxList(payload)
  syncCompactionBarrierFromInbox(input.sessionID, parseSessionInboxCompactionList(payload))
  return users
}

export async function steerSessionInbox(input: SessionInboxMutationInput): Promise<SessionInboxUser> {
  const response = await runtimeFetch(inboxPath(input.sessionID, input.inboxID, "steer"), {
    method: "POST",
    query: directoryQuery(input.directory),
    signal: input.signal,
  })
  if (!response.ok) {
    throwHttp("session inbox steer", response.status, await readFailedDetail(response))
  }
  return parseSessionInboxUser(await parseJsonBody(response, "session inbox steer"))
}

export async function queueSessionInbox(input: SessionInboxMutationInput): Promise<SessionInboxUser> {
  const response = await runtimeFetch(inboxPath(input.sessionID, input.inboxID, "queue"), {
    method: "POST",
    query: directoryQuery(input.directory),
    signal: input.signal,
  })
  if (!response.ok) {
    throwHttp("session inbox queue", response.status, await readFailedDetail(response))
  }
  return parseSessionInboxUser(await parseJsonBody(response, "session inbox queue"))
}

export async function cancelSessionInbox(input: SessionInboxMutationInput): Promise<void> {
  const response = await runtimeFetch(inboxPath(input.sessionID, input.inboxID), {
    method: "DELETE",
    query: directoryQuery(input.directory),
    signal: input.signal,
  })
  if (!response.ok) {
    throwHttp("session inbox cancel", response.status, await readFailedDetail(response))
  }
}

export function replaceInboxOverlayFromAuthority(
  sessionID: string,
  items: readonly SessionInboxUser[],
): void {
  replaceOverlayFromAuthority(sessionID, items)
}

export async function cancelUnpromotedInboxItem(input: SessionInboxMutationInput): Promise<{
  overlay: SessionInboxUser[]
  transcriptRows: []
}> {
  await cancelSessionInbox(input)
  forgetUnpromotedInbox(input.sessionID, input.inboxID)
  try {
    const remaining = await fetchSessionInbox({
      sessionID: input.sessionID,
      directory: input.directory,
      signal: input.signal,
    })
    replaceInboxOverlayFromAuthority(input.sessionID, remaining)
  } catch {
    // DELETE already won; a refresh miss must not resurrect the cancelled item.
  }
  return {
    overlay: useSessionInboxOverlayStore.getState().list(input.sessionID),
    transcriptRows: [],
  }
}

export async function postSessionInterrupt(input: PostSessionInterruptInput): Promise<void> {
  const path = `/api/session/${encodeURIComponent(input.sessionID)}/interrupt`
  const query: Record<string, string> = {}
  if (input.directory) query.directory = input.directory

  const response = await runtimeFetch(path, {
    method: "POST",
    query,
    signal: input.signal,
  })

  if (!response.ok) {
    throw new Error(`Session interrupt failed (${response.status})`)
  }
}

export type ConfirmOptimisticAgainstPromotedInput = {
  optimisticID: string
  promotedIDs: readonly string[]
  removeOptimistic: (id: string) => void
  refreshFromAuthority: () => Promise<void>
}

/**
 * After promote, the projection user row must share the optimistic id.
 * A miss drops the optimistic shell and force-GETs the tail.
 */
export async function confirmOptimisticAgainstPromoted(
  input: ConfirmOptimisticAgainstPromotedInput,
): Promise<"confirmed" | "refreshed"> {
  if (input.promotedIDs.includes(input.optimisticID)) {
    return "confirmed"
  }
  input.removeOptimistic(input.optimisticID)
  await input.refreshFromAuthority()
  return "refreshed"
}
