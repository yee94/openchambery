/**
 * Official OpenCode v2 session compact + inbox barrier.
 *
 * SDK gap: `@opencode-ai/sdk@1.18.4` is not the v2 authority, and
 * `@opencode-ai/client` is not approved for this cut. POST goes through the
 * existing Host shallow proxy + `runtimeFetch`. Host must not interpret body.
 *
 * Compact: POST `/api/session/:sessionID/compact`. Success is an inbox
 * compaction item — follow `session.compaction.*` for the timeline card.
 * A running compaction is an inbox barrier: later queue items must not
 * promote until it ends.
 */

import { create } from "zustand"
import type { Message, Part } from '@/lib/opencode/v2-types'

import { runtimeFetch } from "../lib/runtime-fetch"
import {
  isSessionCompactionCard,
  type SessionCompactionPart,
  type SessionCompactionReason,
  type SessionCompactionStatus,
} from "./session-projection-api"

export type SessionInboxDelivery = "steer" | "queue"

export type SessionInboxCompaction = {
  id: string
  sessionID: string
  type: "compaction"
  delivery?: SessionInboxDelivery
  timeCreated?: number
}

export type PostSessionCompactInput = {
  sessionID: string
  directory: string
  messageID?: string
  delivery?: SessionInboxDelivery
  signal?: AbortSignal
}

export type CompactionLiveDraft = {
  message: Record<string, Message[]>
  part: Record<string, Part[]>
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

type SessionCompactionBarrierState = {
  runningBySession: Record<string, true>
  setRunning: (sessionID: string, running: boolean) => void
  isRunning: (sessionID: string) => boolean
  reset: () => void
}

export const useSessionCompactionBarrierStore = create<SessionCompactionBarrierState>((set, get) => ({
  runningBySession: {},
  setRunning(sessionID, running) {
    set((state) => {
      const next = { ...state.runningBySession }
      if (running) next[sessionID] = true
      else delete next[sessionID]
      return { runningBySession: next }
    })
  },
  isRunning(sessionID) {
    return get().runningBySession[sessionID] === true
  },
  reset() {
    set({ runningBySession: {} })
  },
}))

export function setSessionCompactionBarrier(sessionID: string, running: boolean): void {
  useSessionCompactionBarrierStore.getState().setRunning(sessionID, running)
}

export function isCompactionBarrierActive(sessionID: string): boolean {
  return useSessionCompactionBarrierStore.getState().isRunning(sessionID)
}

export function resetSessionCompactionBarrier(): void {
  useSessionCompactionBarrierStore.getState().reset()
}

export function canPromoteInboxItem(input: { sessionID: string }): boolean {
  return !isCompactionBarrierActive(input.sessionID)
}

export function parseSessionInboxCompaction(payload: unknown): SessionInboxCompaction {
  const root = record(payload) ? payload : null
  const item = root && record(root.data) ? root.data : root
  if (!item) {
    throw new Error("session compact: expected inbox item")
  }
  const id = asString(item.id)
  const sessionID = asString(item.sessionID)
  if (!id || !sessionID) {
    throw new Error("session compact: inbox item missing id")
  }
  if (item.type && item.type !== "compaction") {
    throw new Error("session compact: expected compaction inbox item")
  }
  return {
    id,
    sessionID,
    type: "compaction",
    delivery: item.delivery === "queue" ? "queue" : item.delivery === "steer" ? "steer" : undefined,
    timeCreated: asNumber(item.timeCreated),
  }
}

export function parseSessionInboxCompactionList(payload: unknown): SessionInboxCompaction[] {
  const root = record(payload) ? payload : null
  const list = root && Array.isArray(root.data) ? root.data : Array.isArray(payload) ? payload : null
  if (!list) {
    throw new Error("session inbox: expected list")
  }
  const items: SessionInboxCompaction[] = []
  for (const entry of list) {
    if (!record(entry) || entry.type !== "compaction") continue
    items.push(parseSessionInboxCompaction(entry))
  }
  return items
}

export function syncCompactionBarrierFromInbox(
  sessionID: string,
  items: readonly { type?: string }[],
): void {
  if (items.some((item) => item.type === "compaction")) {
    setSessionCompactionBarrier(sessionID, true)
  }
}

export function rememberCompactionBarrierFromRecords(
  sessionID: string,
  records: readonly { parts?: readonly unknown[] }[],
): void {
  const running = records.some((record) => {
    const card = (record.parts ?? []).find(isSessionCompactionCard)
    return card?.status === "running"
  })
  if (running) setSessionCompactionBarrier(sessionID, true)
}

export async function postSessionCompact(
  input: PostSessionCompactInput,
): Promise<SessionInboxCompaction> {
  const path = `/api/session/${encodeURIComponent(input.sessionID)}/compact`
  const body: Record<string, unknown> = {}
  if (input.messageID) body.id = input.messageID
  if (input.delivery) body.delivery = input.delivery

  const response = await runtimeFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    query: { directory: input.directory },
    body: JSON.stringify(body),
    signal: input.signal,
  })

  if (!response.ok) {
    throwHttp("session compact", response.status, await readFailedDetail(response))
  }

  const item = parseSessionInboxCompaction(await parseJsonBody(response, "session compact"))
  setSessionCompactionBarrier(item.sessionID, true)
  return item
}

const COMPACTION_OVERLAY_PREFIX = "compaction:"

export function compactionOverlayMessageID(sessionID: string, inputID?: string): string {
  return inputID && inputID.length > 0 ? inputID : `${COMPACTION_OVERLAY_PREFIX}${sessionID}`
}

function findCompactionMessageID(draft: CompactionLiveDraft, sessionID: string): string | undefined {
  const messages = draft.message[sessionID] ?? []
  for (const message of messages) {
    const parts = draft.part[message.id] ?? []
    if (parts.some(isSessionCompactionCard)) return message.id
  }
  const overlay = `${COMPACTION_OVERLAY_PREFIX}${sessionID}`
  if (messages.some((message) => message.id === overlay)) return overlay
  return undefined
}

function upsertCompactionCard(
  draft: CompactionLiveDraft,
  sessionID: string,
  messageID: string,
  update: (current: SessionCompactionPart) => SessionCompactionPart,
): void {
  const messages = draft.message[sessionID] ? [...draft.message[sessionID]!] : []
  if (!messages.some((message) => message.id === messageID)) {
    messages.push({
      id: messageID,
      sessionID,
      role: "assistant",
      clientRole: "compaction",
      time: { created: Date.now() },
    } as Message)
    draft.message[sessionID] = messages
  }
  const parts = draft.part[messageID] ? [...draft.part[messageID]!] : []
  const index = parts.findIndex(isSessionCompactionCard)
  const current = index >= 0
    ? parts[index] as SessionCompactionPart
    : {
      id: `${messageID}:compaction`,
      sessionID,
      messageID,
      type: "compaction" as const,
      status: "running" as SessionCompactionStatus,
      reason: "manual" as SessionCompactionReason,
    }
  const next = update(current)
  if (index >= 0) parts[index] = next as Part
  else parts.push(next as Part)
  draft.part[messageID] = parts
}

/**
 * Overlay official `session.compaction.*` events onto the Message+Part draft.
 * Deltas append summary on the compaction card; they are not assistant text.
 */
export function applySessionCompactionLiveEvent(
  draft: CompactionLiveDraft,
  event: { type?: string; properties?: unknown },
): boolean {
  const type = String(event.type ?? "")
  if (!type.startsWith("session.compaction.")) return false
  const props = record(event.properties) ? event.properties : null
  if (!props) return false
  const sessionID = asString(props.sessionID)
  if (!sessionID) return false

  const inputID = asString(props.inputID)
  const existingID = findCompactionMessageID(draft, sessionID)
  const messageID = existingID ?? compactionOverlayMessageID(sessionID, inputID)

  if (type === "session.compaction.started") {
    upsertCompactionCard(draft, sessionID, messageID, (current) => ({
      ...current,
      status: "running",
      reason: props.reason === "auto" ? "auto" : "manual",
      ...(typeof props.recent === "string" ? { recent: props.recent } : {}),
    }))
    setSessionCompactionBarrier(sessionID, true)
    return true
  }
  if (type === "session.compaction.delta") {
    const delta = typeof props.text === "string" ? props.text : ""
    if (!delta) return false
    upsertCompactionCard(draft, sessionID, messageID, (current) => ({
      ...current,
      status: "running",
      summary: (current.summary ?? "") + delta,
    }))
    setSessionCompactionBarrier(sessionID, true)
    return true
  }
  if (type === "session.compaction.ended") {
    upsertCompactionCard(draft, sessionID, messageID, (current) => ({
      ...current,
      status: "completed",
      summary: typeof props.text === "string" ? props.text : current.summary,
      ...(typeof props.recent === "string" ? { recent: props.recent } : {}),
    }))
    setSessionCompactionBarrier(sessionID, false)
    return true
  }
  if (type === "session.compaction.failed") {
    const error = record(props.error) ? props.error : {}
    upsertCompactionCard(draft, sessionID, messageID, (current) => ({
      ...current,
      status: "failed",
      error: {
        type: asString(error.type) ?? "error",
        message: asString(error.message) ?? "",
      },
    }))
    setSessionCompactionBarrier(sessionID, false)
    return true
  }
  return false
}
